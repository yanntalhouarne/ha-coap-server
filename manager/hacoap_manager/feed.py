"""The activity feed: everything that happened, newest first, in one list: updates, alerts,
parent changes, what the app did to a board (pump runs, settings) and its restarts, plant
photos and builds."""

from .alerts import NAME

# Each source: (table, its time column, the columns it brings). Only these tables are read.
SOURCES = {
    "update": ("updates", "finished", "device_id, image_version, result, message"),
    "alert": ("alerts", "raised", "device_id, kind, message"),
    "parent": ("network_events", "time", "device_id, message"),
    "activity": ("activity", "time", "device_id, kind, message"),  # its own kind: pump, restart, settings
    "build": ("builds", "finished", "profile, variant, result"),
}


def _text(kind, row, name):
    if kind == "update":
        if row["result"] == "updated":
            return f"{name} updated to v{row['image_version']}"
        if row["result"] == "failed":
            return f"Update of {name} to v{row['image_version']} failed: {row['message']}"
        return f"{name}: update {row['result']} ({row['message']})"
    if kind == "build":
        return f"Build of {row['profile']} ({row['variant']}): {row['result']}"
    if kind == "activity":
        return f"{name}: {row['message'][0].lower()}{row['message'][1:]}" if row["message"] else f"{name}: {row['kind']}"
    return row["message"].replace(NAME, name)  # alerts are stored with a {name} placeholder


def build(db, inventory, photos, before=None, limit=30):
    """[{time, kind, text, device_id, name}], newest first, older than 'before' (a time; all if None)."""
    before = before or float("inf")
    names = {d["device_id"]: d["name"] or d["device_id"] for d in inventory.devices()}
    entries = []
    for kind, (table, column, columns) in SOURCES.items():
        for row in db.recent(table, column, columns, before, limit):
            device_id = row.get("device_id") or ""
            name = names.get(device_id, device_id)
            entries.append({"time": row["time"], "kind": row["kind"] if kind == "activity" else kind,
                            "text": _text(kind, row, name), "device_id": device_id, "name": name})
    for device_id, name in names.items():
        try:
            taken = photos.timeline(device_id)
        except Exception:  # noqa: BLE001 - an unusual ID: no photos
            continue
        entries += [{"time": t, "kind": "photo", "text": f"Photo of {name}", "device_id": device_id, "name": name}
                    for t in taken if t < before]
    entries.sort(key=lambda e: -e["time"])
    return entries[:limit]


def device_timeline(db, device, photos, limit=300):
    """Everything that happened to one board, newest first: [{time, kind, text, detail}]. The
    kinds: update (and failed), restart, pump, settings, network (its parent, or its network
    forgotten), photo, alert."""
    device_id = device["device_id"]
    name = device["name"] or device_id
    entries = []
    for row in db.updates(device_id, limit=limit):
        if not row["finished"]:
            continue
        entries.append({"time": row["finished"], "kind": "update", "text": _text("update", row, name),
                        "detail": {"result": row["result"], "transport": row["transport"],
                                   "version": row["image_version"], "hash": row["image_hash"], "message": row["message"]}})
    for row in db.device_activity(device_id, limit):
        entries.append({"time": row["time"], "kind": row["kind"], "text": row["message"], "detail": None})
    for row in db.network_events_for(device_id, limit):
        entries.append({"time": row["time"], "kind": "parent", "text": row["message"].replace(f"{name}: ", ""), "detail": None})
    for row in db.device_alerts(device_id, limit):
        entries.append({"time": row["raised"], "kind": "alert", "text": row["message"].replace(NAME, name),
                        "detail": {"cleared": row["cleared"], "alert_kind": row["kind"]}})
    try:
        entries += [{"time": t, "kind": "photo", "text": "A photo of the plant", "detail": None}
                    for t in photos.timeline(device_id)]
    except Exception:  # noqa: BLE001 - an unusual ID: no photos
        pass
    entries.sort(key=lambda e: -e["time"])
    return entries[:limit]
