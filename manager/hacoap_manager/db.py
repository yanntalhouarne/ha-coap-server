"""The app's database (SQLite, in the user's data folder): devices and their history, images,
update history, build profiles and builds, and the network's floor plan."""

import json
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
    added         REAL NOT NULL,
    tags          TEXT NOT NULL DEFAULT '',   -- comma-separated groups, such as "greenhouse"
    location      TEXT NOT NULL DEFAULT '',
    plant         TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS images (
    hash     TEXT PRIMARY KEY,
    version  TEXT NOT NULL,
    filename TEXT NOT NULL,
    size     INTEGER NOT NULL,
    notes    TEXT NOT NULL DEFAULT '',
    added    REAL NOT NULL,
    git_commit TEXT NOT NULL DEFAULT '',      -- the firmware's git commit, when known
    release  INTEGER NOT NULL DEFAULT 0       -- 1 for the image the fleet should run
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
CREATE TABLE IF NOT EXISTS profiles (
    name     TEXT PRIMARY KEY,
    variant  TEXT NOT NULL,
    settings TEXT NOT NULL,                    -- JSON: {Kconfig symbol: value}, only the changed ones
    notes    TEXT NOT NULL DEFAULT '',
    updated  REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS network_events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    time      REAL NOT NULL,
    device_id TEXT NOT NULL,
    message   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS readings (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id     TEXT NOT NULL,
    time          REAL NOT NULL,
    battery       INTEGER,
    soil_moisture INTEGER,
    air_humidity  INTEGER,
    temperature   INTEGER
);
CREATE INDEX IF NOT EXISTS readings_device_time ON readings (device_id, time);
CREATE TABLE IF NOT EXISTS link_samples (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id    TEXT NOT NULL,
    time         REAL NOT NULL,
    parent       TEXT NOT NULL,                -- the parent's RLOC16, such as 0x5000
    link_margin  INTEGER,                      -- dB, when the border router reports it
    average_rssi INTEGER,                      -- dBm
    link_quality INTEGER                       -- 0 to 3
);
CREATE INDEX IF NOT EXISTS link_samples_device_time ON link_samples (device_id, time);
CREATE TABLE IF NOT EXISTS floorplan_positions (
    node_key TEXT PRIMARY KEY,                 -- a device ID, or a router's extended address
    x        REAL NOT NULL,                    -- 0 to 1, across the floor plan picture
    y        REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS builds (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    profile    TEXT NOT NULL,
    variant    TEXT NOT NULL,
    settings   TEXT NOT NULL,                  -- JSON, as built
    started    REAL NOT NULL,
    finished   REAL,
    result     TEXT NOT NULL,                  -- running, done, failed, cancelled
    message    TEXT NOT NULL DEFAULT '',
    image_hash TEXT NOT NULL DEFAULT '',
    signing    TEXT NOT NULL DEFAULT '',       -- private, development, unknown
    log        TEXT NOT NULL DEFAULT ''
);
"""

DEVICE_FIELDS = ("name", "address", "serial_port", "fw_version", "hw_version", "image_version", "image_hash",
                 "soil_moisture", "battery", "air_humidity", "temperature", "last_seen", "last_error", "notes",
                 "tags", "location", "plant")

# Columns added after the first version: (table, column, definition), added to older databases
ADDED_COLUMNS = [
    ("devices", "tags", "TEXT NOT NULL DEFAULT ''"),
    ("devices", "location", "TEXT NOT NULL DEFAULT ''"),
    ("devices", "plant", "TEXT NOT NULL DEFAULT ''"),
    ("images", "git_commit", "TEXT NOT NULL DEFAULT ''"),
    ("images", "release", "INTEGER NOT NULL DEFAULT 0"),
]


class Database:
    def __init__(self, path):
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(str(path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._upgrade()

    def _upgrade(self):
        """Creates missing tables, and adds the columns an older database lacks."""
        for table, column, definition in ADDED_COLUMNS:
            exists = self._conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)).fetchone()
            if exists and column not in {row[1] for row in self._conn.execute(f"PRAGMA table_info({table})")}:
                self._conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
        self._conn.executescript(SCHEMA)
        self._conn.commit()

    def close(self):
        with self._lock:
            self._conn.close()

    def backup_to(self, path):
        """A consistent copy of the database, in a new file."""
        with self._lock:
            target = sqlite3.connect(str(path))
            self._conn.backup(target)
            target.close()

    def restore_from(self, path):
        """Replaces this database's contents with another database file's."""
        with self._lock:
            source = sqlite3.connect(str(path))
            source.backup(self._conn)
            source.close()
            self._upgrade()  # a backup from an older version

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

    def add_image(self, image_hash, version, filename, size, notes="", git_commit=""):
        """Adds an image, or updates its notes (and commit, if given) if it's already there."""
        existing = self.image(image_hash)
        if existing:
            self._execute("UPDATE images SET notes = ?, git_commit = ? WHERE hash = ?",
                          (notes, git_commit or existing["git_commit"], image_hash))
        else:
            self._execute("INSERT INTO images (hash, version, filename, size, notes, added, git_commit) "
                          "VALUES (?, ?, ?, ?, ?, ?, ?)",
                          (image_hash, version, filename, size, notes, time.time(), git_commit))
        return self.image(image_hash)

    def release_image(self):
        rows = self._query("SELECT * FROM images WHERE release = 1")
        return rows[0] if rows else None

    def set_release(self, image_hash):
        """Marks the image the fleet should run (None: no image)."""
        with self._lock:
            self._conn.execute("UPDATE images SET release = 0")
            if image_hash:
                self._conn.execute("UPDATE images SET release = 1 WHERE hash = ?", (image_hash,))
            self._conn.commit()

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

    # ------------------------------------------------------------ build profiles

    @staticmethod
    def _profile(row):
        return {**row, "settings": json.loads(row["settings"])}

    def profiles(self):
        return [self._profile(r) for r in self._query("SELECT * FROM profiles ORDER BY name")]

    def profile(self, name):
        rows = self._query("SELECT * FROM profiles WHERE name = ?", (name,))
        return self._profile(rows[0]) if rows else None

    def save_profile(self, name, variant, settings, notes=""):
        self._execute("INSERT OR REPLACE INTO profiles (name, variant, settings, notes, updated) VALUES (?, ?, ?, ?, ?)",
                      (name, variant, json.dumps(settings), notes, time.time()))
        return self.profile(name)

    def delete_profile(self, name):
        return self._execute("DELETE FROM profiles WHERE name = ?", (name,)).rowcount > 0

    # ------------------------------------------------------------ builds

    BUILD_COLUMNS = "id, profile, variant, settings, started, finished, result, message, image_hash, signing"

    @staticmethod
    def _build(row):
        return {**row, "settings": json.loads(row["settings"])}

    def add_build(self, profile, variant, settings):
        cursor = self._execute("INSERT INTO builds (profile, variant, settings, started, result) VALUES (?, ?, ?, ?, ?)",
                               (profile, variant, json.dumps(settings), time.time(), "running"))
        return cursor.lastrowid

    def build(self, build_id, with_log=False):
        columns = self.BUILD_COLUMNS + (", log" if with_log else "")
        rows = self._query(f"SELECT {columns} FROM builds WHERE id = ?", (build_id,))
        return self._build(rows[0]) if rows else None

    def update_build(self, build_id, **fields):
        assignments = ", ".join(f"{name} = ?" for name in fields)
        self._execute(f"UPDATE builds SET {assignments} WHERE id = ?", (*fields.values(), build_id))
        return self.build(build_id)

    def builds(self, limit=100):
        return [self._build(r) for r in self._query(f"SELECT {self.BUILD_COLUMNS} FROM builds ORDER BY id DESC LIMIT ?",
                                                    (limit,))]

    def interrupted_builds(self):
        """Marks builds left 'running' by an app that was closed mid-build."""
        self._execute("UPDATE builds SET result = 'failed', message = 'The app was closed during the build' "
                      "WHERE result = 'running'")

    # ------------------------------------------------------------ network events

    def add_network_event(self, device_id, message):
        self._execute("INSERT INTO network_events (time, device_id, message) VALUES (?, ?, ?)",
                      (time.time(), device_id, message))

    def network_events(self, limit=50):
        return self._query("SELECT * FROM network_events ORDER BY id DESC LIMIT ?", (limit,))

    # ------------------------------------------------------------ history: readings and links

    def add_reading(self, device_id, battery, soil_moisture, air_humidity, temperature, when=None):
        self._execute("INSERT INTO readings (device_id, time, battery, soil_moisture, air_humidity, temperature) "
                      "VALUES (?, ?, ?, ?, ?, ?)",
                      (device_id, when or time.time(), battery, soil_moisture, air_humidity, temperature))

    def readings(self, device_id, since=0):
        return self._query("SELECT time, battery, soil_moisture, air_humidity, temperature FROM readings "
                           "WHERE device_id = ? AND time >= ? ORDER BY time", (device_id, since))

    def add_link_sample(self, device_id, parent, link_margin=None, average_rssi=None, link_quality=None, when=None):
        self._execute("INSERT INTO link_samples (device_id, time, parent, link_margin, average_rssi, link_quality) "
                      "VALUES (?, ?, ?, ?, ?, ?)",
                      (device_id, when or time.time(), parent, link_margin, average_rssi, link_quality))

    def link_samples(self, device_id, since=0):
        return self._query("SELECT time, parent, link_margin, average_rssi, link_quality FROM link_samples "
                           "WHERE device_id = ? AND time >= ? ORDER BY time", (device_id, since))

    def network_events_for(self, device_id, limit=50):
        return self._query("SELECT * FROM network_events WHERE device_id = ? ORDER BY id DESC LIMIT ?",
                           (device_id, limit))

    # ------------------------------------------------------------ floor plan

    def floorplan_positions(self):
        return {r["node_key"]: {"x": r["x"], "y": r["y"]} for r in self._query("SELECT * FROM floorplan_positions")}

    def set_floorplan_position(self, node_key, x, y):
        if x is None:
            self._execute("DELETE FROM floorplan_positions WHERE node_key = ?", (node_key,))
        else:
            self._execute("INSERT OR REPLACE INTO floorplan_positions (node_key, x, y) VALUES (?, ?, ?)",
                          (node_key, x, y))
