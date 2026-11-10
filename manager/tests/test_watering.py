"""Watering: the water tanks (how full, from the pump's runs; refilling) and the waterings that
didn't reach the plant."""

import time

import httpx
import pytest

from hacoap_manager import fleet
from hacoap_manager.app import create_app, create_services
from hacoap_manager.config import Settings

CHANGE = {"X-HACoap": "1"}
HOUR = 3600


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


def test_tank_state():
    settings = Settings()
    assert fleet.tank_state({"tank_ml": None}, [], settings) is None          # not tracked
    tank = fleet.tank_state({"tank_ml": 1000, "pump_ml_s": None, "tank_filled": 5.0}, [(10, 5), (20, 10)], settings)
    assert (tank["used_ml"], tank["left_ml"], tank["percent"], tank["low"], tank["runs"]) == (300, 700, 70, False, 2)
    tank = fleet.tank_state({"tank_ml": 1000, "pump_ml_s": 60}, [(10, 9), (20, 5)], settings)
    assert (tank["left_ml"], tank["percent"], tank["low"]) == (160, 16, True)  # its own flow
    assert fleet.tank_state({"tank_ml": 100, "pump_ml_s": 50}, [(1, 9)], settings)["left_ml"] == 0  # never below empty


def test_pump_runs():
    activity = [{"time": 1, "kind": "pump", "message": "Pump started from the app (3 s)"},
                {"time": 2, "kind": "pump", "message": "Watered automatically: soil 18 % (5 s)"},
                {"time": 3, "kind": "restart", "message": "Restarted (9 s)"},
                {"time": 4, "kind": "pump", "message": "no seconds"}]
    assert fleet.pump_runs(activity) == [(1, 3), (2, 5)]


def test_watering_missed():
    now = 100 * HOUR
    run1, run2 = now - 10 * HOUR, now - 4 * HOUR
    flat = [{"time": t, "soil_moisture": 20} for t in range(int(now - 12 * HOUR), int(now), 900)]
    assert fleet.watering_missed(flat, [(run1, 5), (run2, 5)], now)                  # two waterings, no rise
    assert not fleet.watering_missed(flat, [(run2, 5)], now)                          # one isn't enough to tell
    assert not fleet.watering_missed(flat, [(run1, 5), (now - 600, 5)], now)          # the last one too recent
    risen = [{**r, "soil_moisture": 20 + (8 if r["time"] > run2 else 0)} for r in flat]
    assert not fleet.watering_missed(risen, [(run1, 5), (run2, 5)], now)              # the last one worked
    wet = [{**r, "soil_moisture": 85} for r in flat]
    assert not fleet.watering_missed(wet, [(run1, 5), (run2, 5)], now)                # already wet: can't tell
    assert not fleet.watering_missed([], [(run1, 5), (run2, 5)], now)                 # no readings


async def test_a_tank_from_the_api(client, services):
    services.db.upsert_device("aa", name="basil", soil_moisture=50, battery=80, last_seen=time.time())
    device = (await client.get("/api/devices")).json()[0]
    assert device["tank"] is None and device["watering_missed"] is False
    device = (await client.patch("/api/devices/aa", json={"tank_ml": "1000", "pump_ml_s": "25"}, headers=CHANGE)).json()
    assert device["tank"]["percent"] == 100 and device["tank_filled"]                # set up: full from now
    for bad in ({"tank_ml": "5"}, {"tank_ml": "lots"}, {"pump_ml_s": "-1"}, {"pump_ml_s": "5000"}):
        assert (await client.patch("/api/devices/aa", json=bad, headers=CHANGE)).status_code == 400, bad

    # Pump runs from now on use it up: 9 s x 25 ml/s = 225 ml each
    for _ in range(4):
        services.db.add_activity("aa", "pump", "Pump started from the app (9 s)")
    device = (await client.get("/api/devices")).json()[0]
    assert (device["tank"]["left_ml"], device["tank"]["percent"], device["tank"]["low"]) == (100, 10, True)
    services.alerts.scan()
    low = [a for a in (await client.get("/api/alerts")).json()["open"] if a["kind"] == "tank"]
    assert len(low) == 1 and "basil's water tank is about 10 % full (100 ml left)" in low[0]["message"]

    # Refilled: full again, the alert gone, and it's in its activity
    device = (await client.post("/api/devices/aa/tank/refilled", headers=CHANGE)).json()
    assert device["tank"]["percent"] == 100 and device["tank"]["runs"] == 0
    assert not [a for a in services.db.open_alerts() if a["kind"] == "tank"]
    assert services.db.recent_activity("aa", "tank", 1)[0]["message"] == "Water tank refilled"
    # Not tracked any more
    device = (await client.patch("/api/devices/aa", json={"tank_ml": ""}, headers=CHANGE)).json()
    assert device["tank"] is None
    assert (await client.post("/api/devices/aa/tank/refilled", headers=CHANGE)).status_code == 400
    assert (await client.post("/api/devices/zz/tank/refilled", headers=CHANGE)).status_code == 404


async def test_waterings_that_missed_raise_an_alert(client, services):
    now = time.time()
    services.db.upsert_device("aa", name="mint", soil_moisture=20, battery=80, last_seen=now)
    services.db.add_readings([("aa", t, 80, 20, 50, 20) for t in range(int(now - 12 * HOUR), int(now), 900)])
    services.db.add_activity("aa", "pump", "Pump started from the app (5 s)", when=now - 8 * HOUR)
    services.db.add_activity("aa", "pump", "Pump started from the app (5 s)", when=now - 3 * HOUR)
    assert (await client.get("/api/devices")).json()[0]["watering_missed"] is True
    services.alerts.scan()
    missed = [a for a in (await client.get("/api/alerts")).json()["open"] if a["key"] == "missed:aa"]
    assert len(missed) == 1 and "mint's soil didn't rise after its last 2 waterings" in missed[0]["message"]
    # Refilled (a tank set up): the runs before don't count
    await client.patch("/api/devices/aa", json={"tank_ml": 2000}, headers=CHANGE)
    assert (await client.get("/api/devices")).json()[0]["watering_missed"] is False
    services.alerts.scan()
    assert not [a for a in services.db.open_alerts() if a["key"] == "missed:aa"]
