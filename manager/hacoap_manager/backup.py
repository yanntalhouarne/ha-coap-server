"""Backups of the app's data (one .zip), restoring them, and the device list as CSV.

A backup holds the database (devices, images list, update history, build profiles and
builds), the images themselves, the build profiles' .conf files and the settings. Restoring
replaces all of it, after saving the current data as a backup first.
"""

import csv
import datetime
import io
import ipaddress
import json
import re
import sqlite3
import tempfile
import time
import zipfile
from pathlib import Path

from . import __version__, config

APP_NAME = "hacoap-manager"
AUTO_PREFIX = "auto-"
AUTO_KEEP = 7
MAX_RESTORE_SIZE = 200 * 1024 * 1024
IMAGE_NAME = re.compile(r"images/[0-9a-f]{64}\.bin")
BUILD_CONF_NAME = re.compile(r"builds/build-[0-9]+\.conf")
REQUIRED_TABLES = {"devices", "images", "updates"}


class BackupError(Exception):
    pass


def backups_dir(data_dir):
    folder = Path(data_dir) / "backups"
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def create_backup(data_dir, db, settings):
    """Returns a backup of everything, as the bytes of a .zip file."""
    data_dir = Path(data_dir)
    buffer = io.BytesIO()
    with tempfile.TemporaryDirectory() as tmp:
        copy = Path(tmp) / "manager.db"
        db.backup_to(copy)
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("manifest.json", json.dumps({
                "app": APP_NAME, "version": __version__, "created": time.time(),
                "devices": len(db.devices()), "images": len(db.images())}, indent=2))
            archive.write(copy, "manager.db")
            archive.writestr("settings.json", json.dumps(settings.as_dict(), indent=2))
            for folder in ("images", "builds"):
                for path in sorted((data_dir / folder).glob("*")):
                    if path.is_file():
                        archive.write(path, f"{folder}/{path.name}")
    return buffer.getvalue()


def restore_backup(data, data_dir, db, settings):
    """Replaces the app's data with a backup's. Returns what was restored."""
    data_dir = Path(data_dir)
    if len(data) > MAX_RESTORE_SIZE:
        raise BackupError("The file is too large to be a backup")
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
        names = set(archive.namelist())
        manifest = json.loads(archive.read("manifest.json")) if "manifest.json" in names else {}
    except (zipfile.BadZipFile, ValueError, KeyError) as exc:
        raise BackupError(f"Not a backup of this app ({exc})") from exc
    if manifest.get("app") != APP_NAME or "manager.db" not in names:
        raise BackupError("Not a backup of this app")

    with tempfile.TemporaryDirectory() as tmp:
        restored_db = Path(tmp) / "manager.db"
        restored_db.write_bytes(archive.read("manager.db"))
        check = sqlite3.connect(str(restored_db))
        try:
            tables = {r[0] for r in check.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        except sqlite3.DatabaseError as exc:
            raise BackupError(f"The backup's database is damaged ({exc})") from exc
        finally:
            check.close()  # before the folder is deleted (Windows keeps open files locked)
        if not REQUIRED_TABLES <= tables:
            raise BackupError("The backup's database is missing tables")

        # Save what's there now, in case this wasn't what was wanted.
        safety = backups_dir(data_dir) / f"before-restore-{time.strftime('%Y%m%d-%H%M%S')}.zip"
        safety.write_bytes(create_backup(data_dir, db, settings))

        db.restore_from(restored_db)

    for folder, pattern in (("images", IMAGE_NAME), ("builds", BUILD_CONF_NAME)):
        target = data_dir / folder
        target.mkdir(parents=True, exist_ok=True)
        for path in target.glob("*"):
            if path.is_file():
                path.unlink()
        for name in names:
            if pattern.fullmatch(name):  # only these names: nothing can land outside the data folder
                (target / Path(name).name).write_bytes(archive.read(name))

    if "settings.json" in names:
        try:
            settings.update(json.loads(archive.read("settings.json")))
        except (ValueError, TypeError):
            pass
        config.save_settings(data_dir, settings)
    return {"devices": len(db.devices()), "images": len(db.images()), "safety_backup": safety.name,
            "created": manifest.get("created")}


def auto_backup(data_dir, db, settings, keep=AUTO_KEEP, min_age_hours=20):
    """Writes a daily backup in the data folder's backups/ (keeping the last 'keep').
    Returns its path, or None if the last one is recent."""
    folder = backups_dir(data_dir)
    existing = sorted(folder.glob(f"{AUTO_PREFIX}*.zip"))
    if existing and time.time() - existing[-1].stat().st_mtime < min_age_hours * 3600:
        return None
    path = folder / f"{AUTO_PREFIX}{time.strftime('%Y%m%d-%H%M%S')}.zip"
    path.write_bytes(create_backup(data_dir, db, settings))
    for old in sorted(folder.glob(f"{AUTO_PREFIX}*.zip"))[:-keep]:
        old.unlink()
    return path


def list_backups(data_dir):
    return [{"name": p.name, "size": p.stat().st_size, "created": p.stat().st_mtime}
            for p in sorted(backups_dir(data_dir).glob("*.zip"), key=lambda p: p.stat().st_mtime, reverse=True)]


def backup_path(data_dir, name):
    """A saved backup by name, or None (only plain names from list_backups())."""
    if not re.fullmatch(r"[A-Za-z0-9_.-]+\.zip", name):
        return None
    path = backups_dir(data_dir) / name
    return path if path.is_file() else None


# ---------------------------------------------------------------- devices as CSV

CSV_COLUMNS = ["device_id", "name", "address", "notes", "fw_version", "hw_version", "image_version",
               "battery", "soil_moisture", "air_humidity", "temperature", "last_seen"]
DEVICE_ID = re.compile(r"[A-Za-z0-9_-]{1,32}")


def devices_csv(db):
    out = io.StringIO()
    writer = csv.DictWriter(out, CSV_COLUMNS, extrasaction="ignore", lineterminator="\n")
    writer.writeheader()
    for device in db.devices():
        row = dict(device)
        if row.get("last_seen"):
            row["last_seen"] = datetime.datetime.fromtimestamp(row["last_seen"]).isoformat(timespec="seconds")
        writer.writerow(row)
    return out.getvalue()


def import_devices_csv(text, db):
    """Adds or updates devices from CSV: device_id, and optionally name, address and notes
    (other columns are ignored: they come from the devices themselves). Returns counts."""
    reader = csv.DictReader(io.StringIO(text.lstrip("﻿")))
    if not reader.fieldnames or "device_id" not in reader.fieldnames:
        raise BackupError("The CSV needs a device_id column")
    added = updated = 0
    for line, row in enumerate(reader, start=2):
        device_id = (row.get("device_id") or "").strip()
        if not DEVICE_ID.fullmatch(device_id):
            raise BackupError(f"Line {line}: invalid device_id {device_id!r}")
        fields = {}
        for name in ("name", "notes"):
            if row.get(name) is not None:
                fields[name] = row[name].strip()[:200]
        address = (row.get("address") or "").strip()
        if address:
            try:
                ipaddress.ip_address(address)
            except ValueError:
                raise BackupError(f"Line {line}: invalid address {address!r}") from None
            fields["address"] = address
        existed = db.device(device_id) is not None
        db.upsert_device(device_id, **fields)
        updated += existed
        added += not existed
    return {"added": added, "updated": updated}
