import io
import os
import time
import zipfile

import httpx
import pytest

from hacoap_manager import backup
from hacoap_manager.app import create_app, create_services

from conftest import NEW_HASH, NEW_IMAGE

CHANGE = {"X-HACoap": "1"}


@pytest.fixture
def make_services(tmp_path):
    made = []

    def make(name):
        services = create_services(tmp_path / name, discover=None)
        made.append(services)
        return services

    yield make
    for services in made:
        services.db.close()


def fill(services):
    services.db.upsert_device("1a2b3c4d", name="basil", address="fd00::1", notes="kitchen")
    services.images.add(NEW_IMAGE, "app_update.bin", "v1.1 test")
    services.db.save_profile("Greenhouse", "battery", {"HACOAP_SENSOR_SAMPLE_PERIOD_S": 600})
    services.db.add_update("job", "1a2b3c4d", "udp", NEW_HASH, "1.1.0", 1.0, 2.0, "updated", "ok")
    services.settings.auto_refresh_minutes = 5


def test_backup_and_restore_everything(make_services):
    source = make_services("source")
    fill(source)
    data = backup.create_backup(source.data_dir, source.db, source.settings)

    target = make_services("target")
    target.db.upsert_device("old", name="to be replaced")
    result = backup.restore_backup(data, target.data_dir, target.db, target.settings)

    assert result["devices"] == 1 and result["images"] == 1
    assert target.db.device("old") is None
    assert target.db.device("1a2b3c4d")["notes"] == "kitchen"
    assert target.images.data(NEW_HASH) == NEW_IMAGE
    assert target.db.profile("Greenhouse")["settings"] == {"HACOAP_SENSOR_SAMPLE_PERIOD_S": 600}
    assert target.db.updates()[0]["result"] == "updated"
    assert target.settings.auto_refresh_minutes == 5
    # The data that was replaced was saved first
    safety = backup.backup_path(target.data_dir, result["safety_backup"])
    assert safety is not None
    with zipfile.ZipFile(safety) as archive:
        assert "manager.db" in archive.namelist()


def test_restore_refuses_other_files(make_services):
    services = make_services("one")
    for data in (b"not a zip", _zip({"hello.txt": b"hi"}), _zip({"manifest.json": b'{"app": "other"}', "manager.db": b""})):
        with pytest.raises(backup.BackupError):
            backup.restore_backup(data, services.data_dir, services.db, services.settings)
    damaged = _zip({"manifest.json": b'{"app": "hacoap-manager"}', "manager.db": b"garbage" * 100})
    with pytest.raises(backup.BackupError, match="damaged|missing"):
        backup.restore_backup(damaged, services.data_dir, services.db, services.settings)


def test_restore_only_writes_inside_the_data_folder(make_services, tmp_path):
    source = make_services("source")
    data = backup.create_backup(source.data_dir, source.db, source.settings)
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        files = {name: archive.read(name) for name in archive.namelist()}
    files["../evil.txt"] = b"x"
    files["images/../../evil2.txt"] = b"x"
    target = make_services("target")
    backup.restore_backup(_zip(files), target.data_dir, target.db, target.settings)
    assert not (tmp_path / "evil.txt").exists()
    assert not (tmp_path / "evil2.txt").exists()
    assert not (target.data_dir.parent / "evil.txt").exists()


def test_automatic_backups(make_services):
    services = make_services("one")
    assert backup.auto_backup(services.data_dir, services.db, services.settings) is not None
    assert backup.auto_backup(services.data_dir, services.db, services.settings) is None  # one a day
    folder = backup.backups_dir(services.data_dir)
    for day in range(1, 6):
        old = folder / f"auto-2026010{day}-000000.zip"
        old.write_bytes(b"old")
        os.utime(old, (time.time() - 86400 * (10 - day),) * 2)
    for path in folder.glob("auto-2*.zip"):
        if path.read_bytes() != b"old":
            os.utime(path, (time.time() - 86400,) * 2)
    backup.auto_backup(services.data_dir, services.db, services.settings, keep=3)
    assert len(list(folder.glob("auto-*.zip"))) == 3
    assert backup.backup_path(services.data_dir, "../manager.db") is None


def test_devices_csv_round_trip(make_services):
    source = make_services("source")
    fill(source)
    text = backup.devices_csv(source.db)
    assert text.splitlines()[0].startswith("device_id,name,address,notes")
    target = make_services("target")
    target.db.upsert_device("1a2b3c4d", name="old name")
    assert backup.import_devices_csv(text, target.db) == {"added": 0, "updated": 1}
    device = target.db.device("1a2b3c4d")
    assert (device["name"], device["address"], device["notes"]) == ("basil", "fd00::1", "kitchen")
    assert device["fw_version"] == ""  # not imported: it comes from the device


def test_devices_csv_checks_its_input(make_services):
    services = make_services("one")
    for text, message in [("name\nx\n", "device_id column"),
                          ("device_id,name\nbad id!,x\n", "invalid device_id"),
                          ("device_id,address\nabcd,not-an-address\n", "invalid address")]:
        with pytest.raises(backup.BackupError, match=message):
            backup.import_devices_csv(text, services.db)
    assert backup.import_devices_csv("﻿device_id,name\nabcd,Mint\n", services.db) == {"added": 1, "updated": 0}


async def test_backup_api(make_services):
    services = make_services("api")
    fill(services)
    app = create_app(services, background_tasks=False)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8710") as client:
        response = await client.get("/api/backup")
        assert response.status_code == 200
        assert "attachment" in response.headers["content-disposition"]
        data = response.content

        services.db.delete_device("1a2b3c4d")
        response = await client.post("/api/restore", content=data, headers=CHANGE)
        assert response.status_code == 200, response.text
        assert services.db.device("1a2b3c4d") is not None
        assert (await client.post("/api/restore", content=b"nope", headers=CHANGE)).status_code == 400
        assert (await client.post("/api/restore", content=data)).status_code == 403  # no header

        backups = (await client.get("/api/backups")).json()
        assert backups and backups[0]["name"].startswith("before-restore-")
        assert (await client.get(f"/api/backups/{backups[0]['name']}")).status_code == 200
        assert (await client.get("/api/backups/..%2Fmanager.db")).status_code == 404

        csv_text = (await client.get("/api/devices.csv")).text
        assert "basil" in csv_text
        response = await client.post("/api/devices/import", content=b"device_id,name\nffff,New\n", headers=CHANGE)
        assert response.json() == {"added": 1, "updated": 0}


def _zip(files):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, data in files.items():
            archive.writestr(name, data)
    return buffer.getvalue()
