"""Keeping the data folder in bounds: how much each part takes, and deleting what's older
than the settings keep (readings, network history, backups)."""

import time
from pathlib import Path

DAY = 86400
PARTS = (("database", ("manager.db", "manager.db-wal", "manager.db-journal")), ("images", ("images",)),
         ("photos", ("photos",)), ("backups", ("backups",)), ("builds", ("builds",)))


def _size(path):
    path = Path(path)
    if path.is_file():
        return path.stat().st_size
    if path.is_dir():
        return sum(p.stat().st_size for p in path.rglob("*") if p.is_file())
    return 0


def usage(data_dir, db):
    """Bytes per part of the data folder, the total, and the rows of the big tables."""
    data_dir = Path(data_dir)
    parts = {name: sum(_size(data_dir / item) for item in items) for name, items in PARTS}
    total = _size(data_dir)
    parts["other"] = max(0, total - sum(parts.values()))
    return {"parts": parts, "total": total, "rows": db.counts()}


def prune(db, settings, now=None):
    """Deletes what's older than the settings keep. Returns {rows, network} removed."""
    now = now or time.time()
    rows = db.prune(now - settings.keep_readings_days * DAY) if settings.keep_readings_days > 0 else 0
    network = db.keep_network_snapshots(max(settings.keep_network_readings, 2))
    return {"rows": rows, "network": network}
