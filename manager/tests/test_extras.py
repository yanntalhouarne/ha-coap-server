"""Signature checks, the battery check before updates, plants that need water, alerts, plant
photos, the readings export, the problem report, network history and the app update check."""

import asyncio
import hashlib
import io
import logging
import struct
import time
import zipfile

import httpx
import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, utils

from hacoap_manager import __version__, appupdate, backup, config, mcuboot
from hacoap_manager.app import create_app, create_services
from hacoap_manager.images import find_repository
from hacoap_manager.signing import SigningCheck
from hacoap_manager.simborder import SimulatedBorderRouter, scenario

from conftest import NEW_HASH, NEW_IMAGE, OLD_HASH, fast_settings

CHANGE = {"X-HACoap": "1"}
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


@pytest.fixture
def services(tmp_path):
    services = create_services(tmp_path / "data", discover=None)
    services.signing = SigningCheck(None, tmp_path / "data")  # no key: images aren't checked against one
    yield services
    services.console.close()
    services.db.close()


@pytest.fixture
async def client(services):
    app = create_app(services, background_tasks=False)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8710") as client:
        yield client


def signed_image(payload, private_key, version=(1, 2, 0, 0)):
    """An MCUboot image signed like imgtool does: SHA-256, key hash and ECDSA P-256 TLVs."""
    header = struct.pack(mcuboot.HEADER_FORMAT, mcuboot.IMAGE_MAGIC, 0, mcuboot.HEADER_SIZE, 0, len(payload), 0,
                         *version, 0)
    digest = hashlib.sha256(header + payload).digest()
    public = private_key.public_key().public_bytes(serialization.Encoding.DER,
                                                   serialization.PublicFormat.SubjectPublicKeyInfo)
    signature = private_key.sign(digest, ec.ECDSA(utils.Prehashed(hashes.SHA256())))
    tlvs = b"".join(struct.pack("<BxH", kind, len(value)) + value for kind, value in (
        (0x10, digest), (0x01, hashlib.sha256(public).digest()), (0x22, signature)))
    return header + payload + struct.pack("<HH", mcuboot.TLV_INFO_MAGIC, 4 + len(tlvs)) + tlvs


def checkout_with_key(tmp_path, key):
    repo = tmp_path / "checkout"
    (repo / "application" / "keys").mkdir(parents=True)
    (repo / "application" / "keys" / "mcuboot-signing-key.pem").write_bytes(key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    return repo


# ---------------------------------------------------------------- who signed an image

def test_signers(tmp_path, monkeypatch):
    monkeypatch.delenv("HACOAP_SIGNING_KEY", raising=False)
    mine, theirs = ec.generate_private_key(ec.SECP256R1()), ec.generate_private_key(ec.SECP256R1())
    repo = checkout_with_key(tmp_path, mine)
    check = SigningCheck(repo, tmp_path)
    image = signed_image(b"firmware" * 100, mine)
    assert check.signer(image) == "yours"
    assert check.signer(signed_image(b"firmware" * 100, theirs)) == "other"
    assert check.signer(mcuboot.build_image(b"firmware")) == "unsigned"
    assert SigningCheck(None, tmp_path / "elsewhere").signer(image) == "unknown"

    # The public half was kept: the check works without the private key too
    (repo / "application" / "keys" / "mcuboot-signing-key.pem").unlink()
    assert b"PRIVATE" not in (tmp_path / "signing-public-key.pem").read_bytes()
    assert SigningCheck(repo, tmp_path).signer(image) == "yours"


def test_development_key_is_recognised(tmp_path):
    repo = find_repository()
    dev = repo / "external" / "bootloader" / "mcuboot" / "root-ec-p256.pem" if repo else None
    if dev is None or not dev.is_file():
        pytest.skip("MCUboot's development key isn't in this checkout (scripts/setup fetches it)")
    key = serialization.load_pem_private_key(dev.read_bytes(), None)
    assert SigningCheck(None, tmp_path).signer(signed_image(b"x" * 50, key)) == "development"


async def test_updates_refuse_images_boards_wont_boot(client, services):
    await client.post("/api/images", content=NEW_IMAGE, headers=CHANGE)
    images = (await client.get("/api/images")).json()
    assert images[0]["signer"] == "unsigned"
    services.db.upsert_device("aa", address="127.0.0.1")
    response = await client.post("/api/updates", json={"image_hash": NEW_HASH, "targets": [{"device_id": "aa"}]},
                                 headers=CHANGE)
    assert response.status_code == 400 and "Not signed" in response.json()["detail"]


async def test_an_image_signed_with_your_key_for_boards_on_the_development_key(client, services, monkeypatch):
    """A board running a development-key image most likely has a development-key bootloader: an image
    signed with your key would be refused on it (MCUboot reverts the update). Said first, unless told."""
    await client.post("/api/images", content=NEW_IMAGE, headers=CHANGE)
    services.db.add_image(OLD_HASH, "1.0.0", "app_update.bin", 1000, "the one they run")
    signers = {NEW_HASH: "yours", OLD_HASH: "development"}
    monkeypatch.setattr(services.signing, "check", lambda image_hash, read, key=None: {
        "signer": signers.get(image_hash, "unknown"), "detail": ""})
    services.db.upsert_device("aa", name="basil", address="127.0.0.1", image_hash=OLD_HASH)
    started = []
    monkeypatch.setattr(services.updates, "start", lambda *args, **kwargs: started.append(args) or type(
        "Job", (), {"as_dict": lambda self: {"id": "j"}})())
    body = {"image_hash": NEW_HASH, "targets": [{"device_id": "aa"}]}
    response = await client.post("/api/updates", json=body, headers=CHANGE)
    assert response.status_code == 409 and response.json()["detail"].startswith(
        "basil runs an image signed with the development key, so its bootloader")
    assert not started
    assert (await client.post("/api/updates", json={**body, "allow_key_change": True}, headers=CHANGE)).status_code == 200
    # A board on an image signed with your key: no question
    signers[OLD_HASH] = "yours"
    assert (await client.post("/api/updates", json=body, headers=CHANGE)).status_code == 200
    assert len(started) == 2


# ---------------------------------------------------------------- battery check

async def test_low_battery_devices_are_skipped(client, services, start_sim):
    server = await start_sim(data=bytes([42, 12, 55, 20]))  # battery 12 %
    fast_settings(services.settings, server)
    await client.post("/api/devices", json={"address": "127.0.0.1"}, headers=CHANGE)
    await client.post("/api/images", content=NEW_IMAGE, headers=CHANGE)

    async def update(**extra):
        job = (await client.post("/api/updates", json={"image_hash": NEW_HASH, "allow_unverified": True,
                                                        "targets": [{"device_id": "1a2b3c4d"}], **extra},
                                 headers=CHANGE)).json()
        return await services.updates.wait(job["id"])

    job = await update()
    assert job.targets[0].status == "skipped" and "battery at 12 %" in job.targets[0].message
    assert job.state == "done"  # skipped isn't a failure
    job = await update(ignore_battery=True)
    assert job.targets[0].status == "updated"


# ---------------------------------------------------------------- water, alerts

async def test_needs_water_and_alerts(client, services):
    services.db.upsert_device("aa", name="basil", soil_moisture=18, battery=80, last_seen=time.time())
    device = (await client.get("/api/devices")).json()[0]
    assert device["needs_water"] and device["water_target"] == 30          # the default target
    board = (await client.get("/api/dashboard")).json()
    assert board["counts"]["needs_water"] == 1 and board["needs_water"][0]["name"] == "basil"

    new = services.alerts.scan()
    assert [a["kind"] for a in new] == ["dry"] and "basil needs water" in new[0]["message"]
    assert services.alerts.scan() == []                                    # raised once
    await client.patch("/api/devices/aa", json={"name": "sweet basil"}, headers=CHANGE)
    assert (await client.get("/api/alerts")).json()["open"][0]["message"].startswith("sweet basil needs water")

    # A lower target for this plant: it's fine, and the alert clears
    device = (await client.patch("/api/devices/aa", json={"water_below": 10}, headers=CHANGE)).json()
    assert not device["needs_water"]
    assert (await client.get("/api/alerts")).json()["open"] == []
    assert (await client.patch("/api/devices/aa", json={"water_below": 120}, headers=CHANGE)).status_code == 400

    services.db.upsert_device("aa", battery=9)
    assert [a["kind"] for a in services.alerts.scan()] == ["battery"]

    # Offline only once the app has asked every device (at start, the last answers are old)
    services.db.upsert_device("aa", last_seen=time.time() - 86400)
    assert services.alerts.scan() == []
    services.inventory.refreshed = True
    assert [a["kind"] for a in services.alerts.scan()] == ["offline"]

    services.alerts.update_failed("job1", "aa", "basil", "no answer")
    alerts = (await client.get("/api/alerts")).json()["open"]
    failed = next(a for a in alerts if a["kind"] == "update")
    assert "Update of sweet basil failed" in failed["message"]
    response = await client.post(f"/api/alerts/{failed['id']}/dismiss", headers=CHANGE)
    assert all(a["kind"] != "update" for a in response.json()["open"])


async def test_a_dismissed_alert_stays_quiet_while_it_lasts(client, services):
    services.db.upsert_device("aa", name="basil", soil_moisture=18, battery=80, last_seen=time.time())
    dry = services.alerts.scan()[0]
    assert (await client.post(f"/api/alerts/{dry['id']}/dismiss", headers=CHANGE)).json()["open"] == []
    assert (await client.post(f"/api/alerts/{dry['id']}/dismiss", headers=CHANGE)).status_code == 404
    # Still dry: not raised again, minute after minute
    assert services.alerts.scan() == [] and services.alerts.scan() == []
    assert (await client.get("/api/alerts")).json()["open"] == []
    # Watered, then dry again: it's a new time, raised again
    services.db.upsert_device("aa", soil_moisture=60)
    assert services.alerts.scan() == []
    services.db.upsert_device("aa", soil_moisture=15)
    assert [a["kind"] for a in services.alerts.scan()] == ["dry"]

    # Several at once ("Dismiss all"): the ones asked for only
    services.db.upsert_device("bb", name="mint", soil_moisture=10, battery=80, last_seen=time.time())
    services.db.upsert_device("cc", name="thyme", soil_moisture=10, battery=80, last_seen=time.time())
    services.alerts.scan()
    open_ids = {a["device_id"]: a["id"] for a in (await client.get("/api/alerts")).json()["open"]}
    assert set(open_ids) == {"aa", "bb", "cc"}
    left = (await client.post("/api/alerts/dismiss", json={"ids": [open_ids["aa"], open_ids["bb"]]}, headers=CHANGE)).json()
    assert [a["device_id"] for a in left["open"]] == ["cc"]
    assert services.alerts.scan() == []
    for bad in ({}, {"ids": "1"}, {"ids": ["1"]}, {"ids": [True]}):
        assert (await client.post("/api/alerts/dismiss", json=bad, headers=CHANGE)).status_code == 400


async def test_border_router_and_network_alerts(client, services):
    alerts = services.alerts
    alerts.check_border_router({"br-stopped": "The border router (otbr) isn't running"})
    assert services.db.open_alerts() == []           # once: maybe a restart
    alerts.check_border_router({"br-stopped": "The border router (otbr) isn't running"})
    raised = services.db.open_alerts()
    assert [(a["kind"], a["key"]) for a in raised] == [("border-router", "br-stopped")]
    alerts.check_border_router({})
    assert services.db.open_alerts() == []           # back: cleared
    alerts.check_border_router({"br-radio": "unplugged"})
    alerts.check_border_router({})                   # gone before the second check: never raised
    assert services.db.open_alerts() == []

    # Every board silent at once: one alert about the network
    old = time.time() - 86400
    services.db.upsert_device("aa", name="basil", address="fd11::1", last_seen=old)
    services.db.upsert_device("bb", name="mint", address="fd11::2", last_seen=old)
    services.inventory.refreshed = True
    alerts.scan()
    kinds = {a["key"]: a for a in services.db.open_alerts()}
    assert "None of the 2 boards answer" in kinds["network:silent"]["message"]
    services.db.upsert_device("bb", last_seen=time.time())
    alerts.scan()
    assert "network:silent" not in {a["key"] for a in services.db.open_alerts()}


def test_copying_a_backup(tmp_path):
    source = tmp_path / "auto-20261110-020000.zip"
    source.write_bytes(b"a backup")
    with pytest.raises(backup.BackupError, match="isn't there"):
        backup.copy_backup(source, tmp_path / "nas", 3)        # not mounted: nothing written on this disk
    assert not (tmp_path / "nas").exists()
    with pytest.raises(backup.BackupError, match="full path"):
        backup.copy_backup(source, "nas", 3)
    nas = tmp_path / "nas"
    nas.mkdir()
    for day in range(1, 5):
        (nas / f"auto-2026110{day}-020000.zip").write_bytes(b"old")
    (nas / "notes.txt").write_text("mine")
    copy = backup.copy_backup(source, nas, 3)
    assert copy.read_bytes() == b"a backup" and not list(nas.glob("*.part"))
    assert sorted(p.name for p in nas.iterdir()) == ["auto-20261103-020000.zip", "auto-20261104-020000.zip",
                                                     "auto-20261110-020000.zip", "notes.txt"]  # the newest 3, and the rest left


async def test_backups_copied_elsewhere(client, services, tmp_path):
    state = (await client.get("/api/backups/copy")).json()
    assert state == {"folder": ""}
    assert (await client.post("/api/backups/copy", headers=CHANGE)).status_code == 400   # no folder yet
    nas = tmp_path / "nas"
    services.settings.backup_copy_dir = str(nas)
    state = (await client.post("/api/backups/copy", headers=CHANGE)).json()           # not mounted
    assert state["ok"] is False and "isn't there" in state["message"]
    alert = [a for a in services.db.open_alerts() if a["key"] == "backup-copy"]
    assert len(alert) == 1 and str(nas) in alert[0]["message"]
    nas.mkdir()
    state = (await client.post("/api/backups/copy", headers=CHANGE)).json()           # made one, and copied it
    assert state["ok"] is True and (nas / state["name"]).is_file()
    assert not [a for a in services.db.open_alerts() if a["key"] == "backup-copy"]
    assert (await client.get("/api/backups/copy")).json()["name"] == state["name"]


def test_weak_links_and_boards_that_keep_switching(services):
    from hacoap_manager.alerts import weak_link
    weak = {"link_margin": 6, "link_quality": 1}
    assert weak_link([weak] * 3) and not weak_link([weak] * 2)                     # 3 readings at least
    assert not weak_link([weak, weak, {"link_margin": 25, "link_quality": 3}])        # one good one: not weak
    assert weak_link([{"link_margin": None, "link_quality": 1}] * 3)                  # only its quality: 1 is weak
    assert not weak_link([{"link_margin": None, "link_quality": None}] * 3)           # nothing measured: can't tell
    now = time.time()
    services.db.upsert_device("1a2b3c4d", name="ha-coap-1a2b3c4d", plant="basil", address="fd11::1", last_seen=now)
    services.db.upsert_device("5e6f7a8b", name="ha-coap-5e6f7a8b", address="fd11::2", last_seen=now)
    for minutes in (150, 100, 50, 5):
        services.db.add_link_sample("1a2b3c4d", "0x4000", link_margin=5, average_rssi=-92, link_quality=1,
                                    when=now - minutes * 60)
        services.db.add_link_sample("5e6f7a8b", "0x4000", link_margin=30, average_rssi=-60, link_quality=3,
                                    when=now - minutes * 60)
    for _ in range(3):
        services.db.add_network_event("5e6f7a8b", "ha-coap-5e6f7a8b: parent changed from 0x4000 to 0xf800")
    services.db.add_network_event("1a2b3c4d", "ha-coap-1a2b3c4d: parent changed from 0x4000 to 0xf800")
    raised = {a["key"]: a["message"] for a in services.alerts.scan()}
    assert set(raised) == {"weak-link:1a2b3c4d", "switching:5e6f7a8b"}
    assert raised["weak-link:1a2b3c4d"].startswith("basil's link to its router has been weak for 3 hours")
    assert raised["switching:5e6f7a8b"].startswith("ha-coap-5e6f7a8b changed routers 3 times in a day")
    # A good reading since: the link alert clears
    services.db.add_link_sample("1a2b3c4d", "0x4000", link_margin=22, link_quality=3, when=now)
    services.alerts.scan()
    assert {a["key"] for a in services.db.open_alerts()} == {"switching:5e6f7a8b"}


def test_a_board_that_stopped_sampling(services):
    """It answers, but its newest sample is over 2 hours old: its readings don't change."""
    now = time.time()
    services.db.upsert_device("1a2b3c4d", name="ha-coap-1a2b3c4d", plant="basil", address="fd11::1", last_seen=now,
                              last_sample=now - 5.6 * 3600)
    services.db.upsert_device("5e6f7a8b", name="ha-coap-5e6f7a8b", address="fd11::2", last_seen=now,
                              last_sample=now - 900)
    services.db.upsert_device("9c0d1e2f", name="ha-coap-9c0d1e2f", address="fd11::3", last_seen=now)  # older firmware
    raised = {a["key"]: a["message"] for a in services.alerts.scan()}
    assert set(raised) == {"sampling:1a2b3c4d"}
    assert raised["sampling:1a2b3c4d"].startswith("basil answers but hasn't taken a sample for over 2 hours")
    # Sampling again: cleared
    services.db.upsert_device("1a2b3c4d", last_sample=now)
    services.alerts.scan()
    assert services.db.open_alerts() == []


def test_alerts_dismissed_before_the_upgrade_dont_stay_quiet(tmp_path):
    import sqlite3
    from hacoap_manager.db import Database
    path = tmp_path / "old.db"
    Database(path).close()
    conn = sqlite3.connect(path)  # as an older version left it: no 'ended' column, one dry alert dismissed long ago
    conn.executescript("ALTER TABLE alerts DROP COLUMN ended; "
                       "INSERT INTO alerts (key, kind, message, raised, cleared, dismissed) VALUES ('dry:aa', 'dry', 'x', 1, 2, 1);")
    conn.commit(); conn.close()
    db = Database(path)
    assert db.quiet_alert_keys() == set()
    db.close()


# ---------------------------------------------------------------- plant photos

async def test_photos(client, services):
    services.db.upsert_device("aa")
    assert (await client.get("/api/devices/aa/photo")).status_code == 404
    device = (await client.post("/api/devices/aa/photo", content=PNG, headers=CHANGE)).json()
    assert device["photo"]
    response = await client.get("/api/devices/aa/photo")
    assert response.content == PNG and response.headers["content-type"] == "image/png"
    svg = b"<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"
    assert (await client.post("/api/devices/aa/photo", content=svg, headers=CHANGE)).status_code == 400
    assert (await client.post("/api/devices/zz/photo", content=PNG, headers=CHANGE)).status_code == 404

    # It's in backups, and comes back with a restore
    data = backup.create_backup(services.data_dir, services.db, services.settings)
    assert "photos/aa" in zipfile.ZipFile(io.BytesIO(data)).namelist()
    await client.delete("/api/devices/aa/photo", headers=CHANGE)
    assert not (services.data_dir / "photos" / "aa").exists()
    backup.restore_backup(data, services.data_dir, services.db, services.settings)
    assert (services.data_dir / "photos" / "aa").read_bytes() == PNG

    await client.delete("/api/devices/aa", headers=CHANGE)              # removing the device removes it
    assert not (services.data_dir / "photos" / "aa").exists()


# ---------------------------------------------------------------- exports and the report

async def test_readings_csv(client, services):
    services.db.upsert_device("aa", name="basil")
    services.db.add_reading("aa", 80, 40, 50, -3, when=time.time() - 3600)
    services.db.add_reading("bb", 70, 41, 51, 4, power="charging")
    text = (await client.get("/api/readings.csv")).text
    lines = text.strip().splitlines()
    assert lines[0] == "device_id,name,time,battery,soil_moisture,air_humidity,temperature,power"
    assert lines[1].startswith("aa,basil,") and lines[1].endswith(",80,40,50,-3,") and len(lines) == 3
    assert lines[2].endswith(",70,41,51,4,charging")
    assert len((await client.get("/api/readings.csv?device_id=bb")).text.strip().splitlines()) == 2


async def test_problem_report_has_no_secrets(client, services, tmp_path):
    repo = tmp_path / "checkout"
    (repo / "application").mkdir(parents=True)
    (repo / "application" / "local.conf").write_text('CONFIG_OPENTHREAD_JOINER_PSKD="J01NME42"\n')
    services.repository = repo
    logging.getLogger("hacoap_manager.test").info("joining with J01NME42")
    build = services.db.add_build("Production", "battery", {})
    services.db.update_build(build, result="done", log="pskd J01NME42 in a build log")

    response = await client.get("/api/report")
    archive = zipfile.ZipFile(io.BytesIO(response.content))
    names = archive.namelist()
    assert {"log.txt", "summary.json", "devices.json", "build-checks.json"} <= set(names)
    everything = b"".join(archive.read(n) for n in names)
    assert b"J01NME42" not in everything and b"<PSKd>" in everything
    assert b"joining with <PSKd>" in archive.read("log.txt")
    assert b"PRIVATE KEY" not in everything


# ---------------------------------------------------------------- network history

async def test_network_history(client, services):
    border = SimulatedBorderRouter("api", net=scenario()).start()
    try:
        services.settings.border_router_url = border.url
        await client.post("/api/network/refresh", headers=CHANGE)
        await client.post("/api/network/refresh", headers=CHANGE)
    finally:
        border.stop()
    history = (await client.get("/api/network/history")).json()
    assert len(history) == 2 and history[0]["nodes"] == 7
    topology = (await client.get(f"/api/network/history/{history[0]['id']}")).json()
    assert len(topology["nodes"]) == 7
    assert (await client.get("/api/network/history/999")).status_code == 404


# ---------------------------------------------------------------- app updates, settings

def test_newest_release():
    releases = [{"tag_name": "manager-v0.2.0", "html_url": "u2"}, {"tag_name": "manager-v0.10.0", "html_url": "u10"},
                {"tag_name": "manager-v1.0.0", "draft": True}, {"tag_name": "v9.0.0"}]
    assert appupdate.newest(releases) == ("0.10.0", "u10")
    check = appupdate.UpdateCheck(fetch=lambda: releases).check()
    assert check["latest"] == "0.10.0" and check["newer"]
    failing = appupdate.UpdateCheck(fetch=lambda: (_ for _ in ()).throw(OSError("offline"))).check()
    assert failing["error"] and not failing["newer"]


async def test_app_update_check_is_off_unless_asked(client, services):
    assert (await client.get("/api/app-update")).json() == {"current": __version__, "checking": False}
    services.app_update = appupdate.UpdateCheck(fetch=lambda: [{"tag_name": "manager-v9.9.9", "html_url": "u"}])
    result = (await client.get("/api/app-update?force=true")).json()
    assert result["latest"] == "9.9.9" and result["newer"]


def test_bool_settings_from_text():
    settings = config.Settings()
    settings.update({"check_app_updates": "false"})
    assert settings.check_app_updates is False
    settings.update({"check_app_updates": True})
    assert settings.check_app_updates is True
