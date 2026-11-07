"""A small CoAP client (RFC 7252) for the device's resources: 'info', 'data', 'ping', 'diag' and 'log'.

Only what the devices need: GET and PUT, confirmable requests with retransmission,
piggybacked or separate responses. Timeouts are long because a sleepy device only
receives a message when it polls its parent (every 3 s by default).
"""

import asyncio
import os
import random
import socket
import struct
from dataclasses import dataclass

COAP_PORT = 5683

TYPE_CON, TYPE_NON, TYPE_ACK, TYPE_RST = 0, 1, 2, 3
GET, POST, PUT, DELETE = 1, 2, 3, 4
METHODS = {"GET": GET, "POST": POST, "PUT": PUT, "DELETE": DELETE}
CHANGED, CONTENT, NOT_FOUND = 0x44, 0x45, 0x84

# Response codes, in words (RFC 7252, 12.1.2)
CODE_NAMES = {
    0x41: "Created", 0x42: "Deleted", 0x43: "Valid", 0x44: "Changed", 0x45: "Content",
    0x80: "Bad Request", 0x81: "Unauthorized", 0x82: "Bad Option", 0x83: "Forbidden", 0x84: "Not Found",
    0x85: "Method Not Allowed", 0x86: "Not Acceptable", 0x8C: "Precondition Failed",
    0x8D: "Request Entity Too Large", 0x8F: "Unsupported Content-Format",
    0xA0: "Internal Server Error", 0xA1: "Not Implemented", 0xA2: "Bad Gateway", 0xA3: "Service Unavailable",
    0xA4: "Gateway Timeout", 0xA5: "Proxying Not Supported",
}

# The board's resources (application/src/coap_resources.c), for the app's CoAP tab
RESOURCES = [
    {"path": "data", "methods": ["GET"], "about": "The latest readings: soil, battery, air humidity (%), temperature (°C, signed)"},
    {"path": "info", "methods": ["GET"], "about": "Firmware (git commit), hardware version and device ID"},
    {"path": "diag", "methods": ["GET"], "about": "Restarts, crashes, the link to its parent, the soil sensor's output, its power (newer firmware)"},
    {"path": "log", "methods": ["GET"], "about": "Its log since the given offset (query from=<n>; firmware built with Log over the air)",
     "query": "from=0"},
    {"path": "pump", "methods": ["GET", "PUT"], "about": "1 while the pump runs. PUT 1 runs it (for its run time), 0 stops it",
     "values": ["1", "0"]},
    {"path": "pumpdc", "methods": ["GET", "PUT"], "about": "The pump's run time in seconds. PUT one digit, 1 to 9: kept across restarts",
     "values": ["1", "2", "3", "5", "9"]},
    {"path": "ping", "methods": ["PUT"], "about": "Answers 2.04 Changed; 1 beeps, 0 doesn't. Confirmable or not",
     "values": ["1", "0"], "non": True},
]
OPTION_URI_PATH, OPTION_URI_QUERY = 11, 15

ACK_TIMEOUT_S = 4.0  # longer than the device's poll period
MAX_RETRANSMIT = 2


class CoapError(Exception):
    pass


class NoLog(CoapError):
    """The device keeps no log over the air (firmware built without HACOAP_REMOTE_LOG)."""


@dataclass
class DeviceInfo:
    fw_version: str  # git commit the firmware was built from
    hw_version: str
    device_id: str


@dataclass
class SensorData:
    soil_moisture: int  # %
    battery: int        # %
    air_humidity: int   # %
    temperature: int    # degC


def code_name(code):
    return f"{code >> 5}.{code & 0x1F:02d}"


def _option(delta, value):
    def nibble(n):
        if n < 13:
            return n, b""
        if n < 269:
            return 13, bytes([n - 13])
        return 14, struct.pack(">H", n - 269)

    delta_nibble, delta_ext = nibble(delta)
    length_nibble, length_ext = nibble(len(value))
    return bytes([(delta_nibble << 4) | length_nibble]) + delta_ext + length_ext + value


def encode(msg_type, code, message_id, token, path="", payload=b"", query=()):
    data = bytes([0x40 | (msg_type << 4) | len(token), code]) + struct.pack(">H", message_id) + token
    last = 0
    for segment in [s for s in path.split("/") if s]:
        data += _option(OPTION_URI_PATH - last, segment.encode())
        last = OPTION_URI_PATH
    for item in query:
        data += _option(OPTION_URI_QUERY - last, item.encode())
        last = OPTION_URI_QUERY
    if payload:
        data += b"\xff" + payload
    return data


@dataclass
class Message:
    type: int
    code: int
    message_id: int
    token: bytes
    path: str
    payload: bytes
    query: tuple = ()


def decode(data):
    """Parses a CoAP message. Raises CoapError if it is malformed."""
    if len(data) < 4 or (data[0] >> 6) != 1:
        raise CoapError("not a CoAP message")
    msg_type = (data[0] >> 4) & 0x3
    token_length = data[0] & 0xF
    code = data[1]
    message_id, = struct.unpack_from(">H", data, 2)
    if token_length > 8 or len(data) < 4 + token_length:
        raise CoapError("bad token")
    token = data[4:4 + token_length]
    i = 4 + token_length
    number = 0
    segments = []
    query = []
    payload = b""
    while i < len(data):
        if data[i] == 0xFF:
            payload = data[i + 1:]
            break
        delta, length = data[i] >> 4, data[i] & 0xF
        i += 1
        values = []
        for n in (delta, length):
            if n == 13:
                values.append(data[i] + 13)
                i += 1
            elif n == 14:
                values.append(struct.unpack_from(">H", data, i)[0] + 269)
                i += 2
            elif n == 15:
                raise CoapError("bad option")
            else:
                values.append(n)
        number += values[0]
        value = data[i:i + values[1]]
        i += values[1]
        if number == OPTION_URI_PATH:
            segments.append(value.decode(errors="replace"))
        elif number == OPTION_URI_QUERY:
            query.append(value.decode(errors="replace"))
    return Message(msg_type, code, message_id, token, "/".join(segments), payload, tuple(query))


class _Protocol(asyncio.DatagramProtocol):
    def __init__(self):
        self.queue = asyncio.Queue()
        self.transport = None

    def connection_made(self, transport):
        self.transport = transport

    def datagram_received(self, data, addr):
        self.queue.put_nowait(data)

    def error_received(self, exc):
        self.queue.put_nowait(exc)


async def request(host, path, method=GET, payload=b"", *, port=COAP_PORT, query=(),
                  ack_timeout=ACK_TIMEOUT_S, max_retransmit=MAX_RETRANSMIT, timeout=None, confirmable=True):
    """Sends a request (confirmable unless asked otherwise) and returns (code, payload) of the
    response. A non-confirmable one is sent once.

    Raises CoapError on a reset, and TimeoutError without an answer.
    """
    loop = asyncio.get_running_loop()
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    transport, protocol = await loop.create_datagram_endpoint(_Protocol, remote_addr=(host, port), family=family)
    message_id = random.randrange(0x10000)
    token = os.urandom(4)
    data = encode(TYPE_CON if confirmable else TYPE_NON, method, message_id, token, path, payload, query)
    if not confirmable:
        max_retransmit = 0
    if timeout is None:
        timeout = ack_timeout * (2 ** (max_retransmit + 1) - 1)
    deadline = loop.time() + timeout
    acknowledged = False
    try:
        wait = ack_timeout
        transport.sendto(data)
        retransmits = 0
        next_send = loop.time() + wait
        while True:
            now = loop.time()
            if now >= deadline:
                raise TimeoutError(f"no CoAP response from {host} for '{path}'")
            limit = deadline if acknowledged else min(deadline, next_send)
            try:
                item = await asyncio.wait_for(protocol.queue.get(), max(0.0, limit - now))
            except asyncio.TimeoutError:
                if not acknowledged and retransmits < max_retransmit and loop.time() < deadline:
                    retransmits += 1
                    wait *= 2
                    transport.sendto(data)
                    next_send = loop.time() + wait
                continue
            if isinstance(item, Exception):
                raise CoapError(f"{host}: {item}")
            try:
                message = decode(item)
            except CoapError:
                continue
            if message.type == TYPE_RST and message.message_id == message_id:
                raise CoapError(f"{host} reset the request for '{path}'")
            if message.type == TYPE_ACK and message.message_id == message_id:
                if message.code == 0:
                    acknowledged = True  # empty ACK: the response comes separately
                    continue
                if message.token == token:
                    return message.code, message.payload
            if message.token == token and message.type in (TYPE_CON, TYPE_NON) and message.code >= 0x40:
                if message.type == TYPE_CON:
                    transport.sendto(encode(TYPE_ACK, 0, message.message_id, b""))
                return message.code, message.payload
    finally:
        transport.close()


def parse_info(payload):
    parts = payload.rstrip(b"\0").decode("ascii", errors="replace").split(",")
    if len(parts) != 3:
        raise CoapError(f"unexpected 'info' payload: {payload!r}")
    return DeviceInfo(*[p.strip() for p in parts])


def parse_data(payload):
    if len(payload) < 4:
        raise CoapError(f"unexpected 'data' payload: {payload!r}")
    temperature = payload[3] - 256 if payload[3] > 127 else payload[3]  # signed byte
    return SensorData(payload[0], payload[1], payload[2], temperature)


async def _get(host, path, **kwargs):
    code, payload = await request(host, path, GET, **kwargs)
    if code != CONTENT:
        raise CoapError(f"'{path}' answered {code_name(code)}")
    return payload


async def get_info(host, **kwargs):
    return parse_info(await _get(host, "info", **kwargs))


async def get_data(host, **kwargs):
    return parse_data(await _get(host, "data", **kwargs))


async def set_pump(host, on, **kwargs):
    """Starts ('1') or stops ('0') the pump. Returns whether it's running."""
    code, payload = await request(host, "pump", PUT, b"1" if on else b"0", **kwargs)
    if code != CONTENT or not payload:
        raise CoapError(f"'pump' answered {code_name(code)}")
    return payload[0] == 1


async def get_pump(host, **kwargs):
    payload = await _get(host, "pump", **kwargs)
    return bool(payload) and payload[0] == 1


async def set_pump_duration(host, seconds, **kwargs):
    """Sets the pump run time (1 to 9 s). Returns the run time the device now uses."""
    if not 0 <= seconds <= 9:
        raise ValueError("the run time is one digit, 1 to 9 s")
    code, payload = await request(host, "pumpdc", PUT, str(seconds).encode(), **kwargs)
    if code != CONTENT or not payload:
        raise CoapError(f"'pumpdc' answered {code_name(code)}")
    return payload[0]


async def get_pump_duration(host, **kwargs):
    payload = await _get(host, "pumpdc", **kwargs)
    return payload[0] if payload else None


async def ping(host, beep=True, **kwargs):
    code, _ = await request(host, "ping", PUT, b"1" if beep else b"0", **kwargs)
    if code != CHANGED:
        raise CoapError(f"'ping' answered {code_name(code)}")


LOG_PAYLOAD_MAX = 512  # LOG_PAYLOAD_MAX_SIZE in application/include/coap_resources.h


@dataclass
class LogChunk:
    boot_id: str  # new at every boot of the device
    start: int    # offset of the first byte of 'text' in the device's log since boot
    text: bytes
    full: bool = False  # the answer was as long as it can be: there's probably more to read


def parse_log(payload):
    """The 'log' payload: "<boot id> <start>\\n<text>" (application/include/log_buffer.h)."""
    header, newline, text = payload.partition(b"\n")
    parts = header.decode("ascii", errors="replace").split()
    if not newline or len(parts) != 2 or not parts[1].isdigit():
        raise CoapError(f"unexpected 'log' payload: {payload[:40]!r}")
    return LogChunk(parts[0], int(parts[1]), text, len(payload) >= LOG_PAYLOAD_MAX)


async def get_log(host, offset=0, **kwargs):
    """The device's log from byte 'offset' on (as much as fits in one answer). Raises NoLog
    when its firmware keeps no log over the air."""
    code, payload = await request(host, "log", GET, query=(f"from={offset}",), **kwargs)
    if code == NOT_FOUND:
        raise NoLog("this board's firmware keeps no log over the air")
    if code != CONTENT:
        raise CoapError(f"'log' answered {code_name(code)}")
    return parse_log(payload)


@dataclass
class Diagnostics:
    """The 'diag' payload (application/include/diag.h)."""
    boots: int            # boots since the board's flash was erased
    uptime_s: int
    reset: str            # why it last restarted: power, pin, soft, watchdog, lockup, crash, other
    fault: str            # after a crash: "<reason>@<address>", else ""
    role: str             # disabled, detached, child, router, leader
    srp: str              # its name's registration: registered, pending, failed, off ("" before this field)
    rloc16: str           # "0x5c01", or "" when not attached
    parent: str
    rssi: int | None      # the parent's average RSSI (dBm)
    last_rssi: int | None
    link_quality: int | None
    soil_mv: int | None   # the soil sensor's latest output, or None when it wasn't read
    power: str = ""        # battery, usb, charging or charged ("" before this field)


def parse_diag(payload):
    fields = {}
    for item in payload.rstrip(b"\0").decode("ascii", errors="replace").split(","):
        key, equals, value = item.partition("=")
        if equals:
            fields[key.strip()] = value.strip()
    if "boots" not in fields or "reset" not in fields:
        raise CoapError(f"unexpected 'diag' payload: {payload[:60]!r}")

    def number(key):
        try:
            return int(fields[key])
        except (KeyError, ValueError):
            return None

    def hex16(key):
        return f"0x{fields[key]}" if fields.get(key) else ""

    soil_mv = number("soil_mv")
    return Diagnostics(number("boots") or 0, number("up") or 0, fields["reset"], fields.get("fault", ""),
                       fields.get("role", ""), fields.get("srp", ""), hex16("rloc"), hex16("parent"), number("rssi"), number("last_rssi"),
                       number("lq"), soil_mv if soil_mv is not None and soil_mv >= 0 else None, fields.get("power", ""))


async def get_diag(host, **kwargs):
    """Restarts, crashes and the link to the parent. Firmware without 'diag' doesn't answer, so
    this raises TimeoutError for it."""
    return parse_diag(await _get(host, "diag", **kwargs))


def describe(path, code, payload):
    """A response, for people: {code, code_name, text, hex, decoded}. 'decoded' is a list of
    [name, value] for the board's resources it knows ('data', 'info', 'diag', 'pump', 'pumpdc',
    'log'), else empty."""
    # As text only when it is text: 'data' and the pump's answers are bytes (hex and decoded)
    trimmed = payload.rstrip(b"\0")
    text = trimmed.decode("utf-8", errors="replace") if all(32 <= c < 127 or c in (9, 10, 13) for c in trimmed) else ""
    decoded = []
    try:
        if code == CONTENT and path == "data" and len(payload) >= 4:
            data = parse_data(payload)
            decoded = [["soil moisture", f"{data.soil_moisture} %"], ["battery", f"{data.battery} %"],
                       ["air humidity", f"{data.air_humidity} %"], ["temperature", f"{data.temperature} °C"]]
        elif code == CONTENT and path == "info":
            info = parse_info(payload)
            decoded = [["firmware", info.fw_version], ["hardware", info.hw_version], ["device ID", info.device_id]]
        elif code == CONTENT and path == "diag":
            decoded = [list(item.partition("=")[::2]) for item in text.split(",") if "=" in item]
        elif code == CONTENT and path == "pump" and payload:
            decoded = [["pump", "running" if payload[:1] == b"1" else "stopped"]]
        elif code == CONTENT and path == "pumpdc" and payload:
            decoded = [["run time", f"{payload[0] - 48 if 48 <= payload[0] <= 57 else payload[0]} s"]]
        elif code == CONTENT and path == "log":
            chunk = parse_log(payload)
            decoded = [["boot", chunk.boot_id], ["from offset", str(chunk.start)],
                       ["next: from=", str(chunk.start + len(chunk.text))], ["more to read", "probably" if chunk.full else "no"]]
            text = chunk.text.decode("utf-8", errors="replace")
    except (CoapError, ValueError, IndexError, AttributeError):
        decoded = []
    return {"code": code_name(code), "code_name": CODE_NAMES.get(code, ""), "ok": 0x40 <= code < 0x80,
            "bytes": len(payload), "text": text, "hex": payload.hex(" "), "decoded": decoded}
