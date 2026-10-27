"""The watering forecast and pump effect, the photo timeline, the weekly summary, the wall
display, and the demo."""

import io
import time
import zipfile

import httpx
import pytest

from hacoap_manager import backup, fleet, summary
from hacoap_manager.app import create_app, create_services
from hacoap_manager.demo import Demo, PlantModel
from hacoap_manager.pictures import PhotoStore

CHANGE = {"X-HACoap": "1"}
DAY = 86400
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
JPEG = b"\xff\xd8\xff" + b"\x00" * 64


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


def soil(start, values, every_h=6):
    return [{"time": start + i * every_h * 3600, "soil_moisture": v} for i, v in enumerate(values)]


# ---------------------------------------------------------------- watering forecast

def test_water_forecast():
    now = time.time()
    # Watered (a jump up), then drying 6 %/day: at 60 % with a target of 30, about 5 days left
    readings = soil(now - 3 * DAY, [35, 32, 75, 73.5, 72, 70.5, 69, 67.5, 66, 64.5, 63, 61.5, 60])
    forecast = fleet.water_forecast(readings, 30, now)
    assert 5.5 < forecast["per_day"] < 6.5 and 4.5 < forecast["days"] < 5.5 and forecast["soil"] == 60
    assert fleet.water_forecast(soil(now - DAY, [40, 33, 28, 25]), 30, now)["days"] == 0      # already under
    assert fleet.water_forecast(soil(now - DAY, [50, 50, 50, 50]), 30, now)["days"] is None   # not drying
    assert fleet.water_forecast(readings, None, now) is None                                   # no target
    assert fleet.water_forecast(readings[:2], 30, now) is None                                 # too few


def test_pump_effect():
    now = time.time()
    readings = soil(now - DAY, [30, 31, 52, 51, 30, 49], every_h=2)
    activity = [{"time": now - DAY + 3 * 3600, "kind": "pump", "message": "Pump started from the app (3 s)"},
                {"time": now - DAY + 9 * 3600, "kind": "pump", "message": "Pump started from the app (3 s)"}]
    effect = fleet.pump_effect(readings, activity)
    assert effect["runs"] == 2 and effect["rise"] == pytest.approx(20) and effect["seconds"] == 3
    assert fleet.pump_effect(readings, []) is None


async def test_dashboard_lists_plants_soon_to_need_water(services, client):
    now = time.time()
    services.db.upsert_device("abcd0001", name="basil", address="fd11:22::1", soil_moisture=40, water_below=35,
                              last_seen=now)
    for r in soil(now - DAY, [44, 43, 42, 41, 40], every_h=6):
        services.db.add_reading("abcd0001", 80, r["soil_moisture"], 50, 20, when=r["time"])
    board = (await client.get("/api/dashboard")).json()
    assert [e["name"] for e in board["water_soon"]] == ["basil"] and board["water_soon"][0]["water_forecast"]["days"] < 3
    details = (await client.get("/api/devices/abcd0001/details")).json()
    assert details["health"]["water_forecast"]["days"] < 3 and details["health"]["pump_effect"] is None


# ---------------------------------------------------------------- photos over time

def test_photo_timeline(tmp_path):
    store = PhotoStore(tmp_path)
    store.folder.mkdir()
    (store.folder / "abcd0001").write_bytes(PNG)            # a photo from before the timeline
    older = store.timeline("abcd0001")
    assert len(older) == 1
    newest = store.add("abcd0001", JPEG, taken=older[0] + 100)
    assert store.timeline("abcd0001") == [older[0], newest]
    assert store.read("abcd0001")[0] == JPEG                 # the current photo is the newest
    assert store.read("abcd0001", older[0])[0] == PNG
    assert store.add("abcd0001", PNG, taken=newest) == newest + 1   # same second: the next one
    assert store.remove("abcd0001", newest + 1) == 2
    assert store.remove("abcd0001", newest) == 1 and store.read("abcd0001")[0] == PNG
    store.delete("abcd0001")
    assert store.timeline("abcd0001") == [] and store.read("abcd0001") is None


async def test_photo_timeline_api_and_backup(services, client):
    services.db.upsert_device("abcd0001", name="basil")
    taken = 1_760_000_000
    await client.post(f"/api/devices/abcd0001/photo?taken={taken}", content=PNG, headers=CHANGE)
    await client.post("/api/devices/abcd0001/photo?taken=99", content=JPEG, headers=CHANGE)   # nonsense date: now
    photos = [p["taken"] for p in (await client.get("/api/devices/abcd0001/photos")).json()]
    assert photos[0] == taken and len(photos) == 2 and photos[1] > time.time() - 60
    assert (await client.get(f"/api/devices/abcd0001/photos/{taken}")).content == PNG
    names = zipfile.ZipFile(io.BytesIO(backup.create_backup(services.data_dir, services.db, services.settings))).namelist()
    assert f"photos/abcd0001.{taken}" in names and backup.PHOTO_NAME.fullmatch(f"photos/abcd0001.{taken}")
    device = (await client.delete(f"/api/devices/abcd0001/photos/{photos[1]}", headers=CHANGE)).json()
    assert device["photo"] and (await client.get("/api/devices/abcd0001/photo")).content == PNG
    device = (await client.delete("/api/devices/abcd0001/photo", headers=CHANGE)).json()
    assert device["photo"] is None and (await client.get("/api/devices/abcd0001/photos")).json() == []


# ---------------------------------------------------------------- weekly summary and wall

async def test_summary_and_wall(services, client):
    db, now = services.db, time.time()
    db.upsert_device("abcd0001", name="basil", plant="basil", address="fd11:22::1", soil_moisture=25, water_below=30,
                     battery=70, last_seen=now)
    db.upsert_device("abcd0002", name="fern", address="fd11:22::2", soil_moisture=60, water_below=30, last_seen=now)
    for r in soil(now - 6 * DAY, [50, 40, 30, 70, 60, 50, 40, 30, 25], every_h=16):     # one watering (by hand)
        db.add_reading("abcd0001", 80, r["soil_moisture"], 50, 20, when=r["time"])
    db.add_activity("abcd0001", "pump", "Pump started from the app (3 s)", when=now - 2 * DAY)
    db.add_reading("abcd0001", 70, 25, 50, 20, when=now - 10 * DAY)                      # before the week
    db.add_update("job", "abcd0002", "udp", "f" * 64, "1.1.0", now - DAY, now - DAY + 60, "updated", "")
    db.add_network_event("abcd0001", "basil moved from 0x5000 to 0x6800")
    report = (await client.get("/api/summary?days=7")).json()
    basil = next(p for p in report["plants"] if p["name"] == "basil")
    assert basil["waterings"] == 2 and basil["pump_runs"] == 1 and basil["soil"]["min"] == 25 and basil["needs_water"]
    assert len(report["updates"]) == 1 and report["updates"][0]["name"] == "fern"
    assert len(report["parent_changes"]) == 1 and report["devices"] == 2
    earlier = summary.build(db, services.inventory, services.settings, days=7, end=now - 7 * DAY)
    assert next(p for p in earlier["plants"] if p["name"] == "basil")["readings"] == 1

    plants = (await client.get("/api/wall")).json()
    assert [p["name"] for p in plants] == ["basil", "fern"] and plants[0]["needs_water"]


# ---------------------------------------------------------------- the demo

def test_plant_model():
    now = time.time()
    model = PlantModel(0, now - 14 * DAY, now - 7 * DAY)
    assert model.battery(now - 13 * DAY) - model.battery(now - 8 * DAY) > model.battery(now - 6 * DAY) - model.battery(now - DAY)
    model.water(now - 60)
    assert model.soil(now) >= 70


async def test_demo(services, client):
    demo = Demo(services, count=1, coap_port=0, smp_port=0)
    await demo.start()
    try:
        device_id = services.db.devices()[0]["device_id"]
        assert services.db.device(device_id)["name"] == "basil" and services.db.release_image()
        assert len(services.db.readings(device_id)) > 500 and len(services.db.network_snapshots()) == 2
        drain = (await client.get("/api/battery-drain")).json()
        assert drain and 0.4 < drain[0]["median"] < 0.8          # 0.6 %/day since the update
        found = (await client.post("/api/discover", headers=CHANGE)).json()["found"]
        assert [d["device_id"] for d in found] == [device_id]
        await client.post(f"/api/devices/{device_id}/pump", json={"on": True}, headers=CHANGE)
        refreshed = (await client.post(f"/api/devices/{device_id}/refresh", headers=CHANGE)).json()
        assert refreshed["soil_moisture"] >= 70                    # the pump watered it
    finally:
        await demo.stop()
    assert (await client.get("/api/status")).json()["demo"] is False
    services.demo = True
    assert (await client.post("/api/demo", headers=CHANGE)).status_code == 400   # not from the demo itself


# ---------------------------------------------------------------- the dashboard tiles' trends

def test_trends(services):
    db, now = services.db, time.time()
    db.upsert_device("abcd0001", name="basil", water_below=30)
    db.add_reading("abcd0001", 15, 25, 50, 20, when=now - 5.5 * DAY)    # dry and low, 6 days ago
    db.add_reading("abcd0001", 80, 50, 50, 20, when=now - 0.5 * DAY)    # fine, today
    db.add_link_sample("abcd0001", "0x5000", link_margin=5, when=now - 0.5 * DAY)
    t = fleet.trends(db, services.inventory, days=7, now=now)
    assert t["online"] == [0, 1, 0, 0, 0, 0, 1] and t["needs_water"] == [0, 1, 0, 0, 0, 0, 0]
    assert t["low_battery"] == [0, 1, 0, 0, 0, 0, 0] and t["weak_links"] == [0, 0, 0, 0, 0, 0, 1]
