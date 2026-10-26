import httpx
import pytest

from hacoap_manager import config
from hacoap_manager.app import create_app, create_services
from hacoap_manager.db import Database
from hacoap_manager.events import EventBus
from hacoap_manager.network import NetworkError, NetworkService
from hacoap_manager.otbr import BorderRouter, BorderRouterError
from hacoap_manager.simborder import SimulatedBorderRouter, link_quality, scenario

CHANGE = {"X-HACoap": "1"}


@pytest.fixture
def border(request):
    started = []

    def start(mode, net=None):
        sim = SimulatedBorderRouter(mode, net=net).start()
        started.append(sim)
        return sim

    yield start
    for sim in started:
        sim.stop()


def by_rloc(topology):
    return {n["rloc16_hex"]: n for n in topology["nodes"]}


def link(topology, a, b):
    nodes = by_rloc(topology)
    ids = {nodes[a]["id"], nodes[b]["id"]}
    return next(l for l in topology["links"] if {l["a"], l["b"]} == ids)


def test_current_api(border):
    sim = border("api")
    topology = BorderRouter(sim.url, poll_interval=0.01).topology().as_dict()
    assert topology["source"] == "api"
    nodes = by_rloc(topology)
    assert nodes["0x5000"]["role"] == "leader" and nodes["0x5000"]["border_router"]
    assert nodes["0x6800"]["kind"] == "router"
    assert (nodes["0x5001"]["kind"], nodes["0x7c02"]["kind"], nodes["0x5003"]["kind"]) == ("SED", "MED", "FTD child")
    assert nodes["0x6801"]["parent"] == nodes["0x6800"]["id"]
    assert nodes["0x5001"]["ipv6"] == ["fd11:22::1"]
    # Signal strength on every link
    assert link(topology, "0x5000", "0x6800")["link_margin"] == 45
    assert link(topology, "0x5001", "0x5000")["average_rssi"] == -38
    assert link(topology, "0x6801", "0x6800")["link_margin"] == 14
    assert len([l for l in topology["links"] if l["kind"] == "mesh"]) == 3
    assert len([l for l in topology["links"] if l["kind"] == "child"]) == 4
    assert not topology["warnings"]
    # The border router was asked for each router's diagnostics, with JSON:API
    assert sum(1 for method, path in sim.requests if path.startswith("/api/diagnostics/")) == 3


def test_older_api(border):
    sim = border("legacy")
    topology = BorderRouter(sim.url).topology().as_dict()
    assert topology["source"] == "diagnostics"
    nodes = by_rloc(topology)
    assert nodes["0x5000"]["role"] == "leader" and nodes["0x5000"]["border_router"]
    assert nodes["0x7c00"]["role"] == "router"
    assert nodes["0x5001"]["kind"] == "SED" and nodes["0x5001"]["parent"] == nodes["0x5000"]["id"]
    assert nodes["0x7c02"]["kind"] == "MED"
    mesh = link(topology, "0x6800", "0x7c00")
    assert (mesh["link_quality_in"], mesh["link_margin"]) == (link_quality(18), None)
    assert any("no signal strength" in w for w in topology["warnings"])


def test_unreachable_border_router():
    with pytest.raises(BorderRouterError, match="Cannot reach"):
        BorderRouter("http://127.0.0.1:9", timeout=1).topology()


@pytest.fixture
def service(tmp_path):
    db = Database(tmp_path / "test.db")
    settings = config.Settings()
    yield NetworkService(tmp_path, db, settings, EventBus())
    db.close()


async def test_boards_are_named_and_parent_changes_logged(service, border):
    service.db.upsert_device("1a2b3c4d", name="basil", address="fd11:22::1")
    net = scenario()
    sim = border("api", net)
    service.settings.border_router_url = sim.url

    state = await service.refresh()
    nodes = by_rloc(state["topology"])
    assert (nodes["0x5001"]["device_id"], nodes["0x5001"]["name"]) == ("1a2b3c4d", "basil")
    assert "device_id" not in nodes["0x7c02"]
    assert state["events"] == []

    # basil moves to the hub
    child = next(c for c in net["children"] if c["ext"] == "d100000000000001")
    child.update(parent=0x7c00, rloc16=0x7c05)
    state = await service.refresh()
    assert by_rloc(state["topology"])["0x7c05"]["name"] == "basil"
    assert state["events"][0]["message"] == "basil: parent changed from 0x5000 to 0x7c00"
    # It's kept for the next start
    assert service.last()["nodes"]


async def test_refresh_needs_an_address(service):
    with pytest.raises(NetworkError, match="address"):
        await service.refresh()


async def test_network_api(tmp_path, border):
    services = create_services(tmp_path / "data", discover=None)
    sim = border("api")
    app = create_app(services, background_tasks=False)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8710") as client:
        assert (await client.get("/api/network")).json()["topology"] is None
        assert (await client.post("/api/network/refresh", headers=CHANGE)).status_code == 400
        await client.put("/api/settings", json={"border_router_url": sim.url}, headers=CHANGE)
        response = await client.post("/api/network/refresh", headers=CHANGE)
        assert response.status_code == 200, response.text
        assert len(response.json()["topology"]["nodes"]) == 7
        assert (await client.get("/api/network")).json()["border_router_url"] == sim.url
    services.db.close()


@pytest.mark.parametrize("mode", ["api", "legacy"])
def test_a_bigger_fleet(border, mode):
    """24 boards: two more routers, every board a sleepy child somewhere."""
    addresses = [f"127.0.0.{i + 1}" for i in range(24)]
    sim = border(mode, scenario(addresses))
    topology = BorderRouter(sim.url, poll_interval=0.01).topology().as_dict()
    routers = [n for n in topology["nodes"] if n["kind"] == "router" or n.get("border_router")]
    assert len(routers) == 5
    sleepy = [n for n in topology["nodes"] if n["kind"] == "SED"]
    assert len(sleepy) == 24
    assert len({n["rloc16_hex"] for n in topology["nodes"]}) == len(topology["nodes"])
    if mode == "api":   # only the current API gives children's addresses
        found = {a for n in sleepy for a in n["ipv6"]}
        assert set(addresses) <= found
