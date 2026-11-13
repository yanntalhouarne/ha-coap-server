"""A device is called by the name given to it (its plant field) wherever it's named, with the
board's own name next to it: the charts, the wall, the map, the alerts and the feed."""

import time

import httpx
import pytest

from hacoap_manager import fleet
from hacoap_manager.app import create_app, create_services
from hacoap_manager.naming import board_name, display_name, names

CHANGE = {"X-HACoap": "1"}


def test_the_rule():
    named = {"device_id": "52f2cfba", "name": "ha-coap-52f2cfba", "plant": "ha-coap-9"}
    assert (display_name(named), board_name(named)) == ("ha-coap-9", "ha-coap-52f2cfba")
    assert names(named) == {"name": "ha-coap-9", "board": "ha-coap-52f2cfba"}
    unnamed = {"device_id": "33125c33", "name": "ha-coap-33125c33", "plant": ""}
    assert display_name(unnamed) == board_name(unnamed) == "ha-coap-33125c33"
    assert display_name({"device_id": "1a2b3c4d", "name": "", "plant": "  "}) == "1a2b3c4d"
    assert display_name(None) == "" and board_name(None) == ""


@pytest.fixture
def services(tmp_path):
    services = create_services(tmp_path / "data", discover=None)
    now = time.time()
    services.db.upsert_device("52f2cfba", name="ha-coap-52f2cfba", plant="ha-coap-9", address="fd11::9",
                              battery=80, soil_moisture=10, last_seen=now, rloc16="0x5001", diag_time=now)
    services.db.upsert_device("33125c33", name="ha-coap-33125c33", address="fd11::33", battery=90,
                              soil_moisture=50, last_seen=now)
    for hours in (2, 1):
        services.db.add_reading("52f2cfba", 80, 10, 40, 20, when=now - hours * 3600)
    yield services
    services.db.close()


async def test_everywhere(services):
    app = create_app(services, background_tasks=False)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8710") as client:
        series = {s["device_id"]: s for s in (await client.get("/api/graph?metric=battery&days=1")).json()}
        assert (series["52f2cfba"]["name"], series["52f2cfba"]["board"]) == ("ha-coap-9", "ha-coap-52f2cfba")
        assert series["33125c33"]["name"] == series["33125c33"]["board"] == "ha-coap-33125c33"
        wall = (await client.get("/api/wall")).json()
        plants = {p["device_id"]: p for p in wall}
        assert (plants["52f2cfba"]["name"], plants["52f2cfba"]["board"], plants["52f2cfba"]["plant"]) == \
            ("ha-coap-9", "ha-coap-52f2cfba", "ha-coap-9")

    # The alerts say it too
    services.alerts.scan()
    assert any("ha-coap-9" in a["message"] for a in services.alerts.state()["open"])

    # And the map: a board found by its address
    topology = {"nodes": [{"id": "a", "ipv6": ["fd11::9"], "rloc16_hex": "0x5001", "parent": None},
                          {"id": "b", "ipv6": ["fd11::33"], "rloc16_hex": "0x5002", "parent": None}], "links": []}
    services.network._name_boards(topology)
    by_id = {n["id"]: n for n in topology["nodes"]}
    assert (by_id["a"]["name"], by_id["a"]["board"]) == ("ha-coap-9", "ha-coap-52f2cfba")
    assert by_id["b"]["name"] == "ha-coap-33125c33"


def test_the_dashboard_lists(services):
    board = fleet.dashboard(services.db, services.inventory, None)
    assert "ha-coap-9" in str(board) and "ha-coap-52f2cfba" in str(board)
