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

from conftest import NEW_HASH, NEW_IMAGE, fast_settings

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
    services.db.add_reading("bb", 70, 41, 51, 4)
    text = (await client.get("/api/readings.csv")).text
    lines = text.strip().splitlines()
    assert lines[0] == "device_id,name,time,battery,soil_moisture,air_humidity,temperature"
    assert lines[1].startswith("aa,basil,") and lines[1].endswith(",80,40,50,-3") and len(lines) == 3
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
