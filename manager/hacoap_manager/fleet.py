"""Fleet health: battery forecasts, which devices run the release image, which plants need
water, and the dashboard."""

import re
import time

DAY = 86400
FORECAST_WINDOW_DAYS = 14   # battery readings used for the forecast
LOW_BATTERY = 20            # %
WEAK_MARGIN_DB = 10         # a link margin under this is weak (link quality 1 or less)


def battery_forecast(readings, empty_at=0):
    """Days until the battery reaches 'empty_at' %, from the trend of the readings (a
    least-squares line through battery % against time). None without a clear downward trend:
    fewer than 3 readings, less than 6 hours of them, or a flat or rising battery (charging)."""
    points = [(r["time"], r["battery"]) for r in readings if r.get("battery") is not None]
    if len(points) < 3 or points[-1][0] - points[0][0] < 6 * 3600:
        return None
    n = len(points)
    mean_t = sum(t for t, _ in points) / n
    mean_b = sum(b for _, b in points) / n
    spread = sum((t - mean_t) ** 2 for t, _ in points)
    if spread == 0:
        return None
    slope = sum((t - mean_t) * (b - mean_b) for t, b in points) / spread  # % per second
    per_day = slope * DAY
    if per_day > -0.02:  # flat, rising, or too slow to call
        return None
    latest = points[-1][1]
    return {"days_left": max(0.0, (latest - empty_at) / -per_day), "per_day": per_day}


def _slope(points):
    """Least-squares slope of (time, value) points, per second, or None."""
    n = len(points)
    mean_t = sum(t for t, _ in points) / n
    mean_v = sum(v for _, v in points) / n
    spread = sum((t - mean_t) ** 2 for t, _ in points)
    return sum((t - mean_t) * (v - mean_v) for t, v in points) / spread if spread else None


def drain_rate(readings):
    """Battery % lost per day over these readings: {per_day, days, readings}, or None without
    enough of them. A jump between two readings splits them into runs: a rise of more than 2 %
    (charging), or a fall faster than 5 %/day plus 2 % (the reading drops when the charger is
    unplugged). Each run of 3 readings or more over 6 hours or more counts, weighted by its length."""
    points = [(r["time"], r["battery"]) for r in readings if r.get("battery") is not None]
    runs, run = [], []
    for point in points:
        if run and (point[1] > run[-1][1] + 2 or point[1] < run[-1][1] - 2 - 5 * (point[0] - run[-1][0]) / DAY):
            runs.append(run)
            run = []
        run.append(point)
    runs.append(run)
    weighted, span_total, used = 0.0, 0.0, 0
    for run in runs:
        span = run[-1][0] - run[0][0] if run else 0
        slope = _slope(run) if len(run) >= 3 and span >= 6 * 3600 else None
        if slope is not None:
            weighted += -slope * DAY * span
            span_total += span
            used += len(run)
    if not span_total:
        return None
    return {"per_day": weighted / span_total, "days": span_total / DAY, "readings": used}


UPDATE_SETTLE_S = 2 * 3600  # readings this soon after an update are left out (the update itself draws power)


def image_periods(device, updates):
    """[(image_hash, version, start, end)]: which image the device ran when, from its successful
    updates (end None: still running). Before the first one, the image isn't known (hash None).
    Without any update, all of it is the image it runs now."""
    done = sorted((u for u in updates if u["result"] == "updated" and u["finished"]), key=lambda u: u["finished"])
    if not done:
        return [(device.get("image_hash") or None, device.get("image_version"), 0, None)]
    periods = [(None, None, 0, done[0]["finished"])]
    for i, update in enumerate(done):
        end = done[i + 1]["finished"] if i + 1 < len(done) else None
        periods.append((update["image_hash"], update["image_version"], update["finished"], end))
    return periods


def battery_drain(db, device, now=None, days=180):
    """The battery drain under each image the device ran: [{image_hash, version, start, end, rate}]."""
    now = now or time.time()
    readings = db.readings(device["device_id"], since=now - days * DAY)
    result = []
    for image_hash, version, start, end in image_periods(device, db.updates(device["device_id"], limit=500)):
        settle = start + UPDATE_SETTLE_S if start else 0
        part = [r for r in readings if r["time"] >= settle and (end is None or r["time"] < end)]
        if part:
            result.append({"image_hash": image_hash, "version": version, "start": part[0]["time"],
                           "end": end, "rate": drain_rate(part)})
    return result


def drain_by_image(db, inventory, now=None):
    """The fleet's battery drain per image: [{image_hash, version, release, devices: [{device_id,
    name, per_day}], median, days_full}], the image with the most devices first."""
    images = {i["hash"]: i for i in db.images()}
    release = db.release_image()
    groups = {}
    for device in inventory.devices():
        for period in battery_drain(db, device, now):
            if period["rate"] is None or not period["image_hash"]:
                continue
            group = groups.setdefault(period["image_hash"], {
                "image_hash": period["image_hash"],
                "version": period["version"] or images.get(period["image_hash"], {}).get("version") or "",
                "release": bool(release and release["hash"] == period["image_hash"]), "devices": []})
            group["devices"].append({"device_id": device["device_id"], "name": device["name"] or device["device_id"],
                                     "per_day": period["rate"]["per_day"], "days": period["rate"]["days"]})
    for group in groups.values():
        rates = sorted(d["per_day"] for d in group["devices"])
        middle = len(rates) // 2
        group["median"] = rates[middle] if len(rates) % 2 else (rates[middle - 1] + rates[middle]) / 2
        group["days_full"] = 100 / group["median"] if group["median"] > 0.01 else None
    return sorted(groups.values(), key=lambda g: -len(g["devices"]))


def water_target(device, settings):
    """The soil moisture % under which the device's plant needs water, or None (not watched):
    its own target, else the default."""
    target = device.get("water_below")
    if target is None:
        target = settings.water_below_default
    return target or None


def needs_water(device, settings):
    target = water_target(device, settings)
    return target is not None and device.get("soil_moisture") is not None and device["soil_moisture"] < target


WATERING_RISE = 5        # % of soil moisture up between two readings: the plant was watered
SOON_DAYS = 3            # plants that will need water within this many days are listed as "soon"


def _soil_points(readings):
    return [(r["time"], r["soil_moisture"]) for r in readings if r.get("soil_moisture") is not None]


def water_forecast(readings, target, now=None):
    """When the soil will be under 'target' % at the rate it has dried since its last watering:
    {days (0: already), per_day, soil}, with days None when it isn't drying. None without a
    target, or without 3 readings over 6 hours since the last watering."""
    if not target:
        return None
    now = now or time.time()
    points = _soil_points(readings)
    start = 0
    for i in range(1, len(points)):
        if points[i][1] > points[i - 1][1] + WATERING_RISE:
            start = i            # watered: only the drying since counts
    run = points[start:]
    if len(run) < 3 or run[-1][0] - run[0][0] < 6 * 3600:
        return None
    per_day = -_slope(run) * DAY
    soil = run[-1][1]
    if soil < target:
        return {"days": 0, "per_day": per_day, "soil": soil}
    if per_day < 0.5:            # flat, or rising: no forecast
        return {"days": None, "per_day": per_day, "soil": soil}
    days = (soil - target) / per_day - (now - run[-1][0]) / DAY
    return {"days": max(0.0, days), "per_day": per_day, "soil": soil}


SECONDS = re.compile(r"\((\d+) s\)")


def pump_effect(readings, activity, window_s=3 * 3600):
    """How much the soil rose after the pump runs started from the app: {runs, rise (average %),
    seconds (their usual run time)}, or None without a measurable one."""
    points = _soil_points(readings)
    rises, durations = [], []
    for run in (a for a in activity if a["kind"] == "pump"):
        before = [v for t, v in points if t <= run["time"]]
        after = [v for t, v in points if run["time"] < t <= run["time"] + window_s]
        if before and after:
            rises.append(max(after) - before[-1])
            found = SECONDS.search(run.get("message", ""))
            if found:
                durations.append(int(found.group(1)))
    if not rises:
        return None
    return {"runs": len(rises), "rise": sum(rises) / len(rises),
            "seconds": max(set(durations), key=durations.count) if durations else None}


def image_status(device, release):
    """'current', 'outdated' or 'unknown' (slots never read), compared with the release image."""
    if release is None:
        return "no-release"
    if not device.get("image_hash"):
        return "unknown"
    return "current" if device["image_hash"] == release["hash"] else "outdated"


def device_health(db, device, release, now=None, target=None):
    """The image status, the battery forecast and the watering forecast ('target': the device's
    watering target; its water_target when it's described)."""
    now = now or time.time()
    readings = db.readings(device["device_id"], since=now - FORECAST_WINDOW_DAYS * DAY)
    target = target if target is not None else device.get("water_target")
    return {"image_status": image_status(device, release), "battery_forecast": battery_forecast(readings),
            "water_forecast": water_forecast(readings, target, now)}


def weak_links(topology):
    """The boards' and routers' weakest links in the last network reading."""
    if not topology:
        return []
    nodes = {n["id"]: n for n in topology["nodes"]}
    result = []
    for link in topology["links"]:
        margin, quality = link.get("link_margin"), link.get("link_quality_in")
        weak = (margin is not None and margin < WEAK_MARGIN_DB) or \
            (margin is None and quality is not None and quality <= 1)
        if weak:
            a, b = nodes.get(link["a"], {}), nodes.get(link["b"], {})
            label = lambda n: n.get("name") or (n.get("rloc16_hex") or "?")  # noqa: E731
            result.append({"from": label(a), "to": label(b), "kind": link["kind"], "link_margin": margin,
                           "link_quality": quality, "average_rssi": link.get("average_rssi"),
                           "device_id": a.get("device_id") or b.get("device_id")})
    result.sort(key=lambda w: (w["link_margin"] if w["link_margin"] is not None else (w["link_quality"] or 0) * 10))
    return result


def wall(db, inventory, now=None):
    """The wall display: every plant with its photo, soil, target, forecasts and battery; the ones
    that need water first, then the soonest to."""
    now = now or time.time()
    plants = []
    for device in inventory.devices():
        readings = db.readings(device["device_id"], since=now - FORECAST_WINDOW_DAYS * DAY)
        plants.append({"device_id": device["device_id"], "name": device["name"] or device["device_id"],
                       "plant": device["plant"], "location": device["location"], "photo": device["photo"],
                       "soil_moisture": device["soil_moisture"], "water_target": device["water_target"],
                       "needs_water": device["needs_water"], "battery": device["battery"], "online": device["online"],
                       "water_forecast": water_forecast(readings, device["water_target"], now),
                       "battery_forecast": battery_forecast(readings)})
    soon = lambda p: (p["water_forecast"] or {}).get("days")  # noqa: E731
    plants.sort(key=lambda p: (not p["needs_water"], soon(p) is None, soon(p) or 0, p["name"].lower()))
    return plants


def dashboard(db, inventory, topology):
    devices = inventory.devices()
    release = db.release_image()
    images = {i["hash"]: i for i in db.images()}
    by_image = {}
    outdated, unknown, low, offline, dry, soon = [], [], [], [], [], []
    names = {d["device_id"]: d["name"] or d["device_id"] for d in devices}
    for device in devices:
        health = device_health(db, device, release)
        entry = {"device_id": device["device_id"], "name": device["name"] or device["device_id"],
                 "battery": device["battery"], "last_seen": device["last_seen"], "online": device["online"],
                 "image_version": device["image_version"], "image_hash": device["image_hash"],
                 "battery_forecast": health["battery_forecast"], "tags": device["tags"], "plant": device["plant"],
                 "photo": device["photo"], "soil_moisture": device["soil_moisture"],
                 "water_target": device["water_target"], "water_forecast": health["water_forecast"]}
        key = device["image_hash"] or ""
        group = by_image.setdefault(key, {"image_hash": key, "version": device["image_version"],
                                          "notes": images.get(key, {}).get("notes", ""), "count": 0,
                                          "release": bool(release and key == release["hash"])})
        group["count"] += 1
        if health["image_status"] == "outdated":
            outdated.append(entry)
        elif health["image_status"] == "unknown":
            unknown.append(entry)
        forecast = health["battery_forecast"]
        if (device["battery"] is not None and device["battery"] <= LOW_BATTERY) or \
                (forecast and forecast["days_left"] < 30):
            low.append(entry)
        if not device["online"]:
            offline.append(entry)
        if device["needs_water"]:
            dry.append(entry)
        elif (health["water_forecast"] or {}).get("days") is not None and health["water_forecast"]["days"] <= SOON_DAYS:
            soon.append(entry)
    dry.sort(key=lambda e: e["soil_moisture"] - e["water_target"])  # the driest first
    low.sort(key=lambda e: (e["battery_forecast"] or {}).get("days_left", e["battery"] or 0))
    soon.sort(key=lambda e: e["water_forecast"]["days"])
    return {
        "counts": {"devices": len(devices), "online": sum(1 for d in devices if d["online"]),
                   "outdated": len(outdated), "unknown": len(unknown), "low_battery": len(low),
                   "needs_water": len(dry)},
        "release": release,
        "firmware": sorted(by_image.values(), key=lambda g: -g["count"]),
        "outdated": outdated,
        "unknown": unknown,
        "low_battery": low,
        "offline": offline,
        "needs_water": dry,
        "water_soon": soon,
        "weak_links": weak_links(topology)[:10],
        "recent_updates": [{**u, "name": names.get(u["device_id"], u["device_id"])} for u in db.updates(limit=8)],
        "network_read": topology.get("fetched") if topology else None,
    }
