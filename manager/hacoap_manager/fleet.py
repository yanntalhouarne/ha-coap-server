"""Fleet health: battery forecasts, which devices run the release image, and the dashboard."""

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


def image_status(device, release):
    """'current', 'outdated' or 'unknown' (slots never read), compared with the release image."""
    if release is None:
        return "no-release"
    if not device.get("image_hash"):
        return "unknown"
    return "current" if device["image_hash"] == release["hash"] else "outdated"


def device_health(db, device, release, now=None):
    now = now or time.time()
    readings = db.readings(device["device_id"], since=now - FORECAST_WINDOW_DAYS * DAY)
    return {"image_status": image_status(device, release), "battery_forecast": battery_forecast(readings)}


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


def dashboard(db, inventory, topology):
    devices = inventory.devices()
    release = db.release_image()
    images = {i["hash"]: i for i in db.images()}
    by_image = {}
    outdated, unknown, low, offline = [], [], [], []
    for device in devices:
        health = device_health(db, device, release)
        entry = {"device_id": device["device_id"], "name": device["name"] or device["device_id"],
                 "battery": device["battery"], "last_seen": device["last_seen"], "online": device["online"],
                 "image_version": device["image_version"], "image_hash": device["image_hash"],
                 "battery_forecast": health["battery_forecast"], "tags": device["tags"]}
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
    low.sort(key=lambda e: (e["battery_forecast"] or {}).get("days_left", e["battery"] or 0))
    return {
        "counts": {"devices": len(devices), "online": sum(1 for d in devices if d["online"]),
                   "outdated": len(outdated), "unknown": len(unknown), "low_battery": len(low)},
        "release": release,
        "firmware": sorted(by_image.values(), key=lambda g: -g["count"]),
        "outdated": outdated,
        "unknown": unknown,
        "low_battery": low,
        "offline": offline,
        "weak_links": weak_links(topology)[:10],
        "recent_updates": db.updates(limit=8),
        "network_read": topology.get("fetched") if topology else None,
    }
