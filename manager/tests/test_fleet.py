"""The fleet features: history and forecasts, release and outdated devices, the dashboard,
pump controls, staged updates, the channel scan, the floor plan, the console, setup, and
"what's new" between firmware commits."""

import asyncio
import subprocess
import sys
import time
import textwrap

import httpx
import pytest

from hacoap_manager import fleet
from hacoap_manager.app import create_app, create_services
from hacoap_manager.setup_tools import SetupError, SetupRunner, generate_pskd, valid_pskd
from hacoap_manager.simborder import SimulatedBorderRouter, scenario

from conftest import NEW_HASH, NEW_IMAGE, OLD_HASH, fast_settings

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


# ---------------------------------------------------------------- forecasts and status

def test_battery_forecast():
    now = time.time()
    draining = [{"time": now - DAY * (10 - d), "battery": 80 - d * 2} for d in range(11)]  # 2 %/day
    forecast = fleet.battery_forecast(draining)
    assert forecast["per_day"] == pytest.approx(-2, abs=0.01)
    assert forecast["days_left"] == pytest.approx(30, abs=0.1)  # 60 % left at 2 %/day
    charging = [{"time": now - DAY * (3 - d), "battery": 50 + d * 5} for d in range(4)]
    assert fleet.battery_forecast(charging) is None
    assert fleet.battery_forecast(draining[:2]) is None                              # too few readings
    assert fleet.battery_forecast([{"time": now - 60 * i, "battery": 80} for i in range(5)]) is None  # too short


def test_image_status():
    release = {"hash": NEW_HASH}
    assert fleet.image_status({"image_hash": NEW_HASH}, release) == "current"
    assert fleet.image_status({"image_hash": OLD_HASH}, release) == "outdated"
    assert fleet.image_status({"image_hash": ""}, release) == "unknown"
    assert fleet.image_status({"image_hash": OLD_HASH}, None) == "no-release"


# ---------------------------------------------------------------- devices, dashboard, release

async def test_refresh_records_history_and_the_dashboard_sees_it(client, services, start_sim):
    server = await start_sim()
    fast_settings(services.settings, server)
    await client.post("/api/devices", json={"address": "127.0.0.1"}, headers=CHANGE)
    # Two weeks of readings, draining 1 %/day
    for day in range(14):
        services.db.add_reading("1a2b3c4d", 30 - day, 40, 50, 20, when=time.time() - DAY * (14 - day))
    await client.post("/api/devices/1a2b3c4d/refresh", headers=CHANGE)

    details = (await client.get("/api/devices/1a2b3c4d/details")).json()
    assert details["readings"][-1]["battery"] == 87  # the refresh's reading
    assert details["health"]["image_status"] == "no-release"

    services.db.add_reading("1a2b3c4d", 15, 40, 50, 20)  # and now low
    services.db.upsert_device("1a2b3c4d", battery=15)
    board = (await client.get("/api/dashboard")).json()
    assert board["counts"]["devices"] == 1 and board["counts"]["online"] == 1
    assert [d["device_id"] for d in board["low_battery"]] == ["1a2b3c4d"]


async def test_release_and_outdated(client, services, start_sim):
    server = await start_sim()
    fast_settings(services.settings, server)
    await client.post("/api/devices", json={"address": "127.0.0.1"}, headers=CHANGE)
    await client.post("/api/images", content=NEW_IMAGE, headers=CHANGE)
    assert (await client.post("/api/release", json={"image_hash": NEW_HASH}, headers=CHANGE)).json()["release"]["hash"] == NEW_HASH

    board = (await client.get("/api/dashboard")).json()
    assert [d["device_id"] for d in board["unknown"]] == ["1a2b3c4d"]   # slots not read yet
    assert (await client.post("/api/slots/read-all", headers=CHANGE)).json() == {"1a2b3c4d": ""}
    board = (await client.get("/api/dashboard")).json()
    assert [d["device_id"] for d in board["outdated"]] == ["1a2b3c4d"]
    assert board["firmware"][0]["image_hash"] == OLD_HASH
    assert (await client.post("/api/release", json={"image_hash": "00"}, headers=CHANGE)).status_code == 404


async def test_tags_location_plant(client, services):
    services.db.upsert_device("aa")
    device = (await client.patch("/api/devices/aa", json={"tags": "Greenhouse, balcony,greenhouse", "location": "shed",
                                                           "plant": "basil"}, headers=CHANGE)).json()
    assert (device["tags"], device["location"], device["plant"]) == ("balcony,greenhouse", "shed", "basil")


async def test_pump_controls(client, services, start_sim):
    server = await start_sim()
    fast_settings(services.settings, server)
    await client.post("/api/devices", json={"address": "127.0.0.1"}, headers=CHANGE)
    state = (await client.post("/api/devices/1a2b3c4d/pump", json={"seconds": 3}, headers=CHANGE)).json()
    assert state == {"running": False, "duration": 3}
    state = (await client.post("/api/devices/1a2b3c4d/pump", json={"on": True}, headers=CHANGE)).json()
    assert state["running"] and server.device.pump_running
    state = (await client.post("/api/devices/1a2b3c4d/pump", json={"on": False}, headers=CHANGE)).json()
    assert not state["running"]
    assert (await client.post("/api/devices/1a2b3c4d/pump", json={"seconds": 12}, headers=CHANGE)).status_code == 400


# ---------------------------------------------------------------- staged updates

async def test_staged_update_waits_after_the_first_device(client, services, start_sim):
    first = await start_sim()
    fast_settings(services.settings, first)
    try:
        await start_sim("::1", smp_port=first.smp_port, coap_port=first.coap_port)
    except OSError:
        pytest.skip("no IPv6 loopback")
    services.db.upsert_device("aaaa", address="127.0.0.1")
    services.db.upsert_device("bbbb", address="::1")
    await client.post("/api/images", content=NEW_IMAGE, headers=CHANGE)
    job = (await client.post("/api/updates", json={"image_hash": NEW_HASH, "staged": True, "allow_unverified": True,
                                                    "targets": [{"device_id": "aaaa"}, {"device_id": "bbbb"}]},
                             headers=CHANGE)).json()
    for _ in range(600):
        job = (await client.get(f"/api/updates/{job['id']}")).json()
        if job["state"] == "paused":
            break
        await asyncio.sleep(0.05)
    assert job["state"] == "paused"
    assert [t["status"] for t in job["targets"]] == ["updated", "queued"]

    assert (await client.post(f"/api/updates/{job['id']}/continue", headers=CHANGE)).status_code == 200
    job = await asyncio.wait_for(services.updates.wait(job["id"]), 60)
    assert [t.status for t in job.targets] == ["updated", "updated"]


# ---------------------------------------------------------------- network: scan, floor plan, link history

@pytest.fixture
def border():
    sim = SimulatedBorderRouter("api", net=scenario()).start()
    yield sim
    sim.stop()


async def test_channel_scan(client, services, border):
    assert (await client.post("/api/network/channel-scan", headers=CHANGE)).status_code == 400  # no address yet
    services.settings.border_router_url = border.url
    scan = (await client.post("/api/network/channel-scan", headers=CHANGE)).json()
    assert scan["current_channel"] == 15
    channels = {c["channel"]: c for c in scan["channels"]}
    assert set(channels) == set(range(11, 27))
    assert channels[18]["max_rssi"] > channels[15]["max_rssi"]  # the Wi-Fi-like noise
    assert (await client.get("/api/network")).json()["channel_scan"]["current_channel"] == 15


async def test_channel_scan_needs_the_current_api(client, services):
    sim = SimulatedBorderRouter("legacy").start()
    try:
        services.settings.border_router_url = sim.url
        response = await client.post("/api/network/channel-scan", headers=CHANGE)
        assert response.status_code == 400 and "2025+" in response.json()["detail"]
    finally:
        sim.stop()


async def test_network_refresh_records_link_history(client, services, border):
    services.db.upsert_device("1a2b3c4d", name="basil", address="fd11:22::1")
    services.settings.border_router_url = border.url
    await client.post("/api/network/refresh", headers=CHANGE)
    links = (await client.get("/api/devices/1a2b3c4d/details")).json()["links"]
    assert links[0]["parent"] == "0x5000" and links[0]["link_margin"] == 62
    assert (await client.get("/api/network")).json()["topology"]["border_router"]["channel"] == 15


PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


async def test_floor_plan(client, services):
    assert (await client.get("/api/network/floorplan")).status_code == 404
    assert (await client.post("/api/network/floorplan", content=b"<svg/>", headers=CHANGE)).status_code == 400
    assert (await client.post("/api/network/floorplan?name=house.png", content=PNG, headers=CHANGE)).status_code == 200
    response = await client.get("/api/network/floorplan")
    assert response.headers["content-type"] == "image/png" and response.content == PNG

    assert (await client.put("/api/network/positions/1a2b3c4d", json={"x": 0.25, "y": 0.5}, headers=CHANGE)).status_code == 200
    assert (await client.put("/api/network/positions/x", json={"x": 2, "y": 0.5}, headers=CHANGE)).status_code == 400
    state = (await client.get("/api/network")).json()
    assert state["positions"] == {"1a2b3c4d": {"x": 0.25, "y": 0.5}} and state["floorplan"]["name"] == "house.png"
    await client.put("/api/network/positions/1a2b3c4d", json={"x": None}, headers=CHANGE)
    assert (await client.get("/api/network")).json()["positions"] == {}
    await client.delete("/api/network/floorplan", headers=CHANGE)
    assert (await client.get("/api/network")).json()["floorplan"] is None


# ---------------------------------------------------------------- console

async def test_console_echoes_on_a_loopback_port(client, services):
    state = (await client.post("/api/console/open", json={"port": "loop://"}, headers=CHANGE)).json()
    assert state["open"] and state["port"] == "loop://"
    await client.post("/api/console/send", json={"text": "\x1b[0;32mhello board\x1b[0m"}, headers=CHANGE)
    for _ in range(50):
        lines = (await client.get("/api/console")).json()["lines"]
        if lines:
            break
        await asyncio.sleep(0.05)
    assert lines == ["hello board"]  # colour codes removed
    assert not (await client.post("/api/console/close", headers=CHANGE)).json()["open"]
    assert (await client.post("/api/console/send", json={"text": "x"}, headers=CHANGE)).status_code == 400


async def test_console_and_usb_update_dont_share_a_port(client, services):
    await client.post("/api/console/open", json={"port": "loop://"}, headers=CHANGE)
    await client.post("/api/images", content=NEW_IMAGE, headers=CHANGE)
    response = await client.post("/api/updates", json={"image_hash": NEW_HASH, "allow_unverified": True, "targets": [
        {"transport": "serial", "serial_port": "loop://"}]}, headers=CHANGE)
    assert response.status_code == 400 and "console" in response.json()["detail"]


# ---------------------------------------------------------------- setup

def test_pskd_generation():
    for _ in range(50):
        pskd = generate_pskd()
        assert valid_pskd(pskd) and not set(pskd) & set("IOQZ")
    assert not valid_pskd("SHORT") and not valid_pskd("HAS-DASH1") and not valid_pskd("ABCDEFIO")


def test_set_pskd(tmp_path):
    application = tmp_path / "application"
    application.mkdir()
    (application / "local.conf.example").write_text('# my settings\nCONFIG_OPENTHREAD_JOINER_PSKD="REPLACE-ME"\n')
    runner = SetupRunner(tmp_path, events=None)
    pskd = runner.set_pskd()
    text = (application / "local.conf").read_text()
    assert f'CONFIG_OPENTHREAD_JOINER_PSKD="{pskd}"' in text and "# my settings" in text
    runner.set_pskd("abcdef")
    assert 'CONFIG_OPENTHREAD_JOINER_PSKD="ABCDEF"' in (application / "local.conf").read_text()
    with pytest.raises(SetupError):
        runner.set_pskd("BAD!")


async def test_setup_runs_a_script_and_refuses_a_second_key(tmp_path):
    (tmp_path / "application" / "keys").mkdir(parents=True)
    script = tmp_path / "fake_setup.py"
    script.write_text(textwrap.dedent("""
        import sys
        print("installing", sys.argv[1])
        sys.exit(0)
    """))

    class Events:
        def __init__(self):
            self.seen = []

        def publish(self, kind, **data):
            self.seen.append((kind, data))

    events = Events()
    runner = SetupRunner(tmp_path, events, command=lambda repo, name: [sys.executable, str(script), name])
    runner.start("install")
    state = await asyncio.wait_for(runner.wait(), 30)
    assert state["state"] == "done"
    assert "installing setup" in runner.log
    (tmp_path / "application" / "keys" / "mcuboot-signing-key.pem").write_text("key")
    with pytest.raises(SetupError, match="already exists"):
        runner.start("keygen")
    with pytest.raises(SetupError, match="Unknown"):
        runner.start("format-disk")


async def test_setup_api(client, services):
    state = (await client.get("/api/setup")).json()
    names = {c["name"]: c for c in state["checks"]}
    assert names["Private signing key"]["fix"] == "keygen" and names["SDK"]["fix"] == "install"
    assert (await client.post("/api/setup/format-disk", headers=CHANGE)).status_code == 400


# ---------------------------------------------------------------- what's new

def git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, check=True).stdout.strip()


async def test_whats_new_between_commits(tmp_path, services, client):
    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "-q")
    git(repo, "config", "user.email", "test@example.com")
    git(repo, "config", "user.name", "Test")
    commits = []
    for message in ("First", "Flashing LEDs", "3 s poll"):
        (repo / "f.txt").write_text(message)
        git(repo, "add", ".")
        git(repo, "commit", "-q", "-m", message)
        commits.append(git(repo, "rev-parse", "--short", "HEAD"))
    services.repository = repo
    services.db.upsert_device("aa", fw_version=commits[0])
    services.images.add(NEW_IMAGE, "app_update.bin", git_commit=commits[2])

    result = (await client.get(f"/api/images/{NEW_HASH}/changes", params={"device_id": "aa"})).json()
    assert [c["subject"] for c in result["added"]] == ["3 s poll", "Flashing LEDs"]
    assert result["removed"] == []

    services.db.upsert_device("aa", fw_version="unknown")
    response = await client.get(f"/api/images/{NEW_HASH}/changes", params={"device_id": "aa"})
    assert response.status_code == 400
