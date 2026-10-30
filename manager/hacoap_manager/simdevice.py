"""A simulated ha-coap device, for tests and for trying the app without a board.

It answers mcumgr (SMP) over UDP and CoAP ('info', 'data', 'ping', 'log') like the firmware, and
models MCUboot's two slots: upload to slot 1, test, reset (swap), confirm, and revert
when a tested image isn't confirmed before the next reset.

Run one from the command line:
    python -m hacoap_manager.simdevice [--host 127.0.0.1] [--smp-port 1337] [--coap-port 5683]
                                       [--border-router api|legacy] [--border-router-port 8081]
                                       [--no-mdns] [--count 24]
With --count N, it simulates a fleet of N devices at 127.0.0.1, 127.0.0.2 and so on, with
different readings, some running an older image. With --border-router, a simulated border
router REST API serves a made-up network in which the simulated devices are boards (see
simborder.py). Unless --no-mdns, it announces
itself over mDNS like a real board (through its border router), so the app's Find devices
finds it.
"""

import argparse
import asyncio
import hashlib
import math
import random
import struct
import time
from dataclasses import dataclass, field

import cbor2

from . import coap, mcuboot

# SMP header: op, flags, length, group, sequence, command
SMP_HEADER = struct.Struct(">BBHHBB")
OP_READ, OP_READ_RSP, OP_WRITE, OP_WRITE_RSP = 0, 1, 2, 3
GROUP_OS, GROUP_IMAGE = 0, 1
OS_ECHO, OS_RESET, OS_MCUMGR_PARAMS = 0, 5, 6
IMAGE_STATE, IMAGE_UPLOAD, IMAGE_ERASE = 0, 1, 5
RC_OK, RC_EUNKNOWN, RC_EINVAL, RC_ENOTSUP, RC_EBADSTATE = 0, 1, 3, 8, 6

# The log over the air, as the firmware keeps it (CONFIG_HACOAP_REMOTE_LOG_BUFFER_SIZE, and
# LOG_PAYLOAD_MAX_SIZE in application/include/coap_resources.h)
LOG_KEEP = 4096
LOG_PAYLOAD_MAX = coap.LOG_PAYLOAD_MAX
SIM_SAMPLE_S = 20      # the sensors are sampled every 15 min on a board; faster here
SIM_FAST_POLL_S = 30   # CONFIG_HACOAP_MCUMGR_POLL_TIMEOUT_S


@dataclass
class Slot:
    image: bytes = b""
    confirmed: bool = False
    pending: bool = False
    permanent: bool = False

    @property
    def info(self):
        return mcuboot.parse_image(self.image) if self.image else None


@dataclass
class SimulatedDevice:
    device_id: str = "1a2b3c4d"
    hw_version: str = "v2.0"
    data: bytes = bytes([42, 87, 55, 251])  # soil, battery, air humidity, -5 degC
    slots: list = field(default_factory=lambda: [Slot(), Slot()])
    reboot_s: float = 0.3            # unreachable for this long after a reset
    fail_boot: bool = False          # a tested image crashes: MCUboot reverts it
    drop_smp_every: int = 0          # drop every Nth SMP request (0: never)
    drop_coap_first: int = 0         # drop the first N CoAP requests
    dynamic: bool = False            # readings change over time (battery drains), for trying the app
    battery_drain_per_hour: float = 0.5
    battery_start: float = 87
    phase: float = 0.0               # shifts the dynamic readings, so a fleet's devices differ
    pump_running: bool = False
    pump_duration: int = 1
    pings: int = 0
    resets: int = 0
    smp_requests: int = 0
    remote_log: bool = True          # the 'log' resource (firmware built with HACOAP_REMOTE_LOG)
    _upload: bytearray = None
    _upload_size: int = 0
    _rebooting_until: float = 0.0
    _started: float = field(default_factory=time.time)
    _log: bytearray = field(default_factory=bytearray)  # the last LOG_KEEP bytes
    _log_written: int = 0
    _boot_id: str = ""
    _booted: float = 0.0
    _last_sample: float = 0.0
    _last_log_read: float = 0.0

    def __post_init__(self):
        self._boot_log()

    @classmethod
    def with_image(cls, image, **kwargs):
        device = cls(**kwargs)
        device.slots[0] = Slot(image=image, confirmed=True, permanent=True)
        return device

    def readings(self):
        """The 'data' payload: fixed, or (dynamic) a slowly draining battery and drifting readings."""
        if not self.dynamic:
            return self.data
        hours = (time.time() - self._started) / 3600
        battery = max(3, round(self.battery_start - hours * self.battery_drain_per_hour))
        soil = round(45 + 20 * math.sin(hours / 6 + self.phase))
        humidity = round(55 + 10 * math.sin(hours / 9 + 1 + self.phase))
        temperature = round(18 + 6 * math.sin(hours / 4 + self.phase))
        return bytes([soil, battery, humidity, temperature & 0xFF])

    @property
    def fw_version(self):
        info = self.slots[0].info
        return info.hash[:7] if info else "unknown"

    def _rebooting(self):
        return asyncio.get_running_loop().time() < self._rebooting_until

    # ------------------------------------------------------------ MCUboot

    def boot(self):
        """What MCUboot does at a reset."""
        primary, secondary = self.slots
        if secondary.pending and secondary.image:
            # Swap: the new image runs, unconfirmed unless it was confirmed up front.
            new = Slot(image=secondary.image, confirmed=secondary.permanent, permanent=secondary.permanent)
            old = Slot(image=primary.image, confirmed=True)
            self.slots = [new, old]
            if self.fail_boot and not new.confirmed:
                self.boot()  # crashes: the watchdog resets it before it's confirmed
        elif primary.image and not primary.confirmed:
            # The tested image wasn't confirmed: swap back.
            self.slots = [Slot(image=secondary.image, confirmed=True, permanent=True),
                          Slot(image=primary.image)]

    def reset(self):
        self.resets += 1
        self.boot()
        self._rebooting_until = asyncio.get_running_loop().time() + self.reboot_s
        self._boot_log()

    # ------------------------------------------------------------ the log over the air

    def log(self, text, level="inf", module="coap_server"):
        """Adds a line to the log, formatted like the firmware's remote_log backend."""
        uptime = time.time() - self._booted
        hours, rest = divmod(uptime, 3600)
        minutes, seconds = divmod(rest, 60)
        stamp = f"[{int(hours):02d}:{int(minutes):02d}:{seconds:06.3f},{int(uptime * 1e6) % 1000:03d}]"
        data = f"{stamp} <{level}> {module}: {text}\n".encode() if level else f"{text}\n".encode()
        self._log += data
        self._log_written += len(data)
        del self._log[:-LOG_KEEP]

    def _boot_log(self):
        self._log = bytearray()
        self._log_written = 0
        self._boot_id = f"{random.getrandbits(32) | 1:08x}"
        self._booted = self._last_sample = time.time()
        self.log("*** Booting nRF Connect SDK v2.4.3 ***", level=None)
        self.log("Set up user button at gpio@50000000 pin 15")
        self.log("Start CoAP-server sample")
        self.log("CoAP server has started", module="coap_resources")
        self.log("Initialization done. Starting OpenThread...")
        self.log(f"hostname is: ha-coap-{self.device_id}")
        self.log(f"service instance is: ha-coap-{self.device_id}")
        self.log("Adding SRP client service...")
        self.log("SRP callback: OK")
        self._sample_log()

    def _sample_log(self):
        soil, battery, humidity, temperature = self.readings()
        temperature = temperature - 256 if temperature > 127 else temperature
        self.log(f"soil_voltage = {2200 - soil * 12} mV, soil_humidity = {soil} %")
        self.log(f"Temp = {temperature}.250000 C, RH = {humidity}.500000 %")
        self.log(f"soil_humidity = {soil}, battery = {battery}, air_humidity = {humidity}, temperature = {temperature}")

    def read_log(self, offset):
        """The 'log' payload for a reader that has the log up to 'offset' (like log_buffer_read())."""
        now = time.time()
        while now - self._last_sample >= SIM_SAMPLE_S:  # sampling, sped up
            self._last_sample += SIM_SAMPLE_S
            self._sample_log()
        if now - self._last_log_read > SIM_FAST_POLL_S:
            self.log("mcumgr or log reader: poll period 100 ms")
        self._last_log_read = now
        oldest = self._log_written - len(self._log)
        start = oldest if offset < oldest or offset > self._log_written else offset
        header = f"{self._boot_id} {start}\n".encode()
        return header + bytes(self._log[start - oldest:])[:LOG_PAYLOAD_MAX - len(header)]

    # ------------------------------------------------------------ SMP

    def _images(self):
        images = []
        for number, slot in enumerate(self.slots):
            info = slot.info
            if info is None:
                continue
            images.append({
                "slot": number,
                "version": info.mcumgr_version,
                "hash": bytes.fromhex(info.hash),
                "bootable": True,
                "pending": slot.pending,
                "confirmed": slot.confirmed,
                "active": number == 0,
                "permanent": slot.permanent,
            })
        return {"images": images, "splitStatus": 0}

    def handle_smp(self, frame):
        """Returns the response to one SMP request, or None to drop it."""
        self.smp_requests += 1
        if self._rebooting():
            return None
        if self.drop_smp_every and self.smp_requests % self.drop_smp_every == 0:
            return None
        first, flags, length, group, sequence, command = SMP_HEADER.unpack_from(frame)
        request = cbor2.loads(frame[SMP_HEADER.size:SMP_HEADER.size + length]) if length else {}
        response, after = self._dispatch(first & 0x07, group, command, request)
        payload = cbor2.dumps(response)
        # Answers in SMP version 1, like Zephyr 3.3 (version bits cleared)
        header = SMP_HEADER.pack((first & 0x07) + 1, flags, len(payload), group, sequence, command)
        return header + payload, after

    def _dispatch(self, op, group, command, request):
        if group == GROUP_OS and command == OS_ECHO:
            return {"r": request.get("d", "")}, None
        if group == GROUP_OS and command == OS_RESET:
            return {}, self.reset
        if group == GROUP_IMAGE and command == IMAGE_STATE and op == OP_READ:
            return self._images(), None
        if group == GROUP_IMAGE and command == IMAGE_STATE and op == OP_WRITE:
            return self._state_write(request), None
        if group == GROUP_IMAGE and command == IMAGE_UPLOAD:
            return self._upload_chunk(request), None
        if group == GROUP_IMAGE and command == IMAGE_ERASE:
            self.slots[1] = Slot()
            return {"rc": RC_OK}, None
        return {"rc": RC_ENOTSUP}, None

    def _state_write(self, request):
        image_hash = request.get("hash")
        confirm = request.get("confirm", False)
        primary, secondary = self.slots
        if confirm and (image_hash is None or (primary.info and bytes.fromhex(primary.info.hash) == image_hash)):
            primary.confirmed = True
            primary.permanent = True
            secondary.pending = False
        elif secondary.info and image_hash == bytes.fromhex(secondary.info.hash):
            secondary.pending = True
            secondary.permanent = bool(confirm)
        else:
            return {"rc": RC_EINVAL}
        return self._images()

    def _upload_chunk(self, request):
        offset = request.get("off")
        data = request.get("data", b"")
        if offset == 0:
            if "len" not in request:
                return {"rc": RC_EINVAL}
            self._upload = bytearray()
            self._upload_size = request["len"]
            self._upload_sha = request.get("sha")
            self.slots[1] = Slot()
        if self._upload is None:
            return {"rc": RC_EINVAL}
        if offset != len(self._upload):
            return {"rc": RC_OK, "off": len(self._upload)}  # wrong offset: tell the client where to go on
        self._upload.extend(data)
        response = {"rc": RC_OK, "off": len(self._upload)}
        if len(self._upload) >= self._upload_size:
            image = bytes(self._upload)
            self._upload = None
            try:
                mcuboot.parse_image(image)
                self.slots[1] = Slot(image=image)
            except mcuboot.ImageError:
                return {"rc": RC_EINVAL}
            if self._upload_sha is not None:
                response["match"] = hashlib.sha256(image).digest() == self._upload_sha
        return response

    # ------------------------------------------------------------ CoAP

    def handle_coap(self, data):
        if self._rebooting():
            return None
        if self.drop_coap_first > 0:
            self.drop_coap_first -= 1
            return None
        try:
            message = coap.decode(data)
        except coap.CoapError:
            return None
        if message.type == coap.TYPE_CON:
            reply_type = coap.TYPE_ACK
        elif message.type == coap.TYPE_NON:
            reply_type = coap.TYPE_NON
        else:
            return None

        def reply(code, payload=b""):
            return coap.encode(reply_type, code, message.message_id, message.token, payload=payload)

        if message.path == "info" and message.code == coap.GET:
            text = f"{self.fw_version},{self.hw_version},{self.device_id}"
            self.log(f"Device info is: {text}", module="coap_resources")
            return reply(coap.CONTENT, text.encode() + b"\0")
        if message.path == "data" and message.code == coap.GET:
            self.log("Received 'data' GET request", module="coap_resources")
            return reply(coap.CONTENT, self.readings())
        if message.path == "log" and message.code == coap.GET:
            if not self.remote_log:
                return reply(coap.NOT_FOUND)
            offset = next((int(q[5:]) for q in message.query if q.startswith("from=") and q[5:].isdigit()), 0)
            return reply(coap.CONTENT, self.read_log(offset))
        if message.path == "pump":
            if message.code == coap.PUT and message.type == coap.TYPE_CON and message.payload in (b"0", b"1"):
                self.log(f"Received 'pump' PUT request: {message.payload.decode()}", module="coap_resources")
                self.pump_running = message.payload == b"1"
                if self.pump_running:
                    asyncio.get_running_loop().call_later(self.pump_duration, self._pump_off)
            elif message.code != coap.GET:
                return None  # the firmware ignores a NON PUT
            return reply(coap.CONTENT, bytes([1 if self.pump_running else 0]))
        if message.path == "pumpdc":
            if message.code == coap.PUT and message.payload[:1].isdigit():
                seconds = int(message.payload[:1])
                if 1 <= seconds <= 9:
                    self.pump_duration = seconds
            return reply(coap.CONTENT, bytes([self.pump_duration]))
        if message.path == "ping" and message.code == coap.PUT:
            self.log("Received 'ping' PUT request", module="coap_resources")
            if message.payload == b"1":
                self.pings += 1
            return reply(coap.CHANGED)
        return reply(0x84)  # 4.04 Not Found


    def _pump_off(self):
        self.pump_running = False


class _SmpProtocol(asyncio.DatagramProtocol):
    def __init__(self, device):
        self.device = device

    def connection_made(self, transport):
        self.transport = transport

    def datagram_received(self, data, addr):
        result = self.device.handle_smp(data)
        if result is None:
            return
        response, after = result
        self.transport.sendto(response, addr)
        if after is not None:
            asyncio.get_running_loop().call_later(0.05, after)


class _CoapProtocol(asyncio.DatagramProtocol):
    def __init__(self, device):
        self.device = device

    def connection_made(self, transport):
        self.transport = transport

    def datagram_received(self, data, addr):
        response = self.device.handle_coap(data)
        if response is not None:
            self.transport.sendto(response, addr)


class SimulatorServer:
    """Serves one SimulatedDevice on a host and two UDP ports (0: any free port)."""

    def __init__(self, device, host="127.0.0.1", smp_port=0, coap_port=0):
        self.device = device
        self.host = host
        self._requested = (smp_port, coap_port)
        self._transports = []
        self.smp_port = None
        self.coap_port = None

    async def start(self):
        loop = asyncio.get_running_loop()
        smp_port, coap_port = self._requested
        smp, _ = await loop.create_datagram_endpoint(lambda: _SmpProtocol(self.device), local_addr=(self.host, smp_port))
        cp, _ = await loop.create_datagram_endpoint(lambda: _CoapProtocol(self.device), local_addr=(self.host, coap_port))
        self._transports = [smp, cp]
        self.smp_port = smp.get_extra_info("sockname")[1]
        self.coap_port = cp.get_extra_info("sockname")[1]
        return self

    async def stop(self):
        for transport in self._transports:
            transport.close()
        self._transports = []

    async def __aenter__(self):
        return await self.start()

    async def __aexit__(self, *exc):
        await self.stop()


async def announce(device_id, host, coap_port):
    """Announces the device over mDNS as ha-coap-<id>._ot._udp, like a real board's border
    router does, with a TXT flag that lets discovery accept a loopback address."""
    aiozc = await announce_all([(device_id, host, coap_port)])
    print(f"Announced over mDNS as ha-coap-{device_id}._ot._udp.local.")
    return aiozc


async def announce_all(devices):
    """Announces several devices, given as (device_id, host, coap_port). Returns the
    AsyncZeroconf to close when done."""
    import socket

    from zeroconf import ServiceInfo
    from zeroconf.asyncio import AsyncZeroconf

    aiozc = AsyncZeroconf()
    registrations = []
    for device_id, host, coap_port in devices:
        family = socket.AF_INET6 if ":" in host else socket.AF_INET
        info = ServiceInfo("_ot._udp.local.", f"ha-coap-{device_id}._ot._udp.local.",
                           addresses=[socket.inet_pton(family, host)], port=coap_port,
                           properties={"sim": "1"}, server=f"ha-coap-{device_id}.local.")
        registrations.append(await aiozc.async_register_service(info))
    await asyncio.gather(*registrations)  # registered together: each one probes for about a second
    return aiozc


def fleet(count):
    """A simulated fleet of 'count' devices, as (host, device): device i answers at 127.0.0.<i+1>.
    Each has its own battery level, drain and readings, and every fifth runs an older image,
    so the dashboard has something to show. The first is the usual 1a2b3c4d."""
    current = mcuboot.build_image(b"simulated firmware" * 100, (1, 0, 0, 0))
    older = mcuboot.build_image(b"simulated firmware, older" * 100, (0, 9, 0, 0))
    result = []
    for i in range(count):
        device_id = "1a2b3c4d" if i == 0 else hashlib.sha256(f"simulated {i}".encode()).hexdigest()[:8]
        device = SimulatedDevice.with_image(older if i % 5 == 3 else current, device_id=device_id, dynamic=True,
                                            battery_start=87 if i == 0 else 95 - (i * 37) % 80,
                                            battery_drain_per_hour=0.5 if i == 0 else 0.2 + (i % 4) * 0.25,
                                            phase=i * 0.7)
        result.append((f"127.0.0.{i + 1}", device))
    return result


def main():
    parser = argparse.ArgumentParser(description="Simulated ha-coap device (mcumgr over UDP and CoAP)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--smp-port", type=int, default=1337)
    parser.add_argument("--coap-port", type=int, default=5683)
    parser.add_argument("--device-id", default="1a2b3c4d")
    parser.add_argument("--border-router", choices=("api", "legacy"),
                        help="also simulate a border router REST API, as a 2025+ (api) or older (legacy) one")
    parser.add_argument("--border-router-port", type=int, default=8081)
    parser.add_argument("--no-mdns", action="store_true", help="don't announce the device over mDNS")
    parser.add_argument("--count", type=int, default=1,
                        help="simulate this many devices, at 127.0.0.1, 127.0.0.2 and so on (up to 200)")
    args = parser.parse_args()
    if not 1 <= args.count <= 200:
        parser.error("--count must be between 1 and 200")

    async def run():
        if args.count == 1:
            devices = [(args.host, SimulatedDevice.with_image(
                mcuboot.build_image(b"simulated firmware" * 100, (1, 0, 0, 0)), device_id=args.device_id, dynamic=True))]
        else:
            devices = fleet(args.count)
        servers = []
        try:
            for host, device in devices:
                try:
                    servers.append(await SimulatorServer(device, host, args.smp_port, args.coap_port).start())
                except OSError as exc:
                    hint = (" On macOS, only 127.0.0.1 exists until you add the others, for example: "
                            "for i in $(seq 2 24); do sudo ifconfig lo0 alias 127.0.0.$i up; done") \
                        if host != "127.0.0.1" else ""
                    raise SystemExit(f"Can't listen on {host}: {exc}.{hint}")
            first = servers[0]
            if len(servers) == 1:
                print(f"Simulated device {first.device.device_id}: mcumgr on {first.host}:{first.smp_port}, "
                      f"CoAP on {first.host}:{first.coap_port}. Ctrl+C to stop.")
            else:
                print(f"{len(servers)} simulated devices, at 127.0.0.1 to {servers[-1].host} "
                      f"(mcumgr on port {first.smp_port}, CoAP on {first.coap_port}). Ctrl+C to stop.")
            announcement = None
            if not args.no_mdns:
                if len(servers) == 1:
                    announcement = await announce(first.device.device_id, first.host, first.coap_port)
                else:
                    announcement = await announce_all([(s.device.device_id, s.host, s.coap_port) for s in servers])
                    print("Announced over mDNS as ha-coap-<ID>._ot._udp.local., for each device.")
            border = None
            if args.border_router:
                from .simborder import SimulatedBorderRouter, scenario
                addresses = [s.host for s in servers] if len(servers) > 1 else [first.host, "fd11:22::2"]
                border = SimulatedBorderRouter(args.border_router, first.host, args.border_router_port,
                                               scenario(addresses)).start()
                print(f"Simulated border router ({args.border_router} API): {border.url}")
            try:
                await asyncio.Event().wait()
            finally:
                if border is not None:
                    border.stop()
                if announcement is not None:
                    await announcement.async_close()
        finally:
            for server in servers:
                await server.stop()

    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
