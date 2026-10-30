"""What the boards report about themselves and keep: restarts and crashes ('diag'), their link
to their parent, and their settings (the firmware's 'hacoap' mcumgr group). Also: removing
the simulated boards."""

import asyncio
import time

import httpx
import pytest

from hacoap_manager import coap, discovery, feed, fleet, simdevice
from hacoap_manager.app import create_app, create_services

from conftest import fast_settings

CHANGE = {"X-HACoap": "1"}


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


async def add_board(client, services, server):
    fast_settings(services.settings, server)
    response = await client.post("/api/devices", json={"address": "127.0.0.1"}, headers=CHANGE)
    assert response.status_code == 200, response.text
    return response.json()


async def refresh(client):
    return (await client.post("/api/devices/1a2b3c4d/refresh", headers=CHANGE)).json()


# ---------------------------------------------------------------- 'diag'

def test_parse_diag():
    diag = coap.parse_diag(b"boots=12,up=3600,reset=crash,fault=3@0001a2b4,role=child,rloc=5c01,parent=5c00,"
                           b"rssi=-62,last_rssi=-60,lq=3,soil_mv=1696")
    assert (diag.boots, diag.uptime_s, diag.reset, diag.fault) == (12, 3600, "crash", "3@0001a2b4")
    assert (diag.rloc16, diag.parent, diag.rssi, diag.link_quality, diag.soil_mv) == ("0x5c01", "0x5c00", -62, 3, 1696)
    detached = coap.parse_diag(b"boots=1,up=5,reset=power,role=detached,soil_mv=-1")
    assert (detached.rloc16, detached.rssi, detached.soil_mv, detached.fault) == ("", None, None, "")
    with pytest.raises(coap.CoapError):
        coap.parse_diag(b"garbage")


async def test_a_refresh_reads_diag_and_records_restarts(client, services, start_sim):
    server = await start_sim(dynamic=False)
    device = await add_board(client, services, server)
    assert (device["boots"], device["reset_cause"], device["rloc16"], device["parent_rssi"]) == (1, "power", "0x5001", -62)
    assert device["soil_mv"] > 0 and device["uptime_s"] >= 0
    assert services.db.recent_activity("1a2b3c4d", "restart", 10) == []  # the first answer is no restart

    # An update's reset: recorded, no alert
    server.device.reset()
    time.sleep(0.35)
    device = await refresh(client)
    assert (device["boots"], device["reset_cause"]) == (2, "soft")
    restarts = services.db.recent_activity("1a2b3c4d", "restart", 10)
    assert len(restarts) == 1 and "software reset" in restarts[0]["message"]
    assert not [a for a in services.db.open_alerts() if a["kind"] == "restart"]

    # A crash, then a watchdog reset, between two refreshes: one entry, an alert
    server.device.crash()
    server.device.reset("watchdog")
    time.sleep(0.35)
    device = await refresh(client)
    assert device["reset_cause"] == "watchdog"
    newest = services.db.recent_activity("1a2b3c4d", "restart", 10)[0]["message"]
    assert "watchdog" in newest and "2 restarts since the last check" in newest
    alerts = [a for a in services.db.open_alerts() if a["kind"] == "restart"]
    assert len(alerts) == 1
    services.alerts.scan()  # an event: it stays until dismissed
    assert [a for a in services.db.open_alerts() if a["kind"] == "restart"]

    # On the device's page, the dashboard and the activity feed
    details = (await client.get("/api/devices/1a2b3c4d/details")).json()
    assert len(details["restarts"]) == 2
    board = fleet.restarts(services.db, {"1a2b3c4d": "basil"})[0]
    assert (board["name"], board["count"], board["bad"]) == ("basil", 2, 1)
    kinds = [e["kind"] for e in feed.build(services.db, services.inventory, services.photos)]
    assert "restart" in kinds


async def test_a_crash_says_where(client, services, start_sim):
    server = await start_sim(dynamic=False)
    await add_board(client, services, server)
    server.device.crash(4, 0x2B4C0)
    time.sleep(0.35)
    device = await refresh(client)
    assert (device["reset_cause"], device["fault"]) == ("crash", "4@0002b4c0")
    alert = services.alerts.state()["open"][-1]
    assert alert["message"] == "ha-coap-1a2b3c4d restarted: a crash (fatal error 4 at 0x0002b4c0)"


async def test_older_firmware_is_not_asked_for_diag_again(client, services, start_sim):
    server = await start_sim(dynamic=False, diag=False)
    device = await add_board(client, services, server)
    assert device["boots"] is None and device["no_diag_fw"] == device["fw_version"]
    assert device["last_error"] == "" and device["online"]
    started = time.monotonic()
    await refresh(client)
    assert time.monotonic() - started < 0.5  # no wait for an answer that never comes

    # After an update to a firmware with 'diag', it's asked again
    server.device.diag = True
    services.db.upsert_device("1a2b3c4d", fw_version="older")
    device = await refresh(client)
    assert device["boots"] == 1 and device["no_diag_fw"] == ""


# ---------------------------------------------------------------- settings on the board

async def test_read_and_change_the_boards_settings(client, services, start_sim):
    server = await start_sim(dynamic=False)
    await add_board(client, services, server)
    path = "/api/devices/1a2b3c4d/board-settings"
    settings = (await client.post(f"{path}/read", json={}, headers=CHANGE)).json()
    assert settings["settings"]["sample_s"] == {"value": 900, "default": 900, "min": 10, "max": 86400}
    assert settings["soil_mv"] > 0

    changed = (await client.put(path, json={"values": {"sample_s": 600, "pump_s": 3}}, headers=CHANGE)).json()
    assert changed["settings"]["sample_s"]["value"] == 600 and server.device.pump_duration == 3
    activity = services.db.recent_activity("1a2b3c4d", "settings", 5)
    assert activity[0]["message"] == "Settings changed: sampling period (s) 900 → 600, pump run time (s) 1 → 3"

    # Refused: out of range, dry under wet, an unknown name. Nothing changes.
    for values in ({"sample_s": 5}, {"soil_dry_mv": 900}, {"nope": 1}):
        response = await client.put(path, json={"values": values}, headers=CHANGE)
        assert response.status_code == 400, values
    assert server.device.settings["sample_s"] == 600 and server.device.settings["soil_dry_mv"] == 2200
    assert (await client.put(path, json={"values": {}}, headers=CHANGE)).status_code == 400


async def test_calibrating_the_soil_sensor(client, services, start_sim):
    server = await start_sim(dynamic=False)  # soil 42 % with the default calibration
    await add_board(client, services, server)
    path = "/api/devices/1a2b3c4d/board-settings"
    measured = (await client.post(f"{path}/sample", json={}, headers=CHANGE)).json()
    assert measured["samples"] == 2 and measured["soil_mv"] == server.device.soil_mv()
    assert services.db.device("1a2b3c4d")["soil_mv"] == measured["soil_mv"]

    # Calibrated so that this soil reads as dry: the readings follow
    await client.put(path, json={"values": {"soil_dry_mv": measured["soil_mv"], "soil_wet_mv": 900}}, headers=CHANGE)
    assert (await refresh(client))["soil_moisture"] == 0


async def test_older_firmware_has_no_settings(client, services, start_sim):
    server = await start_sim(dynamic=False, diag=False)
    await add_board(client, services, server)
    response = await client.post("/api/devices/1a2b3c4d/board-settings/read", json={}, headers=CHANGE)
    assert response.status_code == 400 and "firmware can't do this" in response.json()["detail"]


async def test_the_same_settings_on_several_boards(client, services, start_sim):
    server = await start_sim(dynamic=False)
    await add_board(client, services, server)
    services.db.upsert_device("5e6f7a8b", name="fern")  # no address
    response = await client.post("/api/board-settings", json={"device_ids": ["1a2b3c4d", "5e6f7a8b"],
                                                               "values": {"poll_ms": 5000}}, headers=CHANGE)
    results = response.json()["results"]
    assert results["1a2b3c4d"] == "" and "no network address" in results["5e6f7a8b"]
    assert server.device.settings["poll_ms"] == 5000
    assert (await client.post("/api/board-settings", json={"device_ids": []}, headers=CHANGE)).status_code == 400


# ---------------------------------------------------------------- the map: boards named by their own report

def legacy_topology():
    """An older border router's view: a child without addresses, no signal for its link."""
    return {"nodes": [{"id": "r1", "rloc16_hex": "0x5c00", "ipv6": [], "kind": "router"},
                      {"id": "c1", "rloc16_hex": "0x5c01", "ipv6": [], "kind": "child", "parent": "r1"}],
            "links": [{"a": "c1", "b": "r1", "kind": "child", "link_quality_in": None, "link_quality_out": None,
                       "link_margin": None, "average_rssi": None, "last_rssi": None}]}


def test_a_board_is_named_by_its_short_address(services):
    services.db.upsert_device("1a2b3c4d", name="basil", rloc16="0x5c01", parent_rloc16="0x5c00", parent_rssi=-70,
                              link_quality=2, diag_time=time.time())
    topology = legacy_topology()
    services.network._name_boards(topology)
    child = topology["nodes"][1]
    assert (child["device_id"], child["name"], child["named_by"]) == ("1a2b3c4d", "basil", "rloc16")
    link = topology["links"][0]
    assert (link["average_rssi"], link["link_quality_in"], link["from_board"]) == (-70, 2, True)


def test_an_old_report_names_nothing(services):
    services.db.upsert_device("1a2b3c4d", name="basil", rloc16="0x5c01", diag_time=time.time() - 3 * 86400)
    topology = legacy_topology()
    services.network._name_boards(topology)
    assert "device_id" not in topology["nodes"][1]


def test_a_border_router_measure_wins(services):
    services.db.upsert_device("1a2b3c4d", name="basil", address="fd11::1", rloc16="0x5c01", parent_rloc16="0x5c00",
                              parent_rssi=-70, link_quality=2, diag_time=time.time())
    topology = legacy_topology()
    topology["nodes"][1]["ipv6"] = ["fd11::1"]
    topology["links"][0]["link_margin"] = 30
    services.network._name_boards(topology)
    assert topology["nodes"][1]["device_id"] == "1a2b3c4d" and "named_by" not in topology["nodes"][1]
    assert topology["links"][0]["average_rssi"] is None and "from_board" not in topology["links"][0]


# ---------------------------------------------------------------- the simulated boards

async def test_removing_the_simulated_boards(client, services):
    services.db.upsert_device("aaaa0001", name="sim", address="127.0.0.2")
    services.db.upsert_device("aaaa0002", name="sim v6", address="::1")
    services.db.upsert_device("bbbb0001", name="real", address="fd11:22::1")
    services.db.add_reading("aaaa0001", 80, 40, 50, 20)
    services.db.add_activity("aaaa0001", "restart", "Restarted: power on")
    removed = (await client.post("/api/devices/remove-simulated", headers=CHANGE)).json()["removed"]
    assert sorted(removed) == ["aaaa0001", "aaaa0002"]
    assert [d["device_id"] for d in services.db.devices()] == ["bbbb0001"]
    assert services.db.readings("aaaa0001", 0) == [] and services.db.recent_activity("aaaa0001", "restart", 5) == []


async def test_the_pump_run_time_is_remembered(client, services, start_sim):
    server = await start_sim(dynamic=False)
    device = await add_board(client, services, server)
    assert device["pump_s"] is None  # not read yet
    state = (await client.post("/api/devices/1a2b3c4d/pump", json={"seconds": 5}, headers=CHANGE)).json()
    assert state["duration"] == 5 and server.device.pump_duration == 5
    assert (await client.get("/api/devices/1a2b3c4d/details")).json()["device"]["pump_s"] == 5

    # Changed as a setting: the record follows
    await client.put("/api/devices/1a2b3c4d/board-settings", json={"values": {"pump_s": 7}}, headers=CHANGE)
    assert services.db.device("1a2b3c4d")["pump_s"] == 7


async def test_forgetting_the_network(client, services, start_sim):
    server = await start_sim(dynamic=False)
    await add_board(client, services, server)
    device = (await client.post("/api/devices/1a2b3c4d/forget-network", json={}, headers=CHANGE)).json()
    assert device["last_error"].startswith("Forgot its network")
    assert services.db.recent_activity("1a2b3c4d", "network", 5)[0]["message"].startswith("Told to forget")
    await asyncio.sleep(0.3)  # the board answers, then resets
    assert server.device.resets == 1 and server.device.boots == 2


# ---------------------------------------------------------------- SRP: the boards' names

async def test_the_name_registration_is_reported(client, services, start_sim):
    server = await start_sim(dynamic=False)
    device = await add_board(client, services, server)
    assert device["srp_state"] == "registered"
    assert server.device.srp_server.advertised("ha-coap-1a2b3c4d")


async def test_forgetting_keeps_the_name(client, services, start_sim):
    """The board removes its registration, keeps its SRP key, and takes its name back."""
    srp = simdevice.SimulatedSrpServer()
    server = await start_sim(dynamic=False, srp_server=srp)
    key = server.device.srp_key
    server.device.forget_network(rejoin_s=0.2)
    assert not srp.advertised("ha-coap-1a2b3c4d")          # gone from the LAN at once
    await asyncio.sleep(0.3)
    assert server.device.srp_key == key and server.device.srp_state == "registered"
    assert srp.advertised("ha-coap-1a2b3c4d")


async def test_a_new_key_cant_take_the_name(start_sim):
    """What happened when forgetting the network also erased the SRP key: the border router
    keeps the name for the old key, and refuses the board's new registration for 14 days."""
    srp = simdevice.SimulatedSrpServer()
    server = await start_sim(dynamic=False, srp_server=srp, forget_wipes_srp_key=True)
    server.device.forget_network(rejoin_s=0.2)
    await asyncio.sleep(0.3)
    assert server.device.srp_state == "failed" and not srp.advertised("ha-coap-1a2b3c4d")
    assert "srp=failed" in server.device.diag_payload().decode()


def test_txt_records_are_read():
    txt = discovery.txt_records({b"id": b"1a2b3c4d", b"fw": b"f83f898", b"hw": b"v2.0", b"sim": b"1", b"flag": None})
    assert txt == {"id": "1a2b3c4d", "fw": "f83f898", "hw": "v2.0", "sim": "1", "flag": ""}


async def test_found_boards_say_what_they_run(services):
    async def discover(timeout):
        return [discovery.Found("ha-coap-1a2b3c4d", "1a2b3c4d", "fd11::1", {"fw": "f83f898", "hw": "v2.0"}),
                discovery.Found("ha-coap-5e6f7a8b", "5e6f7a8b", "fd11::2", {})]  # older firmware: no TXT

    services.inventory._discover = discover
    await services.inventory.discover()
    assert (services.db.device("1a2b3c4d")["fw_version"], services.db.device("1a2b3c4d")["hw_version"]) == ("f83f898", "v2.0")
    assert services.db.device("5e6f7a8b")["fw_version"] == ""


# ---------------------------------------------------------------- the page's data: timeline, graph, fleet health

async def test_a_boards_timeline(client, services):
    services.db.upsert_device("1a2b3c4d", name="basil")
    now = time.time()
    services.db.add_update("job", "1a2b3c4d", "udp", "ab" * 32, "1.1.0", now - 300, now - 200, "updated", "Updated and confirmed")
    services.db.add_activity("1a2b3c4d", "restart", "Restarted: a software reset", when=now - 190)
    services.db.add_activity("1a2b3c4d", "pump", "Pump started from the app (3 s)", when=now - 100)
    services.db.add_network_event("1a2b3c4d", "basil: parent changed from 0x5000 to 0x6800")
    entries = (await client.get("/api/devices/1a2b3c4d/timeline")).json()
    assert [e["kind"] for e in entries][:3] == ["parent", "pump", "restart"]          # newest first
    update = next(e for e in entries if e["kind"] == "update")
    assert update["detail"]["result"] == "updated" and update["detail"]["message"] == "Updated and confirmed"
    assert next(e for e in entries if e["kind"] == "parent")["text"] == "parent changed from 0x5000 to 0x6800"
    assert (await client.get("/api/devices/nope/timeline")).status_code == 404


async def test_every_board_on_one_chart(client, services):
    now = time.time()
    for device_id, name in (("aaaa0001", "basil"), ("aaaa0002", "fern")):
        services.db.upsert_device(device_id, name=name)
        for i in range(600):  # more than a chart's points: averaged
            services.db.add_reading(device_id, 80, 40 + i % 5, 50, 20, when=now - (600 - i) * 600)
    series = (await client.get("/api/graph?metric=soil_moisture&days=7")).json()
    assert [s["name"] for s in series] == ["basil", "fern"]
    assert 0 < len(series[0]["points"]) <= fleet.GRAPH_POINTS
    assert all(40 <= v <= 44 for _, v in series[0]["points"])
    only = (await client.get("/api/graph?metric=battery&days=1&device_ids=aaaa0002")).json()
    assert [s["name"] for s in only] == ["fern"] and only[0]["points"][0][1] == 80
    assert (await client.get("/api/graph?metric=nope")).status_code == 400


async def test_fleet_health(client, services):
    services.db.upsert_device("aaaa0001", name="basil")
    services.db.add_activity("aaaa0001", "restart", "Restarted: the watchdog: it stopped responding")
    services.db.add_activity("aaaa0001", "restart", "Restarted: a software reset")
    rows = {r["device_id"]: r for r in (await client.get("/api/fleet-health")).json()}
    assert (rows["aaaa0001"]["restarts"], rows["aaaa0001"]["bad_restarts"]) == (2, 1)
    assert rows["aaaa0001"]["image_status"] == "no-release"


async def test_the_page_can_be_installed(client):
    assert 'rel="manifest"' in (await client.get("/")).text
    manifest = (await client.get("/static/manifest.json")).json()
    assert manifest["display"] == "standalone" and manifest["start_url"] == "/"
    for icon in manifest["icons"]:
        assert (await client.get(icon["src"])).headers["content-type"] == "image/png"
