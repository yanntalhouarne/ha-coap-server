"""The CoAP tab: any request to a board, its answer described, changes in its timeline."""

import httpx
import pytest

from hacoap_manager import coap
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


async def board(client, services, start_sim, **fields):
    server = await start_sim(dynamic=False, **fields)
    fast_settings(services.settings, server)
    services.settings.coap_timeout_s = 0.3
    services.db.upsert_device("1a2b3c4d", address="127.0.0.1", name="basil")
    return server


async def send(client, **body):
    response = await client.post("/api/devices/1a2b3c4d/coap", json=body, headers=CHANGE)
    assert response.status_code == 200, response.text
    return response.json()


async def test_the_resources_and_methods(client):
    catalog = (await client.get("/api/coap/resources")).json()
    assert catalog["methods"] == ["GET", "POST", "PUT", "DELETE"]
    paths = {r["path"]: r["methods"] for r in catalog["resources"]}
    assert paths["data"] == ["GET"] and paths["pump"] == ["GET", "PUT"] and paths["ping"] == ["PUT"]


async def test_get_answers_decoded(client, services, start_sim):
    await board(client, services, start_sim)
    data = await send(client, method="GET", path="data")
    assert data["answered"] and data["ok"] and (data["code"], data["code_name"]) == ("2.05", "Content")
    assert ["battery", "87 %"] in data["decoded"] and ["temperature", "-5 °C"] in data["decoded"]
    assert data["hex"].startswith("2a 57") and data["elapsed_ms"] >= 0
    assert data["text"] == ""  # bytes, not text
    info = await send(client, method="GET", path="info")
    assert ["device ID", "1a2b3c4d"] in info["decoded"]
    diag = await send(client, method="GET", path="diag")
    assert ["power", "battery"] in diag["decoded"]
    assert services.db.recent_activity("1a2b3c4d", "coap", 10) == []  # reading isn't a change


async def test_put_changes_and_goes_in_the_timeline(client, services, start_sim):
    server = await board(client, services, start_sim)
    result = await send(client, method="PUT", path="pumpdc", payload="5")
    assert result["code"] == "2.05" and result["decoded"] == [["run time", "5 s"]]
    assert server.device.settings["pump_s"] == 5
    beep = await send(client, method="PUT", path="ping", payload_hex="31", confirmable=False)  # '1', non-confirmable
    assert beep["code"] == "2.04" and server.device.pings == 1
    entries = [a["message"] for a in services.db.recent_activity("1a2b3c4d", "coap", 10)]
    assert "CoAP PUT ping '1': 2.04 Changed" in entries and "CoAP PUT pumpdc '5': 2.05 Content" in entries


async def test_what_the_board_doesnt_take_gets_no_answer(client, services, start_sim):
    await board(client, services, start_sim)
    for body in ({"method": "POST", "path": "data"}, {"method": "GET", "path": "nothing/here"},
                 {"method": "PUT", "path": "pump", "payload": "1", "confirmable": False}):
        result = await send(client, **body)
        assert not result["answered"] and "No answer" in result["detail"], body


async def test_bad_requests_are_refused(client, services, start_sim):
    await board(client, services, start_sim)
    for body in ({"method": "PATCH", "path": "data"}, {"method": "GET", "path": "../etc"},
                 {"method": "GET", "path": ""}, {"method": "PUT", "path": "ping", "payload_hex": "zz"},
                 {"method": "PUT", "path": "ping", "payload": "x" * 513}):
        response = await client.post("/api/devices/1a2b3c4d/coap", json=body, headers=CHANGE)
        assert response.status_code == 400, body
    assert (await client.post("/api/devices/nope/coap", json={"path": "data"}, headers=CHANGE)).status_code == 404
    assert (await client.post("/api/devices/1a2b3c4d/coap", json={"path": "data"})).status_code == 403  # no X-HACoap


def test_describe():
    log = coap.describe("log", coap.CONTENT, b"b1x2\n" + b"0\n" + b"hello")
    assert isinstance(log["text"], str)
    assert coap.describe("data", 0x85, b"")["code_name"] == "Method Not Allowed"
    assert coap.describe("data", 0x85, b"")["ok"] is False
    assert coap.describe("anything", coap.CHANGED, b"")["decoded"] == []
