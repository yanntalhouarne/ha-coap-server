"""The weekly summary: what happened to the fleet over a period (a week by default), as one
printable page. Plants and their waterings (and how, the water used, their care), batteries and
how fast they went down, how long each board was offline, alerts, updates, the network's parent
changes, and who did what from the app."""

import time

from . import fleet
from .naming import display_name

DAY = 86400


def _span(values):
    values = [v for v in values if v is not None]
    return {"min": min(values), "max": max(values), "first": values[0], "last": values[-1]} if values else None


def waterings(readings, pump_runs):
    """When the plant got water: the soil jumping up, and the pump runs started from the app
    (one counted once when both show it)."""
    points = [(r["time"], r["soil_moisture"]) for r in readings if r.get("soil_moisture") is not None]
    times = [t for (_, a), (t, b) in zip(points, points[1:]) if b > a + fleet.WATERING_RISE]
    for run in pump_runs:
        if not any(0 <= t - run["time"] <= 3 * 3600 for t in times):
            times.append(run["time"])
    return sorted(times)


def offline_time(alerts, start, end, now, grace_s=0):
    """How long a board was offline between two times (s), from its 'offline' alerts: from
    'grace_s' before each was raised (it's raised once the board was quiet that long) until it
    cleared (a dismissed one: until its condition ended)."""
    total = 0.0
    for alert in alerts:
        stop = alert["ended"] if alert["dismissed"] else alert["cleared"]
        begin, finish = max(alert["raised"] - grace_s, start), min(stop or now, end)
        total += max(0.0, finish - begin)
    return total


def done_by(activity):
    """Who did what from the app over the period: [{by, count}], the most first. What the
    boards report (restarts, power) has no one, and isn't counted."""
    counts = {}
    for row in activity:
        if row.get("actor"):
            counts[row["actor"]] = counts.get(row["actor"], 0) + 1
    return [{"by": by, "count": n} for by, n in sorted(counts.items(), key=lambda item: (-item[1], item[0]))]


def build(db, inventory, settings, days=7, end=None):
    end = end or time.time()
    start = end - days * DAY
    activity = db.activity_between(start, end)
    offline_alerts = db.alerts_overlapping("offline", start, end)
    plants, batteries = [], []
    for device in inventory.devices():
        device_id = device["device_id"]
        readings = db.readings_between(device_id, start, end)
        name = display_name(device)
        soil = _span([r["soil_moisture"] for r in readings])
        runs = [a for a in activity if a["device_id"] == device_id and a["kind"] == "pump"]
        forecast = fleet.water_forecast(db.readings(device_id, since=end - 14 * DAY), device["water_target"], end)
        report = fleet.watering_report(readings, runs, end, days)
        seconds = sum(seconds for _, seconds in fleet.pump_runs(runs))
        mine = [a for a in activity if a["device_id"] == device_id]
        plants.append({"device_id": device_id, "name": name, "plant": device["plant"], "photo": device["photo"],
                       "soil": soil, "target": device["water_target"], "needs_water": device["needs_water"],
                       "waterings": len(waterings(readings, runs)), "pump_runs": len(runs),
                       "by": report["waterings"],  # how: automatic, from the app, its button, by hand
                       "water_ml": round(seconds * (device["pump_ml_s"] or settings.pump_flow_ml_s)),
                       "refills": sum(1 for a in mine if a["kind"] == "tank"),
                       "care_done": [a["message"][len("Done: "):] for a in mine
                                     if a["kind"] == "care" and a["message"].startswith("Done: ")],
                       "water_forecast": forecast, "readings": len(readings)})
        battery = _span([r["battery"] for r in readings])
        rate = fleet.drain_rate(readings)
        offline = offline_time([a for a in offline_alerts if a["device_id"] == device_id], start, end, time.time(),
                               settings.online_minutes * 60)
        batteries.append({"device_id": device_id, "name": name, "battery": battery,
                          "per_day": rate["per_day"] if rate else None, "offline_s": offline,
                          "image_version": device["image_version"], "image_hash": device["image_hash"]})
    names = {d["device_id"]: display_name(d) for d in inventory.devices()}
    updates = db.updates_between(start, end)
    return {
        "start": start, "end": end, "days": days,
        "devices": len(plants), "online": sum(1 for d in inventory.devices() if d["online"]),
        "plants": sorted(plants, key=lambda p: p["name"].lower()),
        "batteries": sorted(batteries, key=lambda b: (b["battery"] or {}).get("last", 101)),
        "drain_by_image": fleet.drain_by_image(db, inventory, end),
        "alerts": [{**a, "name": names.get(a["device_id"], a["device_id"])} for a in db.alerts_between(start, end)],
        "updates": [{**u, "name": names.get(u["device_id"], u["device_id"])} for u in updates],
        "parent_changes": [{**e, "name": names.get(e["device_id"], e["device_id"])}
                           for e in db.network_events_between(start, end)],
        "network_readings": sum(1 for s in db.network_snapshots() if start <= s["time"] < end),
        "done_by": done_by(activity),
    }
