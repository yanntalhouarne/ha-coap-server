"""Imports the boards' history from Home Assistant, which has it from before the app ran.

The ha-coap integration gives each board the sensors "<name>.battery", "<name>.soil-humidity",
"<name>.air-humidity", "<name>.temperature" and "<name>.device-id", whose state is the board's
ID: boards are matched by that ID (by name only when it's unavailable). The history comes from
HA's REST API (/api/history), so it covers what HA's recorder keeps: 10 days by default.

The access token is kept in its own file in the data folder (ha-token), never in settings.json,
backups or problem reports.
"""

import bisect
import datetime
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

# The integration's sensor names, and the reading each one fills
FIELDS = {"battery": "battery", "soil-humidity": "soil_moisture", "air-humidity": "air_humidity",
          "temperature": "temperature"}
READING_FIELDS = ("battery", "soil_moisture", "air_humidity", "temperature")
BUCKET_S = 900   # one imported reading per 15 minutes at most, as often as the app reads
MAX_DAYS = 90


class HomeAssistantError(Exception):
    pass


class TokenStore:
    """The long-lived access token, alone in a file only this user can read."""

    def __init__(self, data_dir):
        self.path = Path(data_dir) / "ha-token"

    def get(self):
        try:
            return self.path.read_text(encoding="utf-8").strip()
        except OSError:
            return ""

    def set(self, token):
        token = (token or "").strip()
        if not token:
            self.path.unlink(missing_ok=True)
            return
        self.path.write_text(token, encoding="utf-8")
        try:
            os.chmod(self.path, 0o600)
        except OSError:
            pass  # Windows: the per-user data folder is already private


def _fetch(url, headers, timeout):
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        return exc.code, ""


def _iso(when):
    return datetime.datetime.fromtimestamp(when, datetime.timezone.utc).isoformat(timespec="seconds")


def _parse_time(text):
    try:
        return datetime.datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()
    except (AttributeError, ValueError):
        return None


class HomeAssistant:
    def __init__(self, url, token, fetch=_fetch, timeout=30.0):
        if not url:
            raise HomeAssistantError("Set Home Assistant's address first, such as http://homeassistant.local:8123")
        if not token:
            raise HomeAssistantError("Paste a long-lived access token first (your HA profile → Security)")
        self.base = url.rstrip("/")
        self.token = token
        self._fetch = fetch
        self.timeout = timeout

    def _get(self, path, params=None):
        url = self.base + path + ("?" + urllib.parse.urlencode(params) if params else "")
        try:
            status, text = self._fetch(url, {"Authorization": f"Bearer {self.token}", "Accept": "application/json"},
                                       self.timeout)
        except (urllib.error.URLError, OSError) as exc:
            raise HomeAssistantError(f"Cannot reach Home Assistant at {self.base} "
                                     f"({getattr(exc, 'reason', exc)})") from exc
        if status == 401:
            raise HomeAssistantError("Home Assistant refused the token: make a new long-lived access token")
        if status != 200:
            raise HomeAssistantError(f"Home Assistant answered HTTP {status} to {path}")
        try:
            return json.loads(text)
        except ValueError as exc:
            raise HomeAssistantError(f"{path}: not JSON (is this Home Assistant's address?)") from exc

    def check(self):
        """{version, name} of the Home Assistant instance."""
        config = self._get("/api/config")
        return {"version": config.get("version", ""), "name": config.get("location_name", "")}

    def boards(self):
        """The integration's boards: [{ha_name, device_id, entities: {field: {entity_id, unit}}}]."""
        states = self._get("/api/states")
        names = {}
        for state in states:
            attributes = state.get("attributes") or {}
            names[str(attributes.get("friendly_name") or "")] = (state.get("entity_id"), attributes, state.get("state"))
        boards = []
        for name, (_, _, value) in names.items():
            if not name.endswith(".device-id"):
                continue
            prefix = name[: -len(".device-id")]
            device_id = str(value or "").strip().lower()
            entities = {}
            for sensor, field in FIELDS.items():
                found = names.get(f"{prefix}.{sensor}")
                if found:
                    entities[field] = {"entity_id": found[0], "unit": found[1].get("unit_of_measurement") or ""}
            boards.append({"ha_name": prefix, "device_id": device_id if device_id not in ("", "unknown", "unavailable")
                           else None, "entities": entities})
        return sorted(boards, key=lambda b: b["ha_name"].lower())

    def history(self, entity_ids, start, end):
        """{entity_id: [(time, state)]} between start and end (only changes: HA stores those)."""
        series = self._get(f"/api/history/period/{urllib.parse.quote(_iso(start))}", {
            "filter_entity_id": ",".join(entity_ids), "end_time": _iso(end), "minimal_response": "",
            "no_attributes": ""})
        result = {}
        for entries in series or []:
            if not entries:
                continue
            entity_id = entries[0].get("entity_id")
            result[entity_id] = [(t, e.get("state")) for e in entries
                                 if (t := _parse_time(e.get("last_changed") or e.get("last_updated"))) is not None]
        return result


def _value(field, state, unit):
    try:
        value = float(state)
    except (TypeError, ValueError):
        return None  # unavailable, unknown
    if field == "temperature" and unit in ("°F", "F"):
        value = (value - 32) * 5 / 9
    return round(value)


def readings_from_history(history, entities):
    """Readings from HA's change lists, one per 15-minute slot where anything changed. A value
    holds until its next change (that's how HA stores it), so each reading carries the last known
    value of every field; 'unavailable' clears it."""
    field_of = {e["entity_id"]: (field, e["unit"]) for field, e in entities.items()}
    changes = sorted((t, field_of[entity_id], state) for entity_id, entries in history.items()
                     if entity_id in field_of for t, state in entries)
    current, rows = {}, {}
    for t, (field, unit), state in changes:
        current[field] = _value(field, state, unit)
        slot = int(t // BUCKET_S) * BUCKET_S
        rows[slot] = dict(current)
    return [(slot, *(values.get(f) for f in READING_FIELDS)) for slot, values in sorted(rows.items())
            if any(values.get(f) is not None for f in READING_FIELDS)]


def import_history(db, ha, devices, days=10, now=None):
    """Imports every matched board's history of the last 'days'. Skips slots the app already has a
    reading in (so importing twice adds nothing). Returns [{ha_name, device_id, name, imported, note}]."""
    now = now or time.time()
    start = now - max(1, min(days, MAX_DAYS)) * 86400
    known = {d["device_id"]: d for d in devices}
    by_name = {(d["name"] or "").lower(): d["device_id"] for d in devices if d["name"]}
    results = []
    for board in ha.boards():
        device_id = board["device_id"] if board["device_id"] in known else by_name.get(board["ha_name"].lower())
        result = {"ha_name": board["ha_name"], "device_id": device_id,
                  "name": (known[device_id]["name"] or device_id) if device_id else "", "imported": 0, "note": ""}
        results.append(result)
        if not device_id:
            result["note"] = (f"No device {board['device_id']} in the app: find it first" if board["device_id"]
                              else "Its device-id sensor has no value, and no device has this name")
            continue
        if not board["entities"]:
            result["note"] = "No reading sensors found for it"
            continue
        history = ha.history([e["entity_id"] for e in board["entities"].values()], start, now)
        have = sorted(r["time"] for r in db.readings(device_id, since=start - BUCKET_S))
        rows = []
        for slot, *values in readings_from_history(history, board["entities"]):
            i = bisect.bisect_left(have, slot - BUCKET_S / 2)
            if i < len(have) and have[i] < slot + BUCKET_S / 2:
                continue  # the app has a reading in this slot already
            rows.append((device_id, slot, *values))
        db.add_readings(rows)
        result["imported"] = len(rows)
    return results
