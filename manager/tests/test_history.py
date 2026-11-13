"""The samples a board keeps ('hist'): read at each refresh (the gap after the network was down
fills in), and pushed as they're taken when they changed (CoAP Observe); and its button's pump runs."""

import asyncio
import time

import httpx
import pytest

from hacoap_manager import coap, simdevice
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
    services.inventory.close()  # its socket, while the event loop runs


async def add_board(client, services, server):
    fast_settings(services.settings, server)
    response = await client.post("/api/devices", json={"address": "127.0.0.1"}, headers=CHANGE)
    assert response.status_code == 200, response.text
    return response.json()


async def refresh(client):
    return (await client.post("/api/devices/1a2b3c4d/refresh", headers=CHANGE)).json()


def soils(services):
    return [r["soil_moisture"] for r in services.db.readings("1a2b3c4d")]


async def until(condition, timeout=3.0):
    deadline = time.monotonic() + timeout
    while not condition():
        if time.monotonic() > deadline:
            raise AssertionError("not in time")
        await asyncio.sleep(0.02)


def set_soil(device, soil):
    """What the board's soil sensor reads from now (the simulator models it from 'data')."""
    device.data = bytes([soil]) + device.data[1:]


def test_parse_history():
    device = simdevice.SimulatedDevice(data=bytes([30, 77, 50, 250]), power="charging")
    device.sample()
    payload, read_up_to = device.history_payload(0)
    history = coap.parse_history(payload)
    assert (history.boot, history.first, history.next, read_up_to) == (1, 0, 2, 2)
    sample = history.samples[1]
    assert (sample.seq, sample.soil_moisture, sample.battery, sample.air_humidity, sample.temperature, sample.power) == \
        (1, 30, 77, 50, -6, "charging")
    assert history.time_of(sample, 1000.0) == 1000.0 - (history.uptime_s - sample.uptime_s)
    for bad in (b"", b"\x01" * 10, payload[:-3]):
        with pytest.raises(coap.CoapError):
            coap.parse_history(bad)
    assert ["boot", "1"] in coap.describe("hist", coap.CONTENT, payload)["decoded"]


async def test_the_gap_fills_in_after_the_network_was_down(client, services, start_sim):
    server = await start_sim(dynamic=False)
    device = await add_board(client, services, server)
    assert device["no_hist_fw"] == "" and device["hist_boot"] == 1
    before = len(soils(services))
    # The network is down: its samples don't get through, it keeps them
    send, server.device.send = server.device.send, None
    for soil in (40, 35, 30):
        set_soil(server.device, soil)
        server.device.sample()
    server.device.send = send
    await refresh(client)
    assert soils(services)[before:] == [40, 35, 30]   # each one, in order
    times = [r["time"] for r in services.db.readings("1a2b3c4d")]
    assert times == sorted(times)
    # When it last sampled: its newest sample's time (for the alert when a board stops sampling)
    assert services.db.device("1a2b3c4d")["last_sample"] == times[-1]
    await refresh(client)
    assert len(soils(services)) == before + 3        # not twice
    assert services.db.device("1a2b3c4d")["last_sample"] == times[-1]  # no new sample: as it was


async def test_a_sample_that_changed_is_pushed(client, services, start_sim):
    server = await start_sim(dynamic=False)
    await add_board(client, services, server)         # registered: it observes 'hist'
    before = len(soils(services))
    set_soil(server.device, 40)                        # 2 % drier: not worth a message
    server.device.sample()
    await asyncio.sleep(0.2)
    assert len(soils(services)) == before
    set_soil(server.device, 12)                        # needs water
    server.device.sample()
    await until(lambda: services.db.device("1a2b3c4d")["soil_moisture"] == 12)
    assert soils(services)[before:] == [40, 12]        # the one not pushed came with it
    assert services.inventory.observer.notifications == 1
    assert any(a["kind"] == "dry" for a in services.db.open_alerts())   # the alert at once
    # Unplugged, and plugged in: told as it happens
    server.device.plug()
    await until(lambda: services.db.device("1a2b3c4d")["power"] == "charging")
    assert services.db.recent_activity("1a2b3c4d", "power", 1)[0]["message"] == "Plugged in: charging"


async def test_a_pump_run_time_set_elsewhere_shows_at_once(client, services, start_sim):
    server = await start_sim(dynamic=False)
    await add_board(client, services, server)         # registered: it observes 'hist'
    assert services.db.device("1a2b3c4d")["pump_s"] == 1
    # Set in Home Assistant: the board pushes without a sample, the app reads it again
    await coap.set_pump_duration("127.0.0.1", 6, **services.inventory._coap_options())
    await until(lambda: services.db.device("1a2b3c4d")["pump_s"] == 6)
    # And at each refresh: its 'diag' tells it
    server.device.settings["pump_s"] = 8
    await refresh(client)
    assert services.db.device("1a2b3c4d")["pump_s"] == 8



async def test_a_pump_run_from_another_app_is_counted(client, services, start_sim, monkeypatch):
    from hacoap_manager import inventory
    monkeypatch.setattr(inventory, "OWN_RUN_WAIT_S", 1.5)
    server = await start_sim(dynamic=False)
    await add_board(client, services, server)         # its pump time so far: before the app knew it
    pumped = lambda: [a["message"] for a in services.db.activity("1a2b3c4d") if a["kind"] == "pump"]
    # Started by Home Assistant: when the run ends the board pushes, the app reads its 'diag'
    await coap.set_pump("127.0.0.1", True, **services.inventory._coap_options())
    await until(lambda: pumped() == ["Pump run from another app (1 s)"])
    assert services.inventory.describe(services.db.device("1a2b3c4d"))["tank"] is None  # no tank: just noted
    # Started from the app: its own note, not another app's
    response = await client.post("/api/devices/1a2b3c4d/pump", json={"on": True}, headers=CHANGE)
    assert response.status_code == 200
    await asyncio.sleep(1.7)                          # the run, its push, and the wait for its note
    await refresh(client)
    assert pumped() == ["Pump run from another app (1 s)", "Pump started from the app (1 s)"]
    # Its button: noted as its button's
    server.device.press_button()
    await asyncio.sleep(0.3)
    await refresh(client)                             # while it runs: the rest of it is noted already
    await asyncio.sleep(1.2)
    await refresh(client)
    assert pumped()[2:] == ["Pump run with its button (1 s)"]

async def test_after_a_restart_its_samples_start_again(client, services, start_sim):
    server = await start_sim(dynamic=False)
    await add_board(client, services, server)
    before = len(soils(services))
    set_soil(server.device, 40)                       # its first boot goes on a while
    server.device.sample()
    server.device.sample()
    await refresh(client)
    await asyncio.sleep(2.2)                          # later
    server.device.reset()                             # its samples start again from 0
    await asyncio.sleep(0.4)
    set_soil(server.device, 25)
    server.device.sample()
    device = await refresh(client)
    assert device["hist_boot"] == 2 and device["boots"] == 2
    assert soils(services)[before:] == [40, 40, 40, 25]  # the first boot's, its new boot sample, and the new one


async def test_more_samples_than_fit_in_one_answer(client, services, start_sim):
    server = await start_sim(dynamic=False)
    await add_board(client, services, server)
    before = len(soils(services))
    server.device.send = None
    for i in range(120):
        set_soil(server.device, i % 100)
        server.device.sample()
    await refresh(client)
    assert len(soils(services)) == before + 120


async def test_older_firmware_without_hist(client, services, start_sim):
    server = await start_sim(dynamic=False, history=False)
    device = await add_board(client, services, server)
    assert device["no_hist_fw"] == device["fw_version"]   # not asked again
    count = len(soils(services))
    await refresh(client)
    assert len(soils(services)) == count + 1              # a reading from 'data', as before
    assert services.db.device("1a2b3c4d")["button_s"] is None


async def test_the_buttons_pump_runs_count_in_its_tank(client, services, start_sim):
    server = await start_sim(dynamic=False)
    await add_board(client, services, server)
    await client.patch("/api/devices/1a2b3c4d", json={"tank_ml": 1000, "pump_ml_s": 50}, headers=CHANGE)
    server.device.settings["pump_s"] = 3
    server.device.press_button()
    server.device.press_button()
    device = await refresh(client)
    runs = services.db.recent_activity("1a2b3c4d", "pump", 5)
    assert [r["message"] for r in runs] == ["Pump run with its button (6 s)"]
    assert device["tank"]["used_ml"] == 300
    await refresh(client)
    assert len(services.db.recent_activity("1a2b3c4d", "pump", 5)) == 1   # counted once


async def test_a_silent_ping_to_every_board(client, services, start_sim):
    """Ping all: each board answers, without beeping, and the map is told each way (ping, pong with
    its round trip)."""
    server = await start_sim(dynamic=False)
    await add_board(client, services, server)
    with services.events.subscribe() as queue:
        response = await client.post("/api/network/ping-all", headers=CHANGE)
        events = []
        while not queue.empty():
            events.append(queue.get_nowait())
    assert response.status_code == 200
    [result] = response.json()
    assert result["device_id"] == "1a2b3c4d" and result["ok"] and result["ms"] >= 0
    assert server.device.pings == 0  # it didn't beep
    traffic = [(e["what"], e.get("ms") is not None) for e in events if e["type"] == "traffic"]
    assert traffic == [("ping", False), ("pong", True)]
    # A board that doesn't answer (nothing at its address): lost
    services.db.upsert_device("1a2b3c4d", address="127.0.0.9")
    services.settings.coap_timeout_s = 0.5
    [result] = (await client.post("/api/network/ping-all", headers=CHANGE)).json()
    assert not result["ok"] and result["ms"] is None
    # Both pings are its round-trip history (the answer, then none), and Home Assistant gets the last
    history = (await client.get("/api/network/round-trips")).json()["1a2b3c4d"]
    assert [ms is None for _, ms in history["points"]] == [False, True]
    assert history["answered_pct"] == 50 and history["median_ms"] >= 0 and history["last"]["ms"] is None
    [plant] = (await client.get("/api/ha/plants")).json()["devices"]
    assert plant["round_trip"]["ms"] is None and plant["round_trip"]["time"] > 0
    # Its page's Round trip chart
    trips = (await client.get("/api/devices/1a2b3c4d/details?days=1")).json()["round_trips"]
    assert [p["ms"] is None for p in trips] == [False, True]


def test_round_trip_history():
    from hacoap_manager.network import round_trip_history
    now = 1_000_000
    rows = [{"device_id": "a", "time": now - 8 * 86400, "ms": 9000},   # older than the week: left out
            {"device_id": "a", "time": now - 3600 * 3, "ms": 1000},
            {"device_id": "a", "time": now - 3600 * 2, "ms": None},
            {"device_id": "a", "time": now - 3600, "ms": 3000},
            {"device_id": "b", "time": now - 60, "ms": None}]
    history = round_trip_history(rows, now=now)
    assert history["a"]["points"] == [[now - 10800, 1000], [now - 7200, None], [now - 3600, 3000]]
    assert (history["a"]["median_ms"], history["a"]["answered_pct"]) == (3000, 67)
    assert history["b"] == {"points": [[now - 60, None]], "median_ms": None, "answered_pct": 0,
                            "last": {"time": now - 60, "ms": None}}
