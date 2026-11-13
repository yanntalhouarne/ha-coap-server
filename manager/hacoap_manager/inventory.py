"""The fleet inventory: finds devices, and keeps their status up to date over CoAP and mcumgr.

Newer firmware keeps its latest samples ('hist'): each refresh reads the ones the app doesn't have
(after the network was down, they fill the gap) and registers to observe them, so a sample that
changed (a plant watered, a board plugged in) arrives as it's taken (on_history)."""

import asyncio
import logging
import time

from . import autowater, coap, discovery, fleet
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

# A board that stops answering triggers a new browse of the network, at most this often
REDISCOVER_INTERVAL_S = 300

HISTORY_READS = 8      # answers read at most at a refresh (54 samples each: more than the board keeps)
SAMPLE_MARGIN_S = 1    # a sample this close after the last reading kept is that one again (its time is to the second)
BUTTON = "its button"   # who ran its pump, in the activity, when it was its button
ELSEWHERE = "another app, such as Home Assistant"  # ... when neither this app nor its button did
ELSEWHERE_MIN_MS = 1000  # pump time ('diag' pump_ms) no run explains: a run started elsewhere from this long
ABSORBED_MS = 500        # a run that ran this much shorter than noted: timing, not a run still going
MAX_RUN_MS = 10_000      # longer than any run (9 s at most): pump time missing beyond it isn't a run still going
OWN_RUN_WAIT_S = 15      # after this app starts a run: its pump time isn't counted until the run, and its note, are done


def same_board(reported, device_id):
    """Whether the ID a board gives in 'info' is this device's. Firmware up to d98bac1 cut it to
    7 characters there (an 8-byte buffer), while its name on the network has all 8."""
    return reported == device_id or (len(reported) == 7 and len(device_id) == 8 and device_id.startswith(reported))


# Its power, as newer firmware's 'diag' reports it: what changed, in words
POWER_CHANGES = {
    "charging": "Plugged in: charging",
    "charged": "Charged (still plugged in)",
    "usb": "Plugged in",
    "battery": "Unplugged: on its battery",
}


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
        self._rediscover_lock = asyncio.Lock()
        self._last_rediscover = float("-inf")
        self.on_restart = None  # called with (device, cause, fault) after a restart that's a problem
        self.on_pushed = None   # called with the device after it pushed new samples
        self.observer = None    # observes the boards' 'hist' (coap.Observer), from the first refresh
        self._push_tasks = set()  # reads after a push without samples (a setting changed, a pump run ended)
        self._pump_started = {}   # device_id: when this app last started its pump (before its activity notes it)

    def _changed(self, device):
        self.events.publish("device", device=self.describe(device))
        return device

    def _traffic(self, device_id, kind):
        """A message to or from a board, for the network map's live traffic: push (it pushed),
        read (the app read it), command (the app told it something)."""
        self.events.publish("traffic", device_id=device_id, what=kind)

    def describe(self, device):
        """The device as the API returns it, with whether it's online and needs water, its water
        tank, and whether its last waterings missed (the soil didn't rise)."""
        now = time.time()
        seen = device.get("last_seen")
        online = seen is not None and now - seen < self.settings.online_minutes * 60
        # Since its tank was refilled (the runs before don't count), else the last 30 days; and
        # those of the last two weeks, for how fast its tank empties
        since = (device.get("tank_filled") or 0) if device.get("tank_ml") else now - 30 * 86400
        recent_since = now - fleet.USAGE_DAYS * 86400
        recent = fleet.pump_runs(self.db.activity_kind_since(device["device_id"], "pump", min(since, recent_since)))
        runs = [r for r in recent if r[0] >= since]
        first = runs[-fleet.NO_RISE_RUNS][0] if len(runs) >= fleet.NO_RISE_RUNS else None
        missed = first is not None and fleet.watering_missed(
            self.db.readings(device["device_id"], since=first - 86400), runs, now)
        return {**device, "online": online, "water_target": fleet.water_target(device, self.settings),
                "needs_water": fleet.needs_water(device, self.settings),
                "tank": fleet.tank_state(device, runs, self.settings, [r for r in recent if r[0] >= recent_since], now),
                "watering_missed": missed,
                "watering_rule": autowater.rule_of(device)}

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
            fields = {"address": item.address, "name": name}
            txt = item.txt or {}
            if txt.get("fw"):  # newer firmware says what it runs: no need to ask it
                fields.update(fw_version=txt["fw"], hw_version=txt.get("hw", ""))
            devices.append(self._changed(self.db.upsert_device(device_id, **fields)))
        return [self.describe(d) for d in devices]

    async def add_by_address(self, address):
        """Adds the device at 'address' (it must answer 'info')."""
        try:
            info = await coap.get_info(address, **self._coap_options())
        except (coap.CoapError, TimeoutError, OSError) as exc:
            raise InventoryError(f"No answer from {address}: {exc}") from exc
        # Older firmware's shortened ID: the device already known at that address, if it's this one
        device_id = next((d["device_id"] for d in self.db.devices()
                          if d["address"] == address and same_board(info.device_id, d["device_id"])), info.device_id)
        existing = self.db.device(device_id)
        name = existing["name"] if existing and existing["name"] else f"{discovery.NAME_PREFIX}-{device_id}"
        self.db.upsert_device(device_id, address=address, name=name, fw_version=info.fw_version,
                              hw_version=info.hw_version, last_seen=time.time(), last_error="")
        return await self.refresh(device_id)

    def _device(self, device_id):
        device = self.db.device(device_id)
        if device is None:
            raise InventoryError(f"Unknown device {device_id}")
        return device

    async def _found_again(self, device):
        """A board that doesn't answer may have a new address (a new border router gives every
        board one under its own prefix): browse the network again, once for all the boards that
        stopped answering together and at most every REDISCOVER_INTERVAL_S. Returns its new
        address, or None."""
        if self._discover is None:
            return None
        async with self._rediscover_lock:
            if time.monotonic() - self._last_rediscover >= REDISCOVER_INTERVAL_S:
                self._last_rediscover = time.monotonic()
                try:
                    await self.discover()
                except Exception:  # noqa: BLE001 - no mDNS here, or the network down: as before
                    log.info("browsing the network again failed", exc_info=True)
        address = (self.db.device(device["device_id"]) or {}).get("address")
        if address and address != device["address"]:
            self.db.add_activity(device["device_id"], "network",
                                 f"Found at a new address: {address} (was {device['address']})", actor="")
            return address
        return None

    def close(self):
        if self.observer is not None:
            self.observer.close()
            self.observer = None

    async def _observe_history(self, address, from_seq, options):
        """Reads the board's samples from 'from_seq' on, and registers to be sent its new ones."""
        if self.observer is None:
            self.observer = coap.Observer(self.on_history)
        code, payload, _ = await self.observer.register(address, "hist", (f"from={from_seq}",), **options)
        if code == coap.NOT_FOUND:
            raise coap.NoHistory("this board's firmware keeps no samples")
        if code != coap.CONTENT:
            raise coap.CoapError(f"'hist' answered {coap.code_name(code)}")
        return coap.parse_history(payload)

    def _store_samples(self, device_id, history, received_at):
        """Keeps the samples the app doesn't have: in the boot it read last, those from the first
        one it didn't read; else (the first read, or after a restart) those newer than its last
        reading kept. Returns the newest sample, or None."""
        known = self.db.device(device_id) or {}
        same_boot = known.get("hist_boot") == history.boot and known.get("hist_next") is not None
        last = None if same_boot else (self.db.last_reading_time(device_id) or 0)
        rows = []
        for sample in history.samples:
            when = min(history.time_of(sample, received_at), received_at)
            new = sample.seq >= known["hist_next"] if same_boot else when > last + SAMPLE_MARGIN_S
            if new:
                rows.append((device_id, when, sample.battery, sample.soil_moisture, sample.air_humidity,
                             sample.temperature, sample.power))
        if rows:
            self.db.add_samples(rows)
        fields = {"hist_boot": history.boot, "hist_next": history.read_up_to}
        if history.samples:  # when it last sampled: one that stopped is an alert (alerts.NOT_SAMPLING_S)
            fields["last_sample"] = min(history.time_of(history.samples[-1], received_at), received_at)
        self.db.upsert_device(device_id, **fields)
        return history.samples[-1] if history.samples else None

    async def _read_more_history(self, device, history, options):
        """The rest of the samples, when there were more than fit in one answer (from its first,
        after it restarted: the number asked was the boot before's)."""
        received_at = time.time()
        if history.boot != device["hist_boot"] and history.first > 0:
            try:
                history = await coap.get_history(device["address"], 0, **options)
            except (coap.CoapError, TimeoutError, OSError):
                pass  # what came, then
            received_at = time.time()
        for _ in range(HISTORY_READS):
            self._store_samples(device["device_id"], history, received_at)
            if history.read_up_to >= history.next or not history.samples:
                return
            try:
                history = await coap.get_history(device["address"], history.read_up_to, **options)
            except (coap.CoapError, TimeoutError, OSError):
                return  # the rest at the next refresh
            received_at = time.time()

    def on_history(self, host, payload):
        """A board pushed its new samples (it observed 'hist' changed): kept, and its readings now."""
        device = next((d for d in self.db.devices() if d["address"] == host), None)
        if device is None:
            return
        try:
            history = coap.parse_history(payload)
        except coap.CoapError:
            return
        self._traffic(device["device_id"], "push")
        newest = self._store_samples(device["device_id"], history, time.time())
        if newest is None:
            if not history.samples:
                # A push without samples: something changed (its pump's run time, set in Home
                # Assistant; a pump run ended)
                task = asyncio.get_running_loop().create_task(self._after_change(device["device_id"], host))
                self._push_tasks.add(task)
                task.add_done_callback(self._push_tasks.discard)
            return
        fields = dict(soil_moisture=newest.soil_moisture, battery=newest.battery, air_humidity=newest.air_humidity,
                      temperature=newest.temperature, last_seen=time.time(), last_error="")
        if newest.power:
            if device["power"] and newest.power != device["power"] and newest.power in POWER_CHANGES:
                self.db.add_activity(device["device_id"], "power", POWER_CHANGES[newest.power], actor="")
            fields["power"] = newest.power
        device = self._changed(self.db.upsert_device(device["device_id"], **fields))
        if self.on_pushed is not None:
            self.on_pushed(device)

    async def _after_change(self, device_id, host):
        """After a push without samples: its 'diag' again (its pump's run time, a pump run started
        elsewhere), or its 'pumpdc' (firmware without pump_s in 'diag')."""
        options = self._coap_options()
        try:
            diag = await coap.get_diag(host, **options)
        except (coap.CoapError, TimeoutError, OSError):
            diag = None
        device = self.db.device(device_id)
        if device is None:
            return
        fields = self._diagnostics(device, diag) if diag is not None else {}
        if fields.get("pump_s") is None:
            try:
                fields["pump_s"] = await coap.get_pump_duration(host, **options)
            except (coap.CoapError, TimeoutError, OSError):
                if not fields:
                    return  # seen at the next refresh
        self._changed(self.db.upsert_device(device_id, last_seen=time.time(), **fields))

    async def refresh(self, device_id, rediscover=True):
        """Reads 'info', 'data' and (newer firmware) 'diag' and 'hist' over CoAP. A board that
        doesn't answer is looked for again on the network, and asked at its new address if it moved."""
        device = self._device(device_id)
        if not device["address"]:
            raise InventoryError(f"{device_id} has no network address")
        options = self._coap_options()
        # Firmware without 'diag' or 'hist' doesn't answer them: once seen, not asked again until an update.
        ask_diag = not device["no_diag_fw"] or device["no_diag_fw"] != device["fw_version"]
        ask_hist = not device["no_hist_fw"] or device["no_hist_fw"] != device["fw_version"]
        requests = [coap.get_info(device["address"], **options), coap.get_data(device["address"], **options)]
        if ask_diag:
            requests.append(coap.get_diag(device["address"], **options))
        if ask_hist:
            # From the first sample it doesn't have (all of them after a restart: the board's numbers start again)
            same_boot = device["hist_boot"] is not None and device["hist_boot"] == device["boots"]
            requests.append(self._observe_history(device["address"], device["hist_next"] if same_boot else 0, options))
        answers = await asyncio.gather(*requests, return_exceptions=True)
        info, data = answers[:2]
        for answer in (info, data):
            if isinstance(answer, BaseException):
                if not isinstance(answer, (coap.CoapError, TimeoutError, OSError)):
                    raise answer
                if rediscover and await self._found_again(device):
                    return await self.refresh(device_id, rediscover=False)
                return self._changed(self.db.upsert_device(device_id, last_error=f"No answer: {answer}"))
        if not same_board(info.device_id, device_id):
            return self._changed(self.db.upsert_device(
                device_id, last_error=f"{device['address']} is now device {info.device_id}"))
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
        history = answers[-1] if ask_hist else None
        if isinstance(history, coap.History):
            fields["no_hist_fw"] = ""
            await self._read_more_history(device, history, options)  # its samples are its readings
        else:
            if ask_hist and isinstance(history, (TimeoutError, coap.CoapError)):
                fields["no_hist_fw"] = info.fw_version  # older firmware
            elif ask_hist and isinstance(history, BaseException) and not isinstance(history, OSError):
                raise history
            # With its power then: readings on USB don't count in the battery's drain
            self.db.add_reading(device_id, data.battery, data.soil_moisture, data.air_humidity, data.temperature,
                                power=fields.get("power", ""))
        self._traffic(device_id, "read")
        return self._changed(self.db.upsert_device(device_id, **fields))

    def _diagnostics(self, device, diag):
        """The fields 'diag' sets, after recording any restart since the last answer."""
        now = time.time()
        # As it is now: a push may have been read while this answer came (its runs counted once)
        device = self.db.device(device["device_id"]) or device
        previous = device["boots"]
        restarted = previous is not None and diag.boots != previous
        # An answer older than one already read (a refresh's, overtaken by a push's): it would set
        # its counts back
        if not restarted and device["uptime_s"] is not None and diag.uptime_s < device["uptime_s"]:
            return {}
        if restarted:
            # Several restarts between two refreshes: only the last one's cause is known.
            count = diag.boots - previous if diag.boots > previous else 1  # a lower count: its flash was erased
            message = f"Restarted: {reset_text(diag.reset, diag.fault)}"
            if count > 1:
                message += f" ({count} restarts since the last check)"
            self.db.add_activity(device["device_id"], "restart", message, when=now - diag.uptime_s, actor="")
            if diag.reset in BAD_RESETS and self.on_restart is not None:
                self.on_restart(device, diag.reset, diag.fault)
        # Its power now, not as the refresh started: a sample it pushed meanwhile may have told already
        power = device["power"]
        if diag.power and power and diag.power != power and diag.power in POWER_CHANGES:
            self.db.add_activity(device["device_id"], "power", POWER_CHANGES[diag.power], actor="")
        fields = dict(boots=diag.boots, reset_cause=diag.reset, fault=diag.fault, uptime_s=diag.uptime_s,
                      role=diag.role, srp_state=diag.srp, rloc16=diag.rloc16, parent_rloc16=diag.parent, parent_rssi=diag.rssi,
                      link_quality=diag.link_quality, soil_mv=diag.soil_mv, diag_time=now, no_diag_fw="", power=diag.power)
        if diag.button_s is not None:
            # Its pump's runs with its button since the last answer (all of them since boot after a
            # restart), for its water tank. Not known before the first answer.
            ran = diag.button_s if restarted else diag.button_s - (device["button_s"] or 0)
            if device["button_s"] is not None and ran > 0:
                self.db.add_activity(device["device_id"], "pump", f"Pump run with its button ({ran} s)", actor=BUTTON)
            fields["button_s"] = diag.button_s
        if diag.pump_ms is not None:
            fields.update(self._runs_elsewhere(device, diag, restarted, now))
        if diag.pump_s is not None:
            fields["pump_s"] = diag.pump_s
        return fields

    def _runs_elsewhere(self, device, diag, restarted, now):
        """Its pump's runs that neither this app nor its button started (Home Assistant...),
        noted for its water tank: how long its pump ran ('diag' pump_ms) since the runs noted
        last time, less the runs noted since (this app's, its button's). Returns the fields that
        keep the count: none while a run this app started may not be noted yet."""
        if now - self._pump_started.get(device["device_id"], float("-inf")) < OWN_RUN_WAIT_S:
            return {}  # counted at an answer after it
        seen, since = device["pump_ms_seen"], device["pump_ms_time"]
        noted_until = time.time()  # the runs noted until now are counted (the button's just now too)
        if seen is None or since is None:
            return {"pump_ms_seen": diag.pump_ms, "pump_ms_time": noted_until}  # the first answer: from now
        rows = [r for r in self.db.activity_kind_since(device["device_id"], "pump", since) if r["actor"] != ELSEWHERE]
        accounted = (0 if restarted else seen) + sum(s for _, s in fleet.pump_runs(rows)) * 1000
        left = diag.pump_ms - accounted
        if left >= ELSEWHERE_MIN_MS:
            seconds = round(left / 1000)
            self.db.add_activity(device["device_id"], "pump", f"Pump run from another app ({seconds} s)", when=now,
                                 actor=ELSEWHERE)
        elif -MAX_RUN_MS <= left <= -ABSORBED_MS and not restarted:
            # A run still going (its button's: noted whole as it starts): the rest of it is noted already
            return {"pump_ms_seen": accounted, "pump_ms_time": noted_until}
        # Else timing, runs lost in a restart, or a run that didn't happen
        return {"pump_ms_seen": diag.pump_ms, "pump_ms_time": noted_until}

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
        if transport == "udp":
            self._traffic(device_id, "command")
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
        if on:
            self._pump_started[device_id] = time.time()  # before it runs: its 'diag' may come first
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
        self._traffic(device_id, "command")
        self._changed(self.db.upsert_device(device_id, pump_s=duration, last_seen=time.time()))
        return {"running": running, "duration": duration}

    async def ping(self, device_id):
        device = self._device(device_id)
        try:
            await coap.ping(device["address"], **self._coap_options())
        except (coap.CoapError, TimeoutError, OSError) as exc:
            raise InventoryError(f"No answer: {exc}") from exc
        self._traffic(device_id, "command")
        self._changed(self.db.upsert_device(device_id, last_seen=time.time()))
