"""The connection check, battery drain per firmware, starting in the background, the Home
Assistant import, chart events, and keeping the data in bounds."""

import asyncio
import io
import json
import sys
import time
import urllib.parse
import zipfile

import httpx
import pytest

from hacoap_manager import autostart, backup, doctor, fleet, homeassistant, housekeeping, report
from hacoap_manager.app import create_app, create_services
from hacoap_manager.discovery import Found
from hacoap_manager.simborder import SimulatedBorderRouter, scenario

from conftest import NEW_HASH, NEW_IMAGE, fast_settings

CHANGE = {"X-HACoap": "1"}
DAY = 86400


@pytest.fixture
def services(tmp_path):
    services = create_services(tmp_path / "data", discover=None)
    yield services
    services.console.close()
    services.db.close()


@pytest.fixture
async def client(services):
    app = create_app(services, background_tasks=False)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8710") as client:
        yield client


# ---------------------------------------------------------------- battery drain per firmware

def readings(start, days, per_day, battery=100.0, every_h=3):
    return [{"time": start + i * every_h * 3600, "battery": round(battery - per_day * i * every_h / 24)}
            for i in range(int(days * 24 / every_h))]


def test_drain_rate_skips_charging():
    now = time.time()
    first = readings(now - 20 * DAY, 10, 1.0, battery=90)
    second = readings(now - 10 * DAY, 10, 1.0, battery=95)   # charged in between: a jump up
    rate = fleet.drain_rate(first + second)
    assert 0.9 < rate["per_day"] < 1.1 and rate["days"] > 19
    assert fleet.drain_rate(first[:2]) is None    # too few
    # The charger unplugged: the reading drops 12 % at once, which isn't drain
    unplugged = [{"time": now - 10 * DAY - 3600, "battery": 100}, {"time": now - 10 * DAY - 1800, "battery": 100}]
    rate = fleet.drain_rate(unplugged + readings(now - 10 * DAY, 10, 0.5, battery=88))
    assert 0.4 < rate["per_day"] < 0.6


def test_drain_per_image(services):
    db, now = services.db, time.time()
    for device_id in ("aaaa0001", "aaaa0002"):
        db.upsert_device(device_id, name=device_id, address="127.0.0.1")
        for r in readings(now - 30 * DAY, 15, 2.0):            # 2 %/day before the update
            db.add_reading(device_id, r["battery"], 40, 50, 20, when=r["time"])
        db.add_update("job", device_id, "udp", NEW_HASH, "1.1.0", now - 15 * DAY - 60, now - 15 * DAY, "updated", "")
        for r in readings(now - 15 * DAY, 15, 0.5, battery=70):  # 0.5 %/day after it
            db.add_reading(device_id, r["battery"], 40, 50, 20, when=r["time"])
    periods = fleet.battery_drain(db, db.device("aaaa0001"), now)
    assert periods[0]["image_hash"] is None and 1.8 < periods[0]["rate"]["per_day"] < 2.2
    assert periods[1]["image_hash"] == NEW_HASH and 0.4 < periods[1]["rate"]["per_day"] < 0.6
    groups = fleet.drain_by_image(db, services.inventory, now)
    assert len(groups) == 1 and groups[0]["version"] == "1.1.0" and len(groups[0]["devices"]) == 2
    assert 150 < groups[0]["days_full"] < 250


# ---------------------------------------------------------------- the connection check

async def test_doctor_with_the_simulators(services, client, start_sim):
    server = await start_sim()
    fast_settings(services.settings, server)
    border = SimulatedBorderRouter("api", net=scenario()).start()
    try:
        services.settings.border_router_url = border.url
        services.doctor._discover = lambda timeout: _found()
        await client.post("/api/devices", json={"address": "127.0.0.1"}, headers=CHANGE)
        result = (await client.post("/api/doctor", json={}, headers=CHANGE)).json()
    finally:
        border.stop()
    states = {s["name"]: s["state"] for s in result["steps"]}
    assert states == {"Border router": "ok", "Finding boards (mDNS)": "ok", "Route to the Thread network": "ok",
                      "Boards answering": "ok"}
    timing = result["devices"][0]
    assert timing["coap_ms"] is not None and timing["mcumgr_ms"] is not None and timing["upload_s"] >= 0
    assert result["ok"] and result["summary"] == "Everything answers"


async def _found():
    return [Found("ha-coap-1a2b3c4d", "1a2b3c4d", "127.0.0.1")]


async def test_doctor_explains_a_missing_route(services, monkeypatch):
    services.db.upsert_device("abcd0001", name="far", address="fd11:22::1")

    def no_route(address, port=5683):
        raise OSError("Network is unreachable")

    monkeypatch.setattr(doctor, "route_to", no_route)
    services.settings.coap_timeout_s = 0.2
    result = await services.doctor.check()
    route = next(s for s in result["steps"] if s["name"] == "Route to the Thread network")
    assert route["state"] == "fail" and "fd11:22::/64" in route["detail"] and "accept_ra_rt_info_max_plen" in route["advice"]
    assert not result["ok"] and result["summary"] == "Stuck at: Route to the Thread network"


def test_upload_estimate():
    assert doctor.estimate_upload_s(0.2, 300 * 1024, 1280) == pytest.approx(-(-300 * 1024 // 1160) * 0.2)
    assert doctor.prefix_of("fd11:22:0:0:1:2:3:4") == "fd11:22::/64"


# ---------------------------------------------------------------- Home Assistant

def fake_home_assistant(token="secret-token"):
    """A Home Assistant with one ha-coap board (basil, 1a2b3c4d) and one the app doesn't know."""
    now = time.time()
    iso = lambda t: homeassistant._iso(t)  # noqa: E731
    states = [
        {"entity_id": "sensor.basil_device_id", "state": "1A2B3C4D", "attributes": {"friendly_name": "basil.device-id"}},
        {"entity_id": "sensor.basil_battery", "state": "80", "attributes": {"friendly_name": "basil.battery", "unit_of_measurement": "%"}},
        {"entity_id": "sensor.basil_soil_humidity", "state": "40", "attributes": {"friendly_name": "basil.soil-humidity", "unit_of_measurement": "%"}},
        {"entity_id": "sensor.basil_temperature", "state": "68", "attributes": {"friendly_name": "basil.temperature", "unit_of_measurement": "°F"}},
        {"entity_id": "sensor.fern_device_id", "state": "99999999", "attributes": {"friendly_name": "fern.device-id"}},
        {"entity_id": "sensor.fern_battery", "state": "50", "attributes": {"friendly_name": "fern.battery"}},
        {"entity_id": "light.kitchen", "state": "on", "attributes": {"friendly_name": "Kitchen"}},
    ]
    history = {
        "sensor.basil_battery": [(now - 5 * DAY, "82"), (now - 3 * DAY, "81"), (now - 2 * DAY, "unavailable"), (now - DAY, "80")],
        "sensor.basil_soil_humidity": [(now - 5 * DAY, "45"), (now - 4 * DAY, "40")],
        "sensor.basil_temperature": [(now - 5 * DAY, "68")],
    }
    seen = []

    def fetch(url, headers, timeout):
        seen.append(url)
        if headers.get("Authorization") != f"Bearer {token}":
            return 401, ""
        parsed = urllib.parse.urlparse(url)
        if parsed.path == "/api/config":
            return 200, json.dumps({"version": "2026.10.1", "location_name": "Home"})
        if parsed.path == "/api/states":
            return 200, json.dumps(states)
        if parsed.path.startswith("/api/history/period/"):
            wanted = urllib.parse.parse_qs(parsed.query)["filter_entity_id"][0].split(",")
            out = []
            for entity_id in wanted:
                entries = [{"state": s, "last_changed": iso(t)} for t, s in history.get(entity_id, [])]
                if entries:
                    entries[0]["entity_id"] = entity_id
                    out.append(entries)
            return 200, json.dumps(out)
        return 404, ""

    fetch.seen = seen
    return fetch


def test_home_assistant_import(services):
    services.db.upsert_device("1a2b3c4d", name="basil", address="fd11:22::1")
    fetch = fake_home_assistant()
    ha = homeassistant.HomeAssistant("http://ha.local:8123", "secret-token", fetch=fetch)
    assert ha.check()["version"] == "2026.10.1"
    boards = {b["ha_name"]: b for b in ha.boards()}
    assert boards["basil"]["device_id"] == "1a2b3c4d" and set(boards["basil"]["entities"]) == {"battery", "soil_moisture", "temperature"}

    results = {r["ha_name"]: r for r in homeassistant.import_history(services.db, ha, services.db.devices(), days=10)}
    assert results["basil"]["imported"] == 5 and "99999999" in results["fern"]["note"]
    rows = services.db.readings("1a2b3c4d")
    assert rows[0]["battery"] == 82 and rows[0]["soil_moisture"] == 45 and rows[0]["temperature"] == 20   # 68 °F
    assert rows[2]["battery"] == 81 and rows[2]["soil_moisture"] == 40      # a value holds until it changes
    assert rows[3]["battery"] is None                                      # unavailable
    again = homeassistant.import_history(services.db, ha, services.db.devices(), days=10)
    assert sum(r["imported"] for r in again) == 0                          # nothing twice

    with pytest.raises(homeassistant.HomeAssistantError, match="refused the token"):
        homeassistant.HomeAssistant("http://ha.local:8123", "wrong", fetch=fetch).check()


async def test_home_assistant_token_stays_private(services, client):
    response = await client.put("/api/home-assistant", json={"url": "http://ha.local:8123", "token": "secret-token"}, headers=CHANGE)
    assert response.json() == {"url": "http://ha.local:8123", "token_set": True}
    assert (await client.get("/api/home-assistant")).json()["token_set"]
    assert (await client.put("/api/home-assistant", json={"url": "ftp://x"}, headers=CHANGE)).status_code == 400
    names = zipfile.ZipFile(io.BytesIO(backup.create_backup(services.data_dir, services.db, services.settings))).namelist()
    assert not any("token" in n for n in names)
    report_zip = zipfile.ZipFile(io.BytesIO(report.create_report(services, [])))
    assert all(b"secret-token" not in report_zip.read(n) for n in report_zip.namelist())
    await client.put("/api/home-assistant", json={"token": ""}, headers=CHANGE)
    assert not (await client.get("/api/home-assistant")).json()["token_set"]


# ---------------------------------------------------------------- chart events

async def test_pump_runs_are_recorded(services, client, start_sim):
    server = await start_sim()
    fast_settings(services.settings, server)
    await client.post("/api/devices", json={"address": "127.0.0.1"}, headers=CHANGE)
    await client.post("/api/devices/1a2b3c4d/pump", json={"on": True}, headers=CHANGE)
    await client.post("/api/devices/1a2b3c4d/pump", json={"on": False}, headers=CHANGE)
    details = (await client.get("/api/devices/1a2b3c4d/details")).json()
    assert [a["kind"] for a in details["activity"]] == ["pump"] and "drain" in details


# ---------------------------------------------------------------- keeping the data in bounds

def test_prune_and_usage(services, tmp_path):
    db, now = services.db, time.time()
    db.add_reading("1a2b3c4d", 50, 40, 50, 20, when=now - 800 * DAY)
    db.add_reading("1a2b3c4d", 50, 40, 50, 20, when=now - DAY)
    for i in range(5):
        db.add_network_snapshot(now - i, 1, 0, b"x")
    services.settings.keep_readings_days = 730
    services.settings.keep_network_readings = 3
    assert housekeeping.prune(db, services.settings, now) == {"rows": 1, "network": 2}
    usage = housekeeping.usage(services.data_dir, db)
    assert usage["rows"]["readings"] == 1 and usage["parts"]["database"] > 0 and usage["total"] >= usage["parts"]["database"]
    services.settings.keep_readings_days = 0     # keep everything
    assert housekeeping.prune(db, services.settings, now)["rows"] == 0

    folder = backup.backups_dir(services.data_dir)
    for day in range(1, 6):
        (folder / f"{backup.AUTO_PREFIX}2026100{day}-000000.zip").write_bytes(b"zip")
    (folder / "before-restore-20261001.zip").write_bytes(b"zip")
    backup.prune_backups(services.data_dir, 2)
    assert sorted(p.name for p in folder.glob("*.zip")) == [
        f"{backup.AUTO_PREFIX}20261004-000000.zip", f"{backup.AUTO_PREFIX}20261005-000000.zip", "before-restore-20261001.zip"]


async def test_storage_api(client):
    usage = (await client.get("/api/storage")).json()
    assert "database" in usage["parts"]
    assert (await client.post("/api/storage/prune", headers=CHANGE)).json()["removed"] == {"rows": 0, "network": 0}
    assert (await client.post("/api/storage/compact", headers=CHANGE)).status_code == 200


# ---------------------------------------------------------------- running in the background

def test_autostart_command(tmp_path):
    args = autostart.command(tmp_path, data_dir=tmp_path / "data", port=8711)
    assert args[1].endswith("run_manager.py") and "--background" in args
    assert args[args.index("--workdir") + 1] == str(tmp_path) and args[-2:] == ["--port", "8711"]
    assert autostart._desktop_exec(["/usr/bin/python3", "/home/me/My Code/run.py", 'a"b$c']) == \
        '/usr/bin/python3 "/home/me/My Code/run.py" "a\\"b\\$c"'


@pytest.mark.skipif(sys.platform == "win32", reason="would change this user's Run key; Linux and macOS write files")
def test_autostart_enable_and_disable(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / ".config"))
    assert not autostart.enabled()
    autostart.enable(["/usr/bin/python3", "run_manager.py", "--background"])
    assert autostart.enabled()
    autostart.disable()
    assert not autostart.enabled()


async def test_quit(services):
    stopped = asyncio.Event()
    app = create_app(services, background_tasks=False, on_quit=stopped.set)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8710") as client:
        assert (await client.post("/api/quit", headers=CHANGE)).json() == {"stopping": True}
    await asyncio.wait_for(stopped.wait(), 5)
    assert (await client_without_quit(services)).status_code == 400


async def client_without_quit(services):
    app = create_app(services, background_tasks=False)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8710") as client:
        return await client.post("/api/quit", headers=CHANGE)
