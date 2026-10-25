"""The app's database (SQLite, in the user's data folder): devices, images and update history."""

import sqlite3
import threading
import time

SCHEMA = """
CREATE TABLE IF NOT EXISTS devices (
    device_id     TEXT PRIMARY KEY,
    name          TEXT NOT NULL DEFAULT '',
    address       TEXT NOT NULL DEFAULT '',   -- IPv6 address (over the air)
    serial_port   TEXT NOT NULL DEFAULT '',   -- last USB serial port it was seen on
    fw_version    TEXT NOT NULL DEFAULT '',   -- git commit, from 'info'
    hw_version    TEXT NOT NULL DEFAULT '',
    image_version TEXT NOT NULL DEFAULT '',   -- MCUboot version of the running image (mcumgr)
    image_hash    TEXT NOT NULL DEFAULT '',   -- SHA-256 of the running image (mcumgr)
    soil_moisture INTEGER,
    battery       INTEGER,
    air_humidity  INTEGER,
    temperature   INTEGER,
    last_seen     REAL,                       -- last answer to anything
    last_error    TEXT NOT NULL DEFAULT '',
    notes         TEXT NOT NULL DEFAULT '',
    added         REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS images (
    hash     TEXT PRIMARY KEY,
    version  TEXT NOT NULL,
    filename TEXT NOT NULL,
    size     INTEGER NOT NULL,
    notes    TEXT NOT NULL DEFAULT '',
    added    REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS updates (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id        TEXT NOT NULL,
    device_id     TEXT NOT NULL,
    transport     TEXT NOT NULL,
    image_hash    TEXT NOT NULL,
    image_version TEXT NOT NULL,
    started       REAL NOT NULL,
    finished      REAL,
    result        TEXT NOT NULL,              -- updated, already-current, failed, cancelled, skipped
    message       TEXT NOT NULL DEFAULT ''
);
"""

DEVICE_FIELDS = ("name", "address", "serial_port", "fw_version", "hw_version", "image_version", "image_hash",
                 "soil_moisture", "battery", "air_humidity", "temperature", "last_seen", "last_error", "notes")


class Database:
    def __init__(self, path):
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(str(path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.executescript(SCHEMA)
            self._conn.commit()

    def close(self):
        with self._lock:
            self._conn.close()

    def _query(self, sql, params=()):
        with self._lock:
            return [dict(row) for row in self._conn.execute(sql, params).fetchall()]

    def _execute(self, sql, params=()):
        with self._lock:
            cursor = self._conn.execute(sql, params)
            self._conn.commit()
            return cursor

    # ------------------------------------------------------------ devices

    def devices(self):
        return self._query("SELECT * FROM devices ORDER BY name, device_id")

    def device(self, device_id):
        rows = self._query("SELECT * FROM devices WHERE device_id = ?", (device_id,))
        return rows[0] if rows else None

    def device_by_address(self, address):
        rows = self._query("SELECT * FROM devices WHERE address = ?", (address,))
        return rows[0] if rows else None

    def upsert_device(self, device_id, **fields):
        """Adds the device if it's new, then sets the given fields. Returns the device."""
        unknown = set(fields) - set(DEVICE_FIELDS)
        if unknown:
            raise ValueError(f"unknown device fields: {sorted(unknown)}")
        with self._lock:
            self._conn.execute("INSERT OR IGNORE INTO devices (device_id, added) VALUES (?, ?)",
                               (device_id, time.time()))
            if fields:
                assignments = ", ".join(f"{name} = ?" for name in fields)
                self._conn.execute(f"UPDATE devices SET {assignments} WHERE device_id = ?",
                                   (*fields.values(), device_id))
            self._conn.commit()
        return self.device(device_id)

    def delete_device(self, device_id):
        return self._execute("DELETE FROM devices WHERE device_id = ?", (device_id,)).rowcount > 0

    # ------------------------------------------------------------ images

    def images(self):
        return self._query("SELECT * FROM images ORDER BY added DESC")

    def image(self, image_hash):
        rows = self._query("SELECT * FROM images WHERE hash = ?", (image_hash,))
        return rows[0] if rows else None

    def add_image(self, image_hash, version, filename, size, notes=""):
        self._execute("INSERT OR REPLACE INTO images (hash, version, filename, size, notes, added) "
                      "VALUES (?, ?, ?, ?, ?, ?)", (image_hash, version, filename, size, notes, time.time()))
        return self.image(image_hash)

    def delete_image(self, image_hash):
        return self._execute("DELETE FROM images WHERE hash = ?", (image_hash,)).rowcount > 0

    # ------------------------------------------------------------ update history

    def add_update(self, job_id, device_id, transport, image_hash, image_version, started, finished, result, message):
        self._execute("INSERT INTO updates (job_id, device_id, transport, image_hash, image_version, started, "
                      "finished, result, message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                      (job_id, device_id, transport, image_hash, image_version, started, finished, result, message))

    def updates(self, device_id=None, limit=200):
        if device_id is None:
            return self._query("SELECT * FROM updates ORDER BY id DESC LIMIT ?", (limit,))
        return self._query("SELECT * FROM updates WHERE device_id = ? ORDER BY id DESC LIMIT ?", (device_id, limit))
