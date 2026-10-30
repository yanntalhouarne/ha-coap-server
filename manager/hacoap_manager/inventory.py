"""The fleet inventory: finds devices, and keeps their status up to date over CoAP and mcumgr."""

import asyncio
import logging
import time

from . import coap, discovery, fleet
from .mcumgr import DeviceLink, McumgrError

log = logging.getLogger(__name__)


class InventoryError(Exception):
    pass


# Why a board restarted ('diag'), in words
RESET_CAUSES = {
    "power": "power on (a battery change, the USB plugged in, or a brownout)",
    "pin": "the reset button",
    "soft": "a software reset (after an update, or a reset from the app)",
    "watchdog": "the watchdog: it stopped responding",
    "lockup": "a CPU lockup",
    "crash": "a crash",
    "other": "another reason",
}
# The ones worth an alert
BAD_RESETS = ("watchdog", "lockup", "crash")


def reset_text(cause, fault=""):
    text = RESET_CAUSES.get(cause, cause or "an unknown reason")
    if cause == "crash" and fault:
        reason, _, address = fault.partition("@")
        text += f" (fatal error {reason} at 0x{address})"
    return text


class Inventory:
    def __init__(self, db, settings, events, discover=discovery.discover):
        self.db = db
        self.settings = settings
        self.events = events
        self._discover = discover
        self.refreshed = False  # every device asked at least once since the app started
        self.on_restart = None  # called with (device, cause, fault) after a restart that's a problem

    def _changed(self, device):
        self.events.publish("device", device=self.describe(device))
        return device

    def describe(self, device):
        """The device as the API returns it, with whether it's online and needs water."""
        seen = device.get("last_seen")
        online = seen is not None and time.time() - seen < self.settings.online_minutes * 60
        return {**device, "online": online, "water_target": fleet.water_target(device, self.settings),
                "needs_water": fleet.needs_water(device, self.settings)}

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
        """Reads 'info', 'data' and (newer firmware) 'diag' over CoAP."""
        device = self._device(device_id)
        if not device["address"]:
            raise InventoryError(f"{device_id} has no network address")
        options = self._coap_options()
        # Firmware without 'diag' doesn't answer it: once seen, not asked again until an update.
        ask_diag = not device["no_diag_fw"] or device["no_diag_fw"] != device["fw_version"]
        requests = [coap.get_info(device["address"], **options), coap.get_data(device["address"], **options)]
        if ask_diag:
            requests.append(coap.get_diag(device["address"], **options))
        answers = await asyncio.gather(*requests, return_exceptions=True)
        info, data = answers[:2]
        for answer in (info, data):
            if isinstance(answer, BaseException):
                if not isinstance(answer, (coap.CoapError, TimeoutError, OSError)):
                    raise answer
                return self._changed(self.db.upsert_device(device_id, last_error=f"No answer: {answer}"))
        if info.device_id != device_id:
            return self._changed(self.db.upsert_device(
                device_id, last_error=f"{device['address']} is now device {info.device_id}"))
        self.db.add_reading(device_id, data.battery, data.soil_moisture, data.air_humidity, data.temperature)
        fields = dict(fw_version=info.fw_version, hw_version=info.hw_version, soil_moisture=data.soil_moisture,
                      battery=data.battery, air_humidity=data.air_humidity, temperature=data.temperature,
                      last_seen=time.time(), last_error="")
        if ask_diag:
            diag = answers[2]
            if isinstance(diag, coap.Diagnostics):
                fields.update(self._diagnostics(device, diag))
            elif isinstance(diag, (TimeoutError, coap.CoapError)):
                fields["no_diag_fw"] = info.fw_version  # older firmware
            elif isinstance(diag, BaseException) and not isinstance(diag, OSError):
                raise diag
        return self._changed(self.db.upsert_device(device_id, **fields))

    def _diagnostics(self, device, diag):
        """The fields 'diag' sets, after recording any restart since the last answer."""
        now = time.time()
        previous = device["boots"]
        if previous is not None and diag.boots != previous:
            # Several restarts between two refreshes: only the last one's cause is known.
            count = diag.boots - previous if diag.boots > previous else 1  # a lower count: its flash was erased
            message = f"Restarted: {reset_text(diag.reset, diag.fault)}"
            if count > 1:
                message += f" ({count} restarts since the last check)"
            self.db.add_activity(device["device_id"], "restart", message, when=now - diag.uptime_s)
            if diag.reset in BAD_RESETS and self.on_restart is not None:
                self.on_restart(device, diag.reset, diag.fault)
        return dict(boots=diag.boots, reset_cause=diag.reset, fault=diag.fault, uptime_s=diag.uptime_s,
                    role=diag.role, rloc16=diag.rloc16, parent_rloc16=diag.parent, parent_rssi=diag.rssi,
                    link_quality=diag.link_quality, soil_mv=diag.soil_mv, diag_time=now, no_diag_fw="")

    async def refresh_all(self, concurrency=4):
        semaphore = asyncio.Semaphore(concurrency)

        async def one(device):
            async with semaphore:
                try:
                    await self.refresh(device["device_id"])
                except InventoryError:
                    pass

        await asyncio.gather(*(one(d) for d in self.db.devices() if d["address"]))
        self.refreshed = True
        return self.devices()

    # ------------------------------------------------------------ the board's settings (mcumgr group 64)

    # What each setting is, for the page and the activity log
    SETTING_NAMES = {"sample_s": "sampling period (s)", "soil_dry_mv": "soil sensor when dry (mV)",
                     "soil_wet_mv": "soil sensor when wet (mV)", "pump_s": "pump run time (s)",
                     "poll_ms": "poll period (ms)"}

    def _link(self, device_id, transport, serial_port):
        device = self._device(device_id)
        address = serial_port if transport == "serial" else device["address"]
        if not address:
            raise InventoryError("No serial port given" if transport == "serial" else f"{device_id} has no network address")
        return device, DeviceLink(transport, address, self.settings.link_settings())

    @staticmethod
    def _settings_error(exc):
        if "ENOTSUP" in str(exc):
            return InventoryError("This board's firmware can't do this: update it to a newer firmware first")
        if "EINVAL" in str(exc):
            return InventoryError("The board refused these values (out of range, or the soil sensor's dry value "
                                  "not above its wet one): nothing changed")
        return InventoryError(str(exc))

    async def board_settings(self, device_id, transport="udp", serial_port=""):
        """The board's settings: {"settings": {name: {value, default, min, max}}, "soil_mv", "samples"}."""
        device, link = self._link(device_id, transport, serial_port)
        try:
            async with link:
                result = await link.board_settings()
        except McumgrError as exc:
            raise self._settings_error(exc) from exc
        self._changed(self.db.upsert_device(device_id, **self._known(result), last_seen=time.time()))
        return result

    @staticmethod
    def _known(result):
        """What a settings answer tells about the board, for its record."""
        fields = {"soil_mv": result["soil_mv"]}
        if "pump_s" in result["settings"]:
            fields["pump_s"] = result["settings"]["pump_s"]["value"]
        return fields

    async def set_board_settings(self, device_id, values, transport="udp", serial_port=""):
        """Changes some of the board's settings ({name: value}): all of them, or none."""
        unknown = set(values) - set(self.SETTING_NAMES)
        if unknown:
            raise InventoryError(f"Unknown settings: {', '.join(sorted(unknown))}")
        device, link = self._link(device_id, transport, serial_port)
        try:
            async with link:
                before = (await link.board_settings())["settings"]
                result = await link.set_board_settings(values)
        except McumgrError as exc:
            raise self._settings_error(exc) from exc
        changes = [f"{self.SETTING_NAMES[name]} {before[name]['value']} → {result['settings'][name]['value']}"
                   for name in values if name in before and before[name]["value"] != result["settings"][name]["value"]]
        if changes:
            self.db.add_activity(device_id, "settings", "Settings changed: " + ", ".join(changes))
        self._changed(self.db.upsert_device(device_id, **self._known(result), last_seen=time.time()))
        return result

    async def sample_soil(self, device_id, transport="udp", serial_port="", timeout_s=15.0):
        """Takes a sensor sample now and returns the settings with its soil voltage (for calibrating)."""
        device, link = self._link(device_id, transport, serial_port)
        try:
            async with link:
                before = await link.sample()
                deadline = time.monotonic() + timeout_s
                while True:
                    await asyncio.sleep(0.5)  # the soil sensor powers up for 200 ms first
                    result = await link.board_settings()
                    if result["samples"] > before or time.monotonic() > deadline:
                        break
        except McumgrError as exc:
            raise self._settings_error(exc) from exc
        if result["samples"] <= before:
            raise InventoryError("The board didn't take a new sample")
        self._changed(self.db.upsert_device(device_id, **self._known(result), last_seen=time.time()))
        return result

    async def forget_network(self, device_id, transport="udp", serial_port=""):
        """Makes the board forget its Thread network: it resets and joins again, with a
        commissioner (any network that accepts its PSKd)."""
        device, link = self._link(device_id, transport, serial_port)
        try:
            async with link:
                await link.forget_network()
        except McumgrError as exc:
            raise self._settings_error(exc) from exc
        self.db.add_activity(device_id, "network", "Told to forget its Thread network: it joins again with a commissioner")
        return self._changed(self.db.upsert_device(device_id, last_error="Forgot its network: waiting to join again"))

    async def set_fleet_settings(self, device_ids, values):
        """The same settings on several boards, over the air, one after the other.
        Returns {device_id: error or ""}."""
        results = {}
        for device_id in device_ids:
            try:
                await self.set_board_settings(device_id, values)
                results[device_id] = ""
            except InventoryError as exc:
                results[device_id] = str(exc)
        return results

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
        self._changed(self.db.upsert_device(device_id, pump_s=duration, last_seen=time.time()))
        return {"running": running, "duration": duration}

    async def ping(self, device_id):
        device = self._device(device_id)
        try:
            await coap.ping(device["address"], **self._coap_options())
        except (coap.CoapError, TimeoutError, OSError) as exc:
            raise InventoryError(f"No answer: {exc}") from exc
        self._changed(self.db.upsert_device(device_id, last_seen=time.time()))
