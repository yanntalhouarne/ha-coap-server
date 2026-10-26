import asyncio

import httpx
import pytest
from starlette.testclient import TestClient

from hacoap_manager.app import create_app, create_services
from hacoap_manager.discovery import Found

from conftest import NEW_HASH, NEW_IMAGE, fast_settings

CHANGE = {"X-HACoap": "1"}


@pytest.fixture
def found():
    """What the fake discovery returns."""
    return []


@pytest.fixture
def services(tmp_path, found):
    async def discover(timeout):
        return list(found)

    services = create_services(tmp_path / "data", discover=discover)
    yield services
    services.db.close()


@pytest.fixture
async def client(services):
    app = create_app(services, background_tasks=False)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8710") as client:
        yield client


async def test_status(client):
    response = await client.get("/api/status")
    assert response.status_code == 200
    assert response.json()["settings"]["coap_port"] == 5683


async def test_page_is_served(client):
    response = await client.get("/")
    assert response.status_code == 200
    assert "HA-CoAP Fleet Manager" in response.text
    assert (await client.get("/static/app.js")).status_code == 200
    assert (await client.get("/static/vendor/bootstrap.min.css")).status_code == 200


async def test_other_host_names_are_refused(client):
    response = await client.get("/api/status", headers={"Host": "evil.example:8710"})
    assert response.status_code == 403
    assert (await client.get("/api/status", headers={"Host": "localhost:8710"})).status_code == 200
    assert (await client.get("/api/status", headers={"Host": "[::1]:8710"})).status_code == 200


async def test_changes_need_the_header(client):
    response = await client.post("/api/refresh")
    assert response.status_code == 403
    assert (await client.post("/api/refresh", headers=CHANGE)).status_code == 200


async def test_add_refresh_ping_and_edit_a_device(client, services, start_sim):
    server = await start_sim()
    fast_settings(services.settings, server)

    response = await client.post("/api/devices", json={"address": "127.0.0.1"}, headers=CHANGE)
    assert response.status_code == 200, response.text
    device = response.json()
    assert device["device_id"] == "1a2b3c4d"
    assert (device["battery"], device["temperature"], device["online"]) == (87, -5, True)

    assert (await client.post("/api/devices/1a2b3c4d/ping", headers=CHANGE)).status_code == 200
    assert server.device.pings == 1

    response = await client.patch("/api/devices/1a2b3c4d", json={"name": "basil", "notes": "kitchen"}, headers=CHANGE)
    assert response.json()["name"] == "basil"

    slots = (await client.post("/api/devices/1a2b3c4d/slots", json={}, headers=CHANGE)).json()
    assert slots[0]["active"]

    server.device.drop_coap_first = 100
    services.settings.coap_port = server.coap_port
    device = (await client.post("/api/devices/1a2b3c4d/refresh", headers=CHANGE)).json()
    assert device["last_error"].startswith("No answer")

    assert (await client.delete("/api/devices/1a2b3c4d", headers=CHANGE)).status_code == 200
    assert (await client.get("/api/devices")).json() == []


async def test_adding_an_unreachable_device_fails(client, services, start_sim):
    server = await start_sim(drop_coap_first=100)
    fast_settings(services.settings, server)
    response = await client.post("/api/devices", json={"address": "127.0.0.1"}, headers=CHANGE)
    assert response.status_code == 400
    assert "No answer" in response.json()["detail"]


async def test_discover_adds_devices(client, services, found, start_sim):
    server = await start_sim()
    fast_settings(services.settings, server)
    found.append(Found("ha-coap-1a2b3c4d", "1a2b3c4d", "127.0.0.1"))
    response = await client.post("/api/discover", headers=CHANGE)
    assert response.status_code == 200
    devices = (await client.get("/api/devices")).json()
    assert [(d["device_id"], d["name"], d["address"]) for d in devices] == [("1a2b3c4d", "ha-coap-1a2b3c4d", "127.0.0.1")]


async def test_images(client):
    response = await client.post("/api/images?filename=app_update.bin&notes=test", content=NEW_IMAGE, headers=CHANGE)
    assert response.status_code == 200, response.text
    assert response.json()["hash"] == NEW_HASH
    assert response.json()["version"] == "1.1.0"
    assert [i["hash"] for i in (await client.get("/api/images")).json()] == [NEW_HASH]

    response = await client.post("/api/images", content=b"not an image" * 10, headers=CHANGE)
    assert response.status_code == 400

    assert (await client.delete(f"/api/images/{NEW_HASH}", headers=CHANGE)).status_code == 200
    assert (await client.get("/api/images")).json() == []


async def test_update_through_the_api(client, services, start_sim):
    server = await start_sim()
    fast_settings(services.settings, server)
    await client.post("/api/devices", json={"address": "127.0.0.1"}, headers=CHANGE)
    await client.post("/api/images", content=NEW_IMAGE, headers=CHANGE)

    response = await client.post("/api/updates", json={"image_hash": NEW_HASH, "allow_unverified": True, "targets": [{"device_id": "1a2b3c4d"}]},
                                 headers=CHANGE)
    assert response.status_code == 200, response.text
    job_id = response.json()["id"]
    for _ in range(600):
        job = (await client.get(f"/api/updates/{job_id}")).json()
        if job["state"] != "running":
            break
        await asyncio.sleep(0.05)
    assert job["state"] == "done", job
    assert job["targets"][0]["status"] == "updated"
    history = (await client.get("/api/history")).json()
    assert history[0]["result"] == "updated"

    response = await client.post("/api/updates", json={"image_hash": "00", "targets": []}, headers=CHANGE)
    assert response.status_code == 400


async def test_settings_are_saved(client, services):
    response = await client.put("/api/settings", json={"auto_refresh_minutes": 0, "unknown": 1}, headers=CHANGE)
    assert response.json()["auto_refresh_minutes"] == 0
    assert '"auto_refresh_minutes": 0' in (services.data_dir / "settings.json").read_text()
    response = await client.put("/api/settings", json={"udp_mtu": "lots"}, headers=CHANGE)
    assert response.status_code == 400


def test_events_websocket(services):
    services.db.upsert_device("1a2b3c4d", address="127.0.0.1")
    app = create_app(services, background_tasks=False)
    with TestClient(app, base_url="http://127.0.0.1:8710") as client:
        with client.websocket_connect("ws://127.0.0.1:8710/api/events", headers={"Origin": "http://127.0.0.1:8710"}) as socket:
            client.patch("/api/devices/1a2b3c4d", json={"name": "mint"}, headers=CHANGE)
            event = socket.receive_json()
            assert event["type"] == "device" and event["device"]["name"] == "mint"


def test_events_refuse_other_origins(services):
    app = create_app(services, background_tasks=False)
    with TestClient(app, base_url="http://127.0.0.1:8710") as client:
        with pytest.raises(Exception):
            with client.websocket_connect("ws://127.0.0.1:8710/api/events", headers={"Origin": "http://evil.example"}) as socket:
                socket.receive_json()


async def test_build_profiles(client):
    schema = (await client.get("/api/kconfig")).json()
    assert "battery" in schema["variants"]
    assert any(s["name"] == "HACOAP_SENSOR_SAMPLE_PERIOD_S" for s in schema["schema"])
    assert [p["name"] for p in (await client.get("/api/profiles")).json()] == ["Production"]

    response = await client.put("/api/profiles/Greenhouse", headers=CHANGE,
                                json={"variant": "usb-logging", "settings": {"HACOAP_SENSOR_SAMPLE_PERIOD_S": 600}})
    assert response.status_code == 200, response.text
    assert response.json()["settings"] == {"HACOAP_SENSOR_SAMPLE_PERIOD_S": 600}

    for name, body in [("Greenhouse", {"settings": {"HACOAP_SENSOR_SAMPLE_PERIOD_S": 1}}),
                       ("Greenhouse", {"variant": "fast"}),
                       ("../evil", {}),
                       ("a" * 41, {})]:
        response = await client.put(f"/api/profiles/{name}", json=body, headers=CHANGE)
        assert response.status_code in (400, 404, 405), (name, body)

    assert (await client.delete("/api/profiles/Greenhouse", headers=CHANGE)).status_code == 200
    assert (await client.delete("/api/profiles/Greenhouse", headers=CHANGE)).status_code == 404


async def test_build_checks_and_history(client):
    checks = (await client.get("/api/build-checks")).json()
    assert checks[0]["name"] == "Firmware checkout"
    assert (await client.get("/api/firmware-builds")).json() == []
    assert (await client.get("/api/firmware-builds/99")).status_code == 404
    assert (await client.post("/api/firmware-builds/cancel", headers=CHANGE)).status_code == 400
