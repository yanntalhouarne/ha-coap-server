"""The weekly summary: what happened to the fleet over a period (a week by default), as one
printable page. Plants and their waterings, batteries and how fast they went down, alerts,
updates and the network's parent changes."""

import time

from . import fleet

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


def build(db, inventory, settings, days=7, end=None):
    end = end or time.time()
    start = end - days * DAY
    activity = db.activity_between(start, end)
    plants, batteries = [], []
    for device in inventory.devices():
        device_id = device["device_id"]
        readings = db.readings_between(device_id, start, end)
        name = device["name"] or device_id
        soil = _span([r["soil_moisture"] for r in readings])
        runs = [a for a in activity if a["device_id"] == device_id and a["kind"] == "pump"]
        forecast = fleet.water_forecast(db.readings(device_id, since=end - 14 * DAY), device["water_target"], end)
        plants.append({"device_id": device_id, "name": name, "plant": device["plant"], "photo": device["photo"],
                       "soil": soil, "target": device["water_target"], "needs_water": device["needs_water"],
                       "waterings": len(waterings(readings, runs)), "pump_runs": len(runs),
                       "water_forecast": forecast, "readings": len(readings)})
        battery = _span([r["battery"] for r in readings])
        rate = fleet.drain_rate(readings)
        batteries.append({"device_id": device_id, "name": name, "battery": battery,
                          "per_day": rate["per_day"] if rate else None,
                          "image_version": device["image_version"], "image_hash": device["image_hash"]})
    names = {d["device_id"]: d["name"] or d["device_id"] for d in inventory.devices()}
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
    }
