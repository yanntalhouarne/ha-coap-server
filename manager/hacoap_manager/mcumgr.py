"""mcumgr (SMP) over USB serial or UDP, through smpclient: image slots, upload, test,
confirm and reset, and the board's settings (the firmware's own 'hacoap' group, 64).

The upload resumes from the device's offset after a timeout, instead of starting over:
over Thread, a lost packet is not unusual.
"""

import asyncio
import hashlib
import logging
from dataclasses import dataclass

from smp import error as smperror
from smp import message as smpmessage
from smpclient import SMPClient
from smpclient.generics import error, success
from smpclient.requests.image_management import ImageStatesRead, ImageStatesWrite, ImageUploadWrite
from smpclient.requests.os_management import EchoWrite, ResetWrite
from smpclient.transport.serial import BufferSize, SMPSerialTransport
from smpclient.transport.udp import SMPUDPTransport

log = logging.getLogger(__name__)

MCUMGR_UDP_PORT = 1337
HACOAP_GROUP = 64  # application/src/hacoap_mgmt.c


class McumgrError(Exception):
    pass


@dataclass
class SlotState:
    slot: int
    version: str
    hash: str
    bootable: bool
    pending: bool
    confirmed: bool
    active: bool
    permanent: bool

    def as_dict(self):
        return dict(self.__dict__)


@dataclass
class LinkSettings:
    udp_port: int = MCUMGR_UDP_PORT
    udp_mtu: int = 1280          # IPv6's minimum MTU, which Thread uses: no IP fragmentation
    serial_buffer: int = 512     # SMP message size over USB serial (the firmware reassembles up to 2048)
    timeout_s: float = 10.0      # per request; longer than the device's poll period
    first_upload_timeout_s: float = 60.0  # the first chunk erases the update slot
    upload_retries: int = 5      # timeouts in a row before an upload gives up


class _UDPTransport(SMPUDPTransport):
    """smpclient's UDP transport, on a chosen port."""

    def __init__(self, port, mtu):
        super().__init__(mtu=mtu)
        self._port = port

    async def connect(self, address, timeout_s, port=None):
        await super().connect(address, timeout_s, port if port is not None else self._port)


# ---------------------------------------------------------------- the 'hacoap' group (64)

class _HacoapErrorV1(smperror.ErrorV1):
    _GROUP_ID = HACOAP_GROUP


class _HacoapErrorV2(smperror.ErrorV2[smperror.MGMT_ERR]):
    _GROUP_ID = HACOAP_GROUP


class HacoapSettingsReadResponse(smpmessage.ReadResponse):
    _GROUP_ID = HACOAP_GROUP
    _COMMAND_ID = 0
    settings: dict[str, list[int]]  # name: [value, default, min, max]
    soil_mv: int
    samples: int


class HacoapSettingsWriteResponse(smpmessage.WriteResponse):
    _GROUP_ID = HACOAP_GROUP
    _COMMAND_ID = 0
    settings: dict[str, list[int]]
    soil_mv: int
    samples: int


class HacoapSettingsRead(smpmessage.ReadRequest):
    _GROUP_ID = HACOAP_GROUP
    _COMMAND_ID = 0
    _Response = HacoapSettingsReadResponse
    _ErrorV1 = _HacoapErrorV1
    _ErrorV2 = _HacoapErrorV2


class HacoapSettingsWrite(smpmessage.WriteRequest):
    _GROUP_ID = HACOAP_GROUP
    _COMMAND_ID = 0
    _Response = HacoapSettingsWriteResponse
    _ErrorV1 = _HacoapErrorV1
    _ErrorV2 = _HacoapErrorV2
    set: dict[str, int]


class HacoapSampleResponse(smpmessage.WriteResponse):
    _GROUP_ID = HACOAP_GROUP
    _COMMAND_ID = 1
    samples: int


class HacoapSample(smpmessage.WriteRequest):
    _GROUP_ID = HACOAP_GROUP
    _COMMAND_ID = 1
    _Response = HacoapSampleResponse
    _ErrorV1 = _HacoapErrorV1
    _ErrorV2 = _HacoapErrorV2


def _board_settings(response):
    """{"settings": {name: {value, default, min, max}}, "soil_mv": mV or None, "samples": n}"""
    return {"settings": {name: dict(zip(("value", "default", "min", "max"), values))
                         for name, values in response.settings.items() if len(values) == 4},
            "soil_mv": response.soil_mv if response.soil_mv >= 0 else None,
            "samples": response.samples}


def _failed(response):
    """An error answer. Zephyr 3.3 answers errors as {"rc": N}, which can also parse as a
    response whose fields are all optional (an upload's), so 'rc' is checked too."""
    return error(response) or getattr(response, "rc", None) not in (None, 0)


def _describe(response):
    rc = getattr(response, "rc", None)
    if rc is None and getattr(response, "err", None) is not None:
        rc = response.err.rc
    reason = getattr(response, "rsn", None)
    name = getattr(rc, "name", rc)
    return f"error {name}" + (f" ({reason})" if reason else "")


class DeviceLink:
    """An mcumgr connection to one device. Use with 'async with'.

    'kind' is "udp" (address: the device's IPv6 address) or "serial" (address: the port,
    such as COM7 or /dev/ttyACM0).
    """

    def __init__(self, kind, address, settings=None):
        if kind not in ("udp", "serial"):
            raise ValueError(f"unknown transport {kind!r}")
        self.kind = kind
        self.address = address
        self.settings = settings or LinkSettings()
        self._client = None
        self._transport = None

    def _new_transport(self):
        if self.kind == "udp":
            return _UDPTransport(self.settings.udp_port, self.settings.udp_mtu)
        return SMPSerialTransport(BufferSize(buf_size=self.settings.serial_buffer), baudrate=115200)

    async def connect(self):
        self._transport = self._new_transport()
        self._client = SMPClient(self._transport, self.address, timeout_s=self.settings.timeout_s)
        try:
            await self._client.connect(connect_timeout_s=self.settings.timeout_s)
        except Exception as exc:
            self._client = None
            raise McumgrError(f"cannot connect to {self.address}: {exc}") from exc

    async def disconnect(self):
        if self._client is not None:
            try:
                await self._client.disconnect()
            except Exception:  # noqa: BLE001 - already gone (reset, unplugged)
                pass
            self._client = None

    async def reconnect(self):
        """A new socket or port: drops any late answer to a timed-out request."""
        await self.disconnect()
        await self.connect()

    async def __aenter__(self):
        await self.connect()
        return self

    async def __aexit__(self, *exc):
        await self.disconnect()

    async def _request(self, request, timeout_s=None, retries=2):
        """Sends a request, again after a timeout (these requests are all idempotent)."""
        for attempt in range(retries + 1):
            try:
                response = await self._client.request(request, timeout_s=timeout_s)
                break
            except TimeoutError as exc:
                if attempt == retries:
                    raise McumgrError(f"no answer from {self.address}") from exc
                log.info("%s: no answer, retrying", self.address)
                await self.reconnect()
        if _failed(response):
            raise McumgrError(f"{self.address}: {_describe(response)}")
        return response

    async def echo(self, text="hacoap"):
        response = await self._request(EchoWrite(d=text))
        return response.r

    async def image_states(self):
        response = await self._request(ImageStatesRead())
        return [_slot_state(image) for image in response.images]

    async def test(self, image_hash):
        """Marks the image in slot 1 to be tried at the next reset."""
        response = await self._request(ImageStatesWrite(hash=bytes.fromhex(image_hash), confirm=False))
        return [_slot_state(image) for image in response.images]

    async def confirm(self):
        """Makes the running image permanent."""
        response = await self._request(ImageStatesWrite(confirm=True))
        return [_slot_state(image) for image in response.images]

    async def board_settings(self):
        """The board's settings (see _board_settings)."""
        return _board_settings(await self._request(HacoapSettingsRead()))

    async def set_board_settings(self, values):
        """Changes settings ({name: value}): all of them, or none (an error). Returns them all."""
        return _board_settings(await self._request(HacoapSettingsWrite(set={k: int(v) for k, v in values.items()})))

    async def sample(self):
        """Takes a sensor sample now. Returns the sample count before it."""
        return (await self._request(HacoapSample())).samples

    async def reset(self):
        """Resets the device. A lost answer is ignored: whether the device reset (and which
        image it then runs) shows when it comes back."""
        try:
            await self._request(ResetWrite(), retries=0)
        except McumgrError as exc:
            log.info("%s: no answer to the reset (%s)", self.address, exc)

    def _upload_request(self, image, offset, sha):
        fields = {"off": offset, "data": b""}
        if offset == 0:
            fields.update(len=len(image), sha=sha, image=0)
        _, size = self._client.get_max_cbor_and_data_size(ImageUploadWrite(**fields))
        size = min(size, len(image) - offset)
        while True:
            request = ImageUploadWrite(**{**fields, "data": image[offset:offset + size]})
            if len(request.BYTES) <= self._transport.max_unencoded_size or size <= 16:
                return request
            size -= 16

    async def upload(self, image, progress=None):
        """Uploads 'image' to slot 1. Calls progress(offset, size) after each chunk."""
        sha = hashlib.sha256(image).digest()
        offset = 0
        timeouts = 0
        response = None
        while offset < len(image):
            request = self._upload_request(image, offset, sha)
            timeout = self.settings.first_upload_timeout_s if offset == 0 else self.settings.timeout_s
            try:
                response = await self._client.request(request, timeout_s=timeout)
            except TimeoutError:
                timeouts += 1
                if timeouts > self.settings.upload_retries:
                    raise McumgrError(f"upload to {self.address} stopped at {offset} of {len(image)} bytes: no answer")
                log.info("upload to %s: no answer at offset %d, retrying (%d)", self.address, offset, timeouts)
                await self.reconnect()
                continue
            if _failed(response):
                raise McumgrError(f"upload to {self.address} refused: {_describe(response)}")
            if not success(response) or response.off is None:
                raise McumgrError(f"upload to {self.address}: unexpected answer {response}")
            timeouts = 0
            offset = response.off
            if progress is not None:
                progress(offset, len(image))
        if response is not None and response.match is False:
            raise McumgrError(f"upload to {self.address}: the device's SHA-256 doesn't match the image")


def _slot_state(image):
    return SlotState(
        slot=image.slot,
        version=image.version,
        hash=bytes(image.hash).hex() if image.hash is not None else "",
        bootable=bool(image.bootable),
        pending=bool(image.pending),
        confirmed=bool(image.confirmed),
        active=bool(image.active),
        permanent=bool(image.permanent),
    )


async def wait_for_device(kind, address, settings, timeout_s=180.0, interval_s=5.0):
    """After a reset: connects again and returns the slot states once the device answers."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout_s
    last_error = None
    while loop.time() < deadline:
        link = DeviceLink(kind, address, settings)
        try:
            async with link:
                return await link.image_states()
        except McumgrError as exc:
            last_error = exc
        await asyncio.sleep(interval_s)
    raise McumgrError(f"{address} didn't come back within {timeout_s:.0f} s ({last_error})")
