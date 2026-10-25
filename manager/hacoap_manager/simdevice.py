"""A simulated ha-coap device, for tests and for trying the app without a board.

It answers mcumgr (SMP) over UDP and CoAP ('info', 'data', 'ping') like the firmware, and
models MCUboot's two slots: upload to slot 1, test, reset (swap), confirm, and revert
when a tested image isn't confirmed before the next reset.

Run one from the command line:
    python -m hacoap_manager.simdevice [--host 127.0.0.1] [--smp-port 1337] [--coap-port 5683]
"""

import argparse
import asyncio
import hashlib
import struct
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
    pings: int = 0
    resets: int = 0
    smp_requests: int = 0
    _upload: bytearray = None
    _upload_size: int = 0
    _rebooting_until: float = 0.0

    @classmethod
    def with_image(cls, image, **kwargs):
        device = cls(**kwargs)
        device.slots[0] = Slot(image=image, confirmed=True, permanent=True)
        return device

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
            return reply(coap.CONTENT, text.encode() + b"\0")
        if message.path == "data" and message.code == coap.GET:
            return reply(coap.CONTENT, self.data)
        if message.path == "ping" and message.code == coap.PUT:
            if message.payload == b"1":
                self.pings += 1
            return reply(coap.CHANGED)
        return reply(0x84)  # 4.04 Not Found


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


def main():
    parser = argparse.ArgumentParser(description="Simulated ha-coap device (mcumgr over UDP and CoAP)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--smp-port", type=int, default=1337)
    parser.add_argument("--coap-port", type=int, default=5683)
    parser.add_argument("--device-id", default="1a2b3c4d")
    args = parser.parse_args()

    async def run():
        device = SimulatedDevice.with_image(mcuboot.build_image(b"simulated firmware" * 100, (1, 0, 0, 0)),
                                            device_id=args.device_id)
        async with SimulatorServer(device, args.host, args.smp_port, args.coap_port) as server:
            print(f"Simulated device {args.device_id}: mcumgr on {args.host}:{server.smp_port}, "
                  f"CoAP on {args.host}:{server.coap_port}. Ctrl+C to stop.")
            await asyncio.Event().wait()

    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
