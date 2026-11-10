"""Automatic watering: each board's rule, and the loop that applies them.

A rule (the device's 'watering' column, JSON) waters the plant when its soil is under its
watering target, within limits: at most 'max_per_day' times a day, only between 'from_hour'
and 'to_hour' (its owner's local time), at least 'wait_h' hours after its last watering (from
the app, by hand or automatic: the water needs time to reach the sensor), for 'seconds' (or
the board's own run time). It never waters a board that's offline, being updated, or whose
last waterings didn't raise the soil (an empty tank, the tube out of the pot), or whose tank
doesn't hold enough for one more run: those raise their own alerts.
"""

import asyncio
import datetime
import json
import logging
import time
import zoneinfo

from . import fleet

log = logging.getLogger(__name__)

DEFAULTS = {"on": False, "max_per_day": 2, "from_hour": 7, "to_hour": 21, "wait_h": 3, "seconds": None,
            "tz": "", "utc_offset_min": 0}
AUTOMATIC = "Watered automatically"  # how its pump runs read in the activity


class RuleError(ValueError):
    pass


def rule_of(device):
    """The device's rule, with the defaults for what it doesn't say."""
    try:
        stored = json.loads(device.get("watering") or "{}")
    except ValueError:
        stored = {}
    return {**DEFAULTS, **{k: v for k, v in (stored if isinstance(stored, dict) else {}).items() if k in DEFAULTS}}


def checked_rule(values, current):
    """A rule from the page ({on, max_per_day, from_hour, to_hour, wait_h, seconds, tz,
    utc_offset_min}, any of them), on top of the current one. Raises RuleError."""
    if not isinstance(values, dict):
        raise RuleError("The watering rule is a set of values")
    rule = {**current}

    def number(name, low, high, kind=int):
        try:
            value = kind(values[name])
        except (TypeError, ValueError):
            raise RuleError(f"{name}: a number from {low} to {high}") from None
        if not low <= value <= high:
            raise RuleError(f"{name}: a number from {low} to {high}")
        return value

    if "on" in values:
        rule["on"] = bool(values["on"])
    for name, low, high, kind in (("max_per_day", 1, 12, int), ("from_hour", 0, 23, int), ("to_hour", 1, 24, int),
                                  ("wait_h", 0.5, 72, float), ("utc_offset_min", -840, 840, int)):
        if name in values:
            rule[name] = number(name, low, high, kind)
    if "seconds" in values:
        rule["seconds"] = None if values["seconds"] in (None, "", 0, "0") else number("seconds", 1, 9)
    if "tz" in values:
        rule["tz"] = str(values["tz"] or "")[:64]
    if rule["from_hour"] == rule["to_hour"]:  # 0 to 24 is the whole day
        raise RuleError("Give it a few hours to water in: from and until can't be the same")
    return rule


def local_now(rule, now):
    """The rule owner's local time: its time zone when this computer knows it, else the offset
    the page had when the rule was saved."""
    if rule.get("tz"):
        try:
            return datetime.datetime.fromtimestamp(now, zoneinfo.ZoneInfo(rule["tz"]))
        except (zoneinfo.ZoneInfoNotFoundError, ValueError, OSError):
            pass
    zone = datetime.timezone(datetime.timedelta(minutes=rule.get("utc_offset_min") or 0))
    return datetime.datetime.fromtimestamp(now, zone)


def _in_hours(hour, rule):
    start, end = rule["from_hour"], rule["to_hour"]
    return start <= hour < end if start < end else (hour >= start or hour < end)  # over midnight


def decide(device, runs, now=None, busy=False):
    """Whether the rule waters the plant now: {water: bool, why: in words}. 'runs': its pump runs
    of the last two days, [(time, seconds, automatic)]."""
    now = now or time.time()
    rule = rule_of(device)
    if not rule["on"]:
        return {"water": False, "why": "Off"}
    target = device.get("water_target")
    if not target:
        return {"water": False, "why": "No watering target: set one first"}
    if busy:
        return {"water": False, "why": "Waits: an update is running on it"}
    if not device.get("online"):
        return {"water": False, "why": "Waits: it isn't answering"}
    if device.get("watering_missed"):
        return {"water": False, "why": "Paused: its last waterings didn't raise the soil (is its tank empty?)"}
    soil = device.get("soil_moisture")
    if soil is None or soil >= target:
        return {"water": False, "why": f"Waits: its soil ({'–' if soil is None else f'{soil} %'}) isn't under {target} %"}
    local = local_now(rule, now)
    if not _in_hours(local.hour, rule):
        return {"water": False, "why": f"Waits until {rule['from_hour']:02d}:00 (it waters {rule['from_hour']:02d}:00 to "
                                       f"{rule['to_hour'] % 24:02d}:00)"}
    midnight = local.replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
    today = [r for r in runs if r[2] and r[0] >= midnight]
    if len(today) >= rule["max_per_day"]:
        return {"water": False, "why": f"Done for today: {len(today)} of {rule['max_per_day']} waterings"}
    last = max((r[0] for r in runs), default=None)
    if last is not None and now - last < rule["wait_h"] * 3600:
        wait = (last + rule["wait_h"] * 3600 - now) / 60
        return {"water": False, "why": f"Waits {wait:.0f} more minutes after its last watering, for the water to reach the sensor"}
    tank = device.get("tank")
    seconds = rule["seconds"] or device.get("pump_s") or 1
    if tank and tank["left_ml"] < seconds * tank["flow_ml_s"]:
        return {"water": False, "why": "Paused: its tank doesn't hold enough for another watering"}
    return {"water": True, "why": f"Waters now: soil {soil} % under {target} %"}


class AutoWatering:
    def __init__(self, db, inventory, events, alerts, updates=None):
        self.db = db
        self.inventory = inventory
        self.events = events
        self.alerts = alerts
        self.updates = updates
        self._failed = {}  # device_id: when its last automatic watering failed (tried again after a wait)

    def _busy(self, device_id):
        job = self.updates.running_job() if self.updates is not None else None
        return job is not None and any(t.device_id == device_id for t in job.targets)

    def runs(self, device_id, now=None):
        """Its pump runs of the last two days: [(time, seconds, automatic)]."""
        now = now or time.time()
        rows = self.db.activity_kind_since(device_id, "pump", now - 2 * 86400)
        automatic = {row["time"] for row in rows if row["message"].startswith(AUTOMATIC)}
        return [(t, seconds, t in automatic) for t, seconds in fleet.pump_runs(rows)]

    def explain(self, device, now=None):
        return decide(device, self.runs(device["device_id"], now), now, self._busy(device["device_id"]))

    async def run_once(self, now=None):
        """Waters the plants whose rule says so now, one after the other. Returns their IDs."""
        now = now or time.time()
        watered = []
        for device in self.inventory.devices():
            if not rule_of(device)["on"] or now - self._failed.get(device["device_id"], 0) < 15 * 60:
                continue
            decision = self.explain(device, now)
            if not decision["water"]:
                continue
            seconds = rule_of(device)["seconds"]
            try:
                result = await self.inventory.pump(device["device_id"], on=True, seconds=seconds)
            except Exception as exc:  # noqa: BLE001 - the board didn't answer: try again in a while
                self._failed[device["device_id"]] = now
                log.info("automatic watering of %s failed: %s", device["device_id"], exc)
                continue
            self._failed.pop(device["device_id"], None)
            self.db.add_activity(device["device_id"], "pump",
                                 f"{AUTOMATIC}: soil {device['soil_moisture']} % under {device['water_target']} % "
                                 f"({result['duration']} s)")
            self.events.publish("pump", device_id=device["device_id"], seconds=result["duration"], automatic=True)
            watered.append(device["device_id"])
        if watered:
            self.alerts.scan()
        return watered


async def watch(service, period_s=60):
    """Applies the rules every minute."""
    while True:
        await asyncio.sleep(period_s)
        try:
            await service.run_once()
        except Exception:  # noqa: BLE001 - try again next time
            log.exception("automatic watering")
