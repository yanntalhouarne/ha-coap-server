"""Watering: the water tanks (how full, from the pump's runs; refilling) and the waterings that
didn't reach the plant."""

import time

import httpx
import pytest

from hacoap_manager import autowater, fleet
from hacoap_manager.app import create_app, create_services
from hacoap_manager.config import Settings

from conftest import fast_settings

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


# ---------------------------------------------------------------- automatic watering

NOON_UTC = 1_762_776_000  # 2025-11-10 12:00 UTC
RULE = {"on": True, "max_per_day": 2, "from_hour": 7, "to_hour": 21, "wait_h": 3, "seconds": None, "tz": "",
        "utc_offset_min": 0}


def thirsty(**fields):
    import json
    rule = {**RULE, **fields.pop("rule", {})}
    return {"device_id": "aa", "watering": json.dumps(rule), "water_target": 30, "online": True, "soil_moisture": 20,
            "watering_missed": False, "tank": None, "pump_s": 3, **fields}


def test_the_rule_decides():
    decide = autowater.decide
    assert decide(thirsty(), [], NOON_UTC) == {"water": True, "why": "Waters now: soil 20 % under 30 %"}
    assert decide(thirsty(rule={"on": False}), [], NOON_UTC)["why"] == "Off"
    assert "No watering target" in decide(thirsty(water_target=None), [], NOON_UTC)["why"]
    assert "isn't answering" in decide(thirsty(online=False), [], NOON_UTC)["why"]
    assert "update" in decide(thirsty(), [], NOON_UTC, busy=True)["why"]
    assert decide(thirsty(watering_missed=True), [], NOON_UTC)["why"].startswith("Paused")
    assert "isn't under 30 %" in decide(thirsty(soil_moisture=35), [], NOON_UTC)["why"]
    # Its hours, in its owner's time: noon UTC is 22:00 at UTC+10, past 21:00
    assert decide(thirsty(rule={"utc_offset_min": 600}), [], NOON_UTC)["why"].startswith("Waits until 07:00")
    assert decide(thirsty(rule={"from_hour": 20, "to_hour": 6}), [], NOON_UTC)["water"] is False   # nights only
    assert decide(thirsty(rule={"from_hour": 20, "to_hour": 6}), [], NOON_UTC + 10 * HOUR)["water"] is True  # 22:00
    # How often: twice today already (automatic ones), or the last watering too recent (any kind)
    two = [(NOON_UTC - 5 * HOUR, 3, True), (NOON_UTC - 4 * HOUR, 3, True)]
    assert decide(thirsty(), two, NOON_UTC)["why"] == "Done for today: 2 of 2 waterings"
    by_hand = [(NOON_UTC - HOUR, 3, False)]
    assert "more minutes" in decide(thirsty(), by_hand, NOON_UTC)["why"]
    assert decide(thirsty(), [(NOON_UTC - 13 * HOUR, 3, True)] * 3, NOON_UTC)["water"] is True  # yesterday's don't count
    # Its tank: enough for one more run (3 s x 20 ml/s)?
    tank = {"left_ml": 50, "flow_ml_s": 20}
    assert "tank" in decide(thirsty(tank=tank), [], NOON_UTC)["why"]
    assert decide(thirsty(tank={**tank, "left_ml": 61}), [], NOON_UTC)["water"] is True


def test_rules_from_the_page():
    rule = autowater.checked_rule({"on": "yes", "max_per_day": "3", "wait_h": "1.5", "seconds": "4", "tz": "Europe/Paris"},
                                  autowater.DEFAULTS)
    assert (rule["on"], rule["max_per_day"], rule["wait_h"], rule["seconds"], rule["tz"]) == (True, 3, 1.5, 4, "Europe/Paris")
    assert autowater.checked_rule({"seconds": ""}, rule)["seconds"] is None   # the board's own run time
    for bad in ({"max_per_day": 0}, {"from_hour": 24}, {"seconds": 12}, {"wait_h": "soon"}, {"from_hour": 8, "to_hour": 8}, "on"):
        with pytest.raises(autowater.RuleError):
            autowater.checked_rule(bad, autowater.DEFAULTS)
    assert autowater.rule_of({"watering": "not json"}) == autowater.DEFAULTS


async def test_it_waters_a_thirsty_plant(client, services, start_sim):
    server = await start_sim()
    fast_settings(services.settings, server)
    await client.post("/api/devices", json={"address": "127.0.0.1"}, headers=CHANGE)
    services.db.upsert_device("1a2b3c4d", soil_moisture=12, water_below=30, last_seen=time.time())
    watering = {"on": True, "from_hour": 0, "to_hour": 24, "max_per_day": 1, "seconds": 2}
    response = await client.patch("/api/devices/1a2b3c4d", json={"watering": watering}, headers=CHANGE)
    assert response.status_code == 200 and response.json()["watering_rule"]["on"] is True
    assert (await client.patch("/api/devices/1a2b3c4d", json={"watering": {"seconds": 99}}, headers=CHANGE)).status_code == 400

    details = (await client.get("/api/devices/1a2b3c4d/details")).json()
    assert details["autowater"]["water"] is True
    assert await services.autowater.run_once() == ["1a2b3c4d"]
    assert server.device.pump_running and server.device.pump_duration == 2
    runs = services.db.recent_activity("1a2b3c4d", "pump", 5)
    assert len(runs) == 1 and runs[0]["message"] == "Watered automatically: soil 12 % under 30 % (2 s)"
    # Not again: once a day at most (and 3 hours apart)
    assert await services.autowater.run_once() == []
    assert (await client.get("/api/devices/1a2b3c4d/details")).json()["autowater"]["why"].startswith("Done for today")

    # A board that doesn't answer: tried again later, not every minute
    services.db.upsert_device("1a2b3c4d", watering="")
    services.db.upsert_device("5e6f7a8b", name="mint", address="127.0.0.9", soil_moisture=5, water_below=30,
                              last_seen=time.time(), watering='{"on": true, "from_hour": 0, "to_hour": 24}')
    assert await services.autowater.run_once() == []
    assert "5e6f7a8b" in services.autowater._failed


def test_how_long_a_tank_lasts():
    settings = Settings()
    now = 100 * 86400
    device = {"tank_ml": 1000, "pump_ml_s": 10, "added": 0}
    # 4 runs of 5 s over the last 14 days: 200 ml in 14 days, about 14 ml a day
    recent = [(now - d * 86400, 5) for d in (12, 9, 5, 2)]
    tank = fleet.tank_state(device, recent[-2:], settings, recent, now)
    assert tank["left_ml"] == 900 and tank["per_day_ml"] == 14
    assert round(tank["days_left"]) == 63
    # Not known: one run, or a board added under a day ago
    assert fleet.tank_state(device, [], settings, recent[-1:], now)["days_left"] is None
    assert fleet.tank_state({**device, "added": now - 3600}, [], settings, [(now - 600, 5), (now - 60, 5)], now)["days_left"] is None
    # Added 2 days ago: its use counts over those 2 days, not 14
    assert fleet.water_per_day({**device, "added": now - 2 * 86400}, [(now - 86400, 5), (now - 600, 5)], 10, now) == 50


async def test_going_away(services, client):
    now = time.time()
    services.inventory.refreshed = True
    # Waters itself: its tank (500 ml) empties at 100 ml a day: 4 days left
    services.db.upsert_device("aaaa0001", name="ha-coap-aaaa0001", plant="fern", address="fd11::1", last_seen=now,
                              soil_moisture=50, water_below=30, tank_ml=500, pump_ml_s=10, tank_filled=now - 86400,
                              watering='{"on": true}', battery=90)
    services.db._execute("UPDATE devices SET added = ? WHERE device_id = 'aaaa0001'", (now - 30 * 86400,))
    for day in range(14):
        services.db.add_activity("aaaa0001", "pump", "Watered automatically: soil 29 % under 30 % (5 s)", when=now - 86400 * day - 600 - (86400 if day else 0))
        services.db.add_activity("aaaa0001", "pump", "Watered automatically: soil 29 % under 30 % (5 s)", when=now - 86400 * day - 7200 - (86400 if day else 0))
    # Watered by hand, dry now; and one that's fine
    services.db.upsert_device("aaaa0002", name="ha-coap-aaaa0002", plant="cactus", address="fd11::2", last_seen=now,
                              soil_moisture=10, water_below=30, battery=80)
    services.db.upsert_device("aaaa0003", name="ha-coap-aaaa0003", plant="moss", address="fd11::3", last_seen=now,
                              soil_moisture=60, water_below=30, battery=80)
    assert (await client.get("/api/away")).json() == {"until": 0, "plants": []}           # not away
    bad = await client.put("/api/away", json={"until": now - 60}, headers=CHANGE)
    assert bad.status_code == 400
    response = await client.put("/api/away", json={"until": now + 10 * 86400}, headers=CHANGE)
    assert response.status_code == 200 and services.settings.away_until == now + 10 * 86400
    plants = {p["plant"]: p["problems"] for p in response.json()["plants"]}
    assert [p["kind"] for p in plants["fern"]] == ["tank"] and "runs out" in plants["fern"][0]["text"]
    assert plants["fern"][0]["when"] < now + 5 * 86400
    assert [p["kind"] for p in plants["cactus"]] == ["water"] and plants["moss"] == []
    assert response.json()["plants"][-1]["plant"] == "moss"                                 # the fine ones last
    # A shorter trip: the tank lasts
    short = (await client.get(f"/api/away?until={now + 2 * 86400}")).json()
    assert {p["plant"]: p["problems"] for p in short["plants"]}["fern"] == []
    # Back
    assert (await client.put("/api/away", json={"until": 0}, headers=CHANGE)).json()["until"] == 0


def soil_series(start, end, level, per_day, waterings=(), rise=0, step=1800):
    """Readings every 'step' s: drying 'per_day' % a day from 'level', back up by 'rise' an hour
    after each watering time."""
    readings, soil, t = [], level, start
    pending = sorted(waterings)
    while t < end:
        if pending and t >= pending[0] + 3600:
            soil += rise
            pending.pop(0)
        readings.append({"time": t, "soil_moisture": round(soil)})
        soil -= per_day * step / 86400
        t += step
    return readings


def test_watering_report():
    now = 40 * 86400
    start = now - 30 * 86400
    # Watered every 4 days (automatic, then from the app, by its button), each raising the soil 15 %
    times = [start + d * 86400 for d in range(2, 30, 4)]
    rows = [{"time": t, "kind": "pump", "message": message} for t, message in zip(times, [
        "Watered automatically: soil 29 % under 30 % (5 s)", "Pump started from the app (5 s)",
        "Pump run with its button (6 s)", "Watered automatically: soil 29 % under 30 % (5 s)",
        "Watered automatically: soil 29 % under 30 % (5 s)", "Pump started from the app (5 s)",
        "Watered automatically: soil 29 % under 30 % (5 s)"])]
    readings = soil_series(start, now, 50, 3, times, rise=15)
    report = fleet.watering_report(readings, rows, now)
    assert report["waterings"] == {"app": 2, "automatic": 4, "button": 1, "hand": 0}
    assert report["rise"]["runs"] == 7 and 14 <= report["rise"]["median"] <= 16 and report["rise"]["seconds"] == 5
    assert 2.5 <= report["drying"]["now"] <= 3.5 and 2.5 <= report["drying"]["before"] <= 3.5
    assert report["flags"] == []
    # Its runs stopped raising the soil (an empty tank): weak
    flat = soil_series(start, now, 50, 3, times, rise=0)
    assert [f["kind"] for f in fleet.watering_report(flat, rows, now)["flags"]] == ["weak"]
    # Drying twice as fast this last week: said; a watering by hand counted as one
    fast = [r for r in readings if r["time"] < now - 7 * 86400] + \
        soil_series(now - 7 * 86400, now, 60, 8, [now - 4 * 86400], rise=20)
    report = fleet.watering_report(fast, [r for r in rows if r["time"] < now - 7 * 86400], now)
    assert [f["kind"] for f in report["flags"]] == ["faster"] and report["waterings"]["hand"] >= 1
    # Nothing to tell
    assert fleet.watering_report([], [], now) == {"days": 30, "waterings": {"app": 0, "automatic": 0, "button": 0, "hand": 0},
                                                  "rise": None, "drying": {"now": None, "before": None}, "flags": []}
