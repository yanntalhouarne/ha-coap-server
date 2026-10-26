"""The fleet inventory: finds devices, and keeps their status up to date over CoAP and mcumgr."""

import asyncio
import logging
import time

from . import coap, discovery
from .mcumgr import DeviceLink, McumgrError

log = logging.getLogger(__name__)


class InventoryError(Exception):
    pass


class Inventory:
    def __init__(self, db, settings, events, discover=discovery.discover):
        self.db = db
        self.settings = settings
        self.events = events
        self._discover = discover

    def _changed(self, device):
        self.events.publish("device", device=self.describe(device))
        return device

    def describe(self, device):
        """The device as the API returns it, with whether it's online."""
        seen = device.get("last_seen")
        online = seen is not None and time.time() - seen < self.settings.online_minutes * 60
        return {**device, "online": online}

    def devices(self):
        return [self.describe(d) for d in self.db.devices()]

    def _coap_options(self):
        return {"port": self.settings.coap_port, "ack_timeout": self.settings.coap_timeout_s, "max_retransmit": 1}

    async def discover(self):
        """Browses the network and adds or updates the devices it finds. Returns them."""
        found = await self._discover(self.settings.discovery_timeout_s)
        devices = []
        for item in found:
            device_id = item.device_id
            if not device_id:
                # No ID suffix in the name (CONFIG_HACOAP_SRP_SUFFIX_NONE): ask the device.
                try:
                    device_id = (await coap.get_info(item.address, **self._coap_options())).device_id
                except (coap.CoapError, TimeoutError, OSError):
                    continue
            existing = self.db.device(device_id)
            name = existing["name"] if existing and existing["name"] else item.instance
            devices.append(self._changed(self.db.upsert_device(device_id, address=item.address, name=name)))
        return [self.describe(d) for d in devices]

    async def add_by_address(self, address):
        """Adds the device at 'address' (it must answer 'info')."""
        try:
            info = await coap.get_info(address, **self._coap_options())
        except (coap.CoapError, TimeoutError, OSError) as exc:
            raise InventoryError(f"No answer from {address}: {exc}") from exc
        existing = self.db.device(info.device_id)
        name = existing["name"] if existing and existing["name"] else f"{discovery.NAME_PREFIX}-{info.device_id}"
        self.db.upsert_device(info.device_id, address=address, name=name, fw_version=info.fw_version,
                              hw_version=info.hw_version, last_seen=time.time(), last_error="")
        return await self.refresh(info.device_id)

    def _device(self, device_id):
        device = self.db.device(device_id)
        if device is None:
            raise InventoryError(f"Unknown device {device_id}")
        return device

    async def refresh(self, device_id):
        """Reads 'info' and 'data' over CoAP."""
        device = self._device(device_id)
        if not device["address"]:
            raise InventoryError(f"{device_id} has no network address")
        options = self._coap_options()
        try:
            info, data = await asyncio.gather(coap.get_info(device["address"], **options),
                                              coap.get_data(device["address"], **options))
        except (coap.CoapError, TimeoutError, OSError) as exc:
            return self._changed(self.db.upsert_device(device_id, last_error=f"No answer: {exc}"))
        if info.device_id != device_id:
            return self._changed(self.db.upsert_device(
                device_id, last_error=f"{device['address']} is now device {info.device_id}"))
        self.db.add_reading(device_id, data.battery, data.soil_moisture, data.air_humidity, data.temperature)
        return self._changed(self.db.upsert_device(
            device_id, fw_version=info.fw_version, hw_version=info.hw_version, soil_moisture=data.soil_moisture,
            battery=data.battery, air_humidity=data.air_humidity, temperature=data.temperature,
            last_seen=time.time(), last_error=""))

    async def refresh_all(self, concurrency=4):
        semaphore = asyncio.Semaphore(concurrency)

        async def one(device):
            async with semaphore:
                try:
                    await self.refresh(device["device_id"])
                except InventoryError:
                    pass

        await asyncio.gather(*(one(d) for d in self.db.devices() if d["address"]))
        return self.devices()

    async def read_slots(self, device_id, transport="udp", serial_port=""):
        """Reads the image slots over mcumgr, and records the running image."""
        device = self._device(device_id)
        address = serial_port if transport == "serial" else device["address"]
        if not address:
            raise InventoryError("No serial port given" if transport == "serial" else f"{device_id} has no network address")
        try:
            async with DeviceLink(transport, address, self.settings.link_settings()) as link:
                slots = await link.image_states()
        except McumgrError as exc:
            raise InventoryError(str(exc)) from exc
        running = next((s for s in slots if s.slot == 0), None)
        fields = {"last_seen": time.time()}
        if running is not None:
            fields.update(image_version=running.version, image_hash=running.hash)
        if transport == "serial":
            fields["serial_port"] = serial_port
        self._changed(self.db.upsert_device(device_id, **fields))
        return [s.as_dict() for s in slots]

    async def read_all_slots(self):
        """Reads every device's running image over the air, one after the other (to know which
        ones are outdated). Returns {device_id: error or ""}."""
        results = {}
        for device in self.db.devices():
            if not device["address"]:
                continue
            try:
                await self.read_slots(device["device_id"])
                results[device["device_id"]] = ""
            except InventoryError as exc:
                results[device["device_id"]] = str(exc)
        return results

    def _address(self, device_id):
        device = self._device(device_id)
        if not device["address"]:
            raise InventoryError(f"{device_id} has no network address")
        return device["address"]

    async def pump(self, device_id, on=None, seconds=None):
        """Sets the run time and/or starts or stops the pump. Returns the pump's state."""
        address = self._address(device_id)
        options = self._coap_options()
        try:
            if seconds is not None:
                await coap.set_pump_duration(address, int(seconds), **options)
            running = await coap.set_pump(address, on, **options) if on is not None \
                else await coap.get_pump(address, **options)
            duration = await coap.get_pump_duration(address, **options)
        except ValueError as exc:
            raise InventoryError(str(exc)) from exc
        except (coap.CoapError, TimeoutError, OSError) as exc:
            raise InventoryError(f"No answer: {exc}") from exc
        self._changed(self.db.upsert_device(device_id, last_seen=time.time()))
        return {"running": running, "duration": duration}

    async def ping(self, device_id):
        device = self._device(device_id)
        try:
            await coap.ping(device["address"], **self._coap_options())
        except (coap.CoapError, TimeoutError, OSError) as exc:
            raise InventoryError(f"No answer: {exc}") from exc
        self._changed(self.db.upsert_device(device_id, last_seen=time.time()))
