"""A small CoAP client (RFC 7252) for the device's resources: 'info', 'data' and 'ping'.

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
GET, PUT = 1, 3
CHANGED, CONTENT = 0x44, 0x45
OPTION_URI_PATH = 11

ACK_TIMEOUT_S = 4.0  # longer than the device's poll period
MAX_RETRANSMIT = 2


class CoapError(Exception):
    pass


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


def encode(msg_type, code, message_id, token, path="", payload=b""):
    data = bytes([0x40 | (msg_type << 4) | len(token), code]) + struct.pack(">H", message_id) + token
    last = 0
    for segment in [s for s in path.split("/") if s]:
        data += _option(OPTION_URI_PATH - last, segment.encode())
        last = OPTION_URI_PATH
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
    return Message(msg_type, code, message_id, token, "/".join(segments), payload)


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


async def request(host, path, method=GET, payload=b"", *, port=COAP_PORT,
                  ack_timeout=ACK_TIMEOUT_S, max_retransmit=MAX_RETRANSMIT, timeout=None):
    """Sends a confirmable request and returns (code, payload) of the response.

    Raises CoapError on a reset, and TimeoutError without an answer.
    """
    loop = asyncio.get_running_loop()
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    transport, protocol = await loop.create_datagram_endpoint(_Protocol, remote_addr=(host, port), family=family)
    message_id = random.randrange(0x10000)
    token = os.urandom(4)
    data = encode(TYPE_CON, method, message_id, token, path, payload)
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


async def ping(host, beep=True, **kwargs):
    code, _ = await request(host, "ping", PUT, b"1" if beep else b"0", **kwargs)
    if code != CHANGED:
        raise CoapError(f"'ping' answered {code_name(code)}")
