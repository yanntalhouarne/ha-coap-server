"""Care tasks: fertilize, repot... each comes back so many days after it's done."""

import time

import httpx
import pytest

from hacoap_manager import remote
from hacoap_manager.app import create_app, create_services

CHANGE = {"X-HACoap": "1"}
DAY = 86400


@pytest.fixture
def services(tmp_path):
    services = create_services(tmp_path / "data", discover=None)
    services.db.upsert_device("1a2b3c4d", name="ha-coap-1a2b3c4d", plant="basil", address="fd11::1")
    yield services
    services.console.close()
    services.db.close()


@pytest.fixture
async def client(services):
    app = create_app(services, background_tasks=False)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8710") as client:
        yield client


async def test_a_care_task_comes_back_after_it_is_done(services, client):
    now = time.time()
    for body, error in [({"every_days": 14}, "what to do"), ({"what": "Fertilize", "every_days": 0}, "1 to 365"),
                        ({"what": "Fertilize", "every_days": "x"}, "1 to 365"),
                        ({"what": "Fertilize", "every_days": 14, "due": now + 500 * DAY}, "within a year")]:
        response = await client.post("/api/devices/1a2b3c4d/care", json=body, headers=CHANGE)
        assert response.status_code == 400 and error in response.json()["detail"], body
    assert (await client.post("/api/devices/nope/care", json={"what": "x", "every_days": 1}, headers=CHANGE)).status_code == 404
    made = (await client.post("/api/devices/1a2b3c4d/care", json={"what": "  Fertilize   lightly ", "every_days": 14,
                                                                   "due": now - DAY}, headers=CHANGE)).json()
    assert (made["what"], made["every_days"], made["due"], made["last_done"]) == ("Fertilize lightly", 14, now - DAY, None)
    later = (await client.post("/api/devices/1a2b3c4d/care", json={"what": "Repot", "every_days": 365}, headers=CHANGE)).json()
    assert abs(later["due"] - now) < 5  # no date: from now
    # The soonest first, on its page and on the wall (for the Today list)
    assert [t["what"] for t in (await client.get("/api/devices/1a2b3c4d/care")).json()] == ["Fertilize lightly", "Repot"]
    wall = (await client.get("/api/wall")).json()
    assert [t["what"] for t in wall[0]["care"]] == ["Fertilize lightly", "Repot"]
    details = (await client.get("/api/devices/1a2b3c4d/details")).json()
    assert len(details["care"]) == 2
    # Done: next due in 14 days
    done = (await client.post(f"/api/care/{made['id']}/done", headers=CHANGE)).json()
    assert abs(done["due"] - (time.time() + 14 * DAY)) < 5 and done["last_done"] > now - 5
    # Edited, then removed
    edited = (await client.patch(f"/api/care/{made['id']}", json={"every_days": 21}, headers=CHANGE)).json()
    assert edited["every_days"] == 21 and edited["what"] == "Fertilize lightly"
    assert (await client.patch(f"/api/care/{made['id']}", json={}, headers=CHANGE)).status_code == 200
    assert (await client.delete(f"/api/care/{later['id']}", headers=CHANGE)).status_code == 200
    assert (await client.post("/api/care/999/done", headers=CHANGE)).status_code == 404
    assert [(a["kind"], a["message"]) for a in services.db.activity("1a2b3c4d")] == [
        ("care", "Care task added: Fertilize lightly, every 14 days"), ("care", "Care task added: Repot, every 365 days"),
        ("care", "Done: Fertilize lightly"), ("care", "Care task removed: Repot")]
    # A board forgotten with its history: its tasks too
    services.db.purge_device("1a2b3c4d")
    assert services.db.care_tasks() == []


async def test_a_dashboard_link_marks_them_done_only(services):
    networks = [{"network": "192.168.50.0/24", "address": "192.168.50.178", "interface": "eth0", "kind": "lan"}]
    services.remote = remote.RemoteAccess(services.data_dir, networks=lambda: networks)
    task = services.db.add_care_task("1a2b3c4d", "Fertilize", 14, time.time())
    app = create_app(services, background_tasks=False, port=8710)
    local = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8710")
    async with local:
        await local.put("/api/remote-access", json={"enabled": True, "networks": ["192.168.50.0/24"],
                                                    "password": "correct horse battery"}, headers=CHANGE)
        key = (await local.post("/api/remote-access/links", json={"name": "Kitchen"}, headers=CHANGE)).json()["link"]["key"]
    tablet = httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=("192.168.50.30", 50000)),
                               base_url="http://192.168.50.178:8710")
    async with tablet:
        header = {remote.KEY_HEADER: key, **CHANGE}
        assert (await tablet.get("/api/devices/1a2b3c4d/care", headers=header)).status_code == 200
        assert (await tablet.post(f"/api/care/{task['id']}/done", headers=header)).status_code == 200
        assert (await tablet.post("/api/devices/1a2b3c4d/care", json={"what": "x", "every_days": 1}, headers=header)).status_code == 403
        assert (await tablet.delete(f"/api/care/{task['id']}", headers=header)).status_code == 403
    assert services.db.activity("1a2b3c4d")[-1]["actor"] == "the link “Kitchen”"
