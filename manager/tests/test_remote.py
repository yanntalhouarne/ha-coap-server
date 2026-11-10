"""Other devices (Settings → Other devices): off by default, then only from the chosen networks,
on this computer's own address there, and only once signed in."""

import socket
import zipfile
import io

import httpx
import pytest

from hacoap_manager import backup, remote
from hacoap_manager.app import create_app, create_services

CHANGE = {"X-HACoap": "1"}
HOME = {"network": "192.168.50.0/24", "address": "192.168.50.178", "interface": "eth0", "kind": "lan"}
ZEROTIER = {"network": "10.147.17.0/24", "address": "10.147.17.5", "interface": "ztabcdef", "kind": "zerotier"}
SERVER = "http://192.168.50.178:8710"
PASSWORD = "correct horse battery"
WS_HEADERS = {"host": "192.168.50.178:8710", "origin": SERVER}  # the test client's WebSocket names testserver


@pytest.fixture
def services(tmp_path):
    services = create_services(tmp_path / "data", discover=None)
    services.remote = remote.RemoteAccess(tmp_path / "data", networks=lambda: [HOME, ZEROTIER])
    yield services
    services.console.close()
    services.db.close()


def client_for(services, address="127.0.0.1", base_url="http://127.0.0.1:8710"):
    app = create_app(services, background_tasks=False, on_quit=lambda: None, port=8710)
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=(address, 50000)), base_url=base_url)


async def allow_home_network(services):
    async with client_for(services) as local:
        response = await local.put("/api/remote-access", json={"enabled": True, "networks": ["192.168.50.0/24"],
                                                                "password": PASSWORD}, headers=CHANGE)
        assert response.status_code == 200, response.text
        return response.json()


async def test_off_by_default(services):
    async with client_for(services, "192.168.50.20", SERVER) as phone:
        assert (await phone.get("/api/devices")).status_code == 403
        assert (await phone.get("/login")).status_code == 403
    async with client_for(services) as local:
        state = (await local.get("/api/remote-access")).json()
    assert not state["enabled"] and not state["password_set"]
    assert [n["kind"] for n in state["available"]] == ["lan", "zerotier"]


async def test_turning_it_on_needs_a_password_and_a_network(services):
    async with client_for(services) as local:
        refused = await local.put("/api/remote-access", json={"enabled": True, "networks": ["192.168.50.0/24"]}, headers=CHANGE)
        assert refused.status_code == 400 and "password" in refused.json()["detail"]
        short = await local.put("/api/remote-access", json={"password": "short"}, headers=CHANGE)
        assert short.status_code == 400
        refused = await local.put("/api/remote-access", json={"enabled": True, "password": PASSWORD}, headers=CHANGE)
        assert refused.status_code == 400 and "network" in refused.json()["detail"]
        bad = await local.put("/api/remote-access", json={"networks": ["not a network"]}, headers=CHANGE)
        assert bad.status_code == 400
    state = await allow_home_network(services)
    assert state["enabled"] and state["addresses"] == ["http://192.168.50.178:8710/"]
    assert "hash" not in str(state) and "salt" not in str(state)


async def test_another_device_signs_in_first(services):
    await allow_home_network(services)
    async with client_for(services, "192.168.50.20", SERVER) as phone:
        page = await phone.get("/")
        assert page.status_code == 303 and page.headers["location"] == "/login"
        assert (await phone.get("/api/devices")).status_code == 401
        login_page = await phone.get("/login")
        assert login_page.status_code == 200 and "Sign in" in login_page.text
        assert (await phone.get("/static/style.css")).status_code == 200  # what the sign-in page loads

        wrong = await phone.post("/api/login", json={"password": "nope"}, headers=CHANGE)
        assert wrong.status_code == 401 and wrong.json()["detail"] == "Wrong password"
        right = await phone.post("/api/login", json={"password": PASSWORD}, headers=CHANGE)
        assert right.status_code == 200
        cookie = right.headers["set-cookie"].lower()
        assert "httponly" in cookie and "samesite=strict" in cookie

        assert (await phone.get("/api/devices")).status_code == 200
        assert (await phone.get("/api/status")).json()["access"] == "remote"
        assert (await phone.get("/")).status_code == 200
        # Changes still need the header (against other websites)
        assert (await phone.post("/api/discover")).status_code == 403
        # Never from another device: turning it off, the networks, the password, and stopping the app.
        # It sees them (to make links and sign devices out, with the password again).
        seen = await phone.get("/api/remote-access")
        assert seen.status_code == 200 and seen.json()["here"] == "remote" and "hash" not in seen.text
        assert (await phone.put("/api/remote-access", json={"enabled": False}, headers=CHANGE)).status_code == 403
        assert (await phone.post("/api/quit", headers=CHANGE)).status_code == 403

        await phone.post("/api/logout", headers=CHANGE)
        assert (await phone.get("/api/devices")).status_code == 401


async def test_only_the_chosen_networks_and_this_computers_address(services):
    await allow_home_network(services)
    async with client_for(services, "10.147.17.9", "http://10.147.17.5:8710") as zerotier:  # not chosen
        assert (await zerotier.get("/login")).status_code == 403
    async with client_for(services, "192.168.50.20", "http://evil.example:8710") as rebinding:
        assert (await rebinding.get("/login")).status_code == 403
    # Another computer naming 127.0.0.1 isn't this computer
    async with client_for(services, "192.168.50.20", "http://127.0.0.1:8710") as spoof:
        assert (await spoof.get("/api/devices")).status_code == 403
    async with client_for(services) as local:  # this computer: as before, no password
        assert (await local.get("/api/devices")).status_code == 200
        assert (await local.get("/api/status")).json()["access"] == "local"


async def test_too_many_wrong_passwords_wait(services):
    await allow_home_network(services)
    async with client_for(services, "192.168.50.20", SERVER) as phone:
        for _ in range(remote.FREE_TRIES):
            assert (await phone.post("/api/login", json={"password": "nope"}, headers=CHANGE)).status_code == 401
        waiting = await phone.post("/api/login", json={"password": PASSWORD}, headers=CHANGE)
        assert waiting.status_code == 401 and "try again" in waiting.json()["detail"]
    async with client_for(services, "192.168.50.21", SERVER) as laptop:  # another address isn't held up
        assert (await laptop.post("/api/login", json={"password": PASSWORD}, headers=CHANGE)).status_code == 200


async def test_signing_devices_out_from_this_computer(services):
    await allow_home_network(services)
    async with client_for(services, "192.168.50.20", SERVER) as phone, client_for(services) as local:
        await phone.post("/api/login", json={"password": PASSWORD}, headers={**CHANGE, "User-Agent": "Phone browser"})
        sessions = (await local.get("/api/remote-access")).json()["sessions"]
        assert [(s["address"], s["device"]) for s in sessions] == [("192.168.50.20", "Phone browser")]
        await local.delete(f"/api/remote-access/sessions/{sessions[0]['id']}", headers=CHANGE)
        assert (await phone.get("/api/devices")).status_code == 401

        await phone.post("/api/login", json={"password": PASSWORD}, headers=CHANGE)
        await local.put("/api/remote-access", json={"password": "a brand new password"}, headers=CHANGE)
        assert (await phone.get("/api/devices")).status_code == 401  # a new password signs everyone out
        assert (await local.get("/api/remote-access")).json()["sessions"] == []


async def test_turned_off_again(services):
    await allow_home_network(services)
    async with client_for(services, "192.168.50.20", SERVER) as phone, client_for(services) as local:
        await phone.post("/api/login", json={"password": PASSWORD}, headers=CHANGE)
        await local.put("/api/remote-access", json={"enabled": False}, headers=CHANGE)
        assert (await phone.get("/api/devices")).status_code == 403


def test_live_events_need_a_session(services):
    from starlette.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect

    services.remote.configure(enabled=True, networks=["192.168.50.0/24"], password=PASSWORD)
    app = create_app(services, background_tasks=False, port=8710)
    with TestClient(app, base_url=SERVER, client=("192.168.50.20", 50000)) as phone:
        with pytest.raises(WebSocketDisconnect):
            with phone.websocket_connect("/api/events", headers=WS_HEADERS) as ws:
                ws.receive_json()
        signed_in = phone.post("/api/login", json={"password": PASSWORD}, headers=CHANGE)
        assert signed_in.status_code == 200
        # (its cookie jar keeps the cookie for 192.168.50.178, and its WebSocket says testserver)
        cookie = {"cookie": f"{remote.COOKIE}={signed_in.cookies[remote.COOKIE]}"}
        with phone.websocket_connect("/api/events", headers={**WS_HEADERS, **cookie}):
            pass  # accepted
        with pytest.raises(WebSocketDisconnect):  # and not from another website
            with phone.websocket_connect("/api/events", headers={**WS_HEADERS, **cookie, "origin": "http://evil.example"}) as ws:
                ws.receive_json()


def test_signed_out_devices_stop_getting_live_events(services, monkeypatch):
    from starlette.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect
    from hacoap_manager import app as app_module

    monkeypatch.setattr(app_module, "EVENTS_SESSION_CHECK_S", 0.1)
    services.remote.configure(enabled=True, networks=["192.168.50.0/24"], password=PASSWORD)
    app = create_app(services, background_tasks=False, port=8710)
    with TestClient(app, base_url=SERVER, client=("192.168.50.20", 50000)) as phone:
        signed_in = phone.post("/api/login", json={"password": PASSWORD}, headers=CHANGE)
        cookie = {"cookie": f"{remote.COOKIE}={signed_in.cookies[remote.COOKIE]}"}
        with phone.websocket_connect("/api/events", headers={**WS_HEADERS, **cookie}) as ws:
            services.events.publish("devices")
            assert ws.receive_json()["type"] == "devices"
            services.remote.sign_out(everyone=True)  # from the computer
            with pytest.raises(WebSocketDisconnect) as closed:
                ws.receive_json()
            assert closed.value.code == 1008


def test_never_in_a_backup_or_a_report(services):
    from hacoap_manager import report

    services.remote.configure(enabled=True, networks=["192.168.50.0/24"], password=PASSWORD)
    assert (services.data_dir / remote.FILE_NAME).is_file()
    names = zipfile.ZipFile(io.BytesIO(backup.create_backup(services.data_dir, services.db, services.settings))).namelist()
    assert not any("remote" in name for name in names)
    archive = zipfile.ZipFile(io.BytesIO(report.create_report(services, [])))
    assert not any(PASSWORD in archive.read(name).decode("utf-8", errors="replace") for name in archive.namelist())
    assert not any("remote-access" in name for name in archive.namelist())


async def test_the_listener_serves_and_stops(services):
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    app = create_app(services, background_tasks=False, port=port)
    listener = remote.RemoteListener(app, port)
    await listener.apply(["127.0.0.1"])
    try:
        assert listener.listening == ["127.0.0.1"]
        async with httpx.AsyncClient() as http:
            assert (await http.get(f"http://127.0.0.1:{port}/api/status")).status_code == 200
    finally:
        await listener.stop()
    assert listener.listening == []
    with pytest.raises(httpx.ConnectError):
        async with httpx.AsyncClient() as http:
            await http.get(f"http://127.0.0.1:{port}/api/status")


def test_this_computers_networks():
    for network in remote.local_networks():
        assert network["kind"] in ("lan", "zerotier") and "/" in network["network"]


# ---------------------------------------------------------------- dashboard links

async def make_link(services, name="Home Assistant"):
    async with client_for(services) as local:
        made = await local.post("/api/remote-access/links", json={"name": name}, headers=CHANGE)
        assert made.status_code == 200, made.text
        return made.json()


async def test_a_dashboard_link_opens_the_plants_only(services):
    await allow_home_network(services)
    services.db.upsert_device("1a2b3c4d", name="ha-coap-1a2b3c4d", plant="basil", address="fd11::1")
    made = await make_link(services)
    key = made["link"]["key"]
    assert made["link"]["addresses"] == [f"http://192.168.50.178:8710/?key={key}#plants"]
    assert made["links"][0]["name"] == "Home Assistant" and made["links"][0]["last_used"] is None
    assert key not in str(made["links"]) and key not in (services.data_dir / remote.FILE_NAME).read_text()

    async with client_for(services, "192.168.50.30", SERVER) as dashboard:
        header = {remote.KEY_HEADER: key}
        # The page with the key in its address (as a Home Assistant card opens it), then the plants' API
        assert (await dashboard.get(f"/?key={key}")).status_code == 200
        assert (await dashboard.get("/api/wall", headers=header)).status_code == 200
        assert (await dashboard.get("/api/devices", headers=header)).status_code == 200
        assert (await dashboard.get("/api/devices/1a2b3c4d/details", headers=header)).status_code == 200
        assert (await dashboard.get("/api/status", headers=header)).json()["access"] == "link"
        renamed = await dashboard.patch("/api/devices/1a2b3c4d", json={"plant": "Genovese basil"}, headers={**header, **CHANGE})
        assert renamed.status_code == 200 and renamed.json()["plant"] == "Genovese basil"
        # Nothing else: not another field of a device, updates, settings, backups, the border router...
        assert (await dashboard.patch("/api/devices/1a2b3c4d", json={"address": "fd66::6"},
                                      headers={**header, **CHANGE})).status_code == 403
        for method, path in [("GET", "/api/backup"), ("GET", "/api/settings"), ("PUT", "/api/settings"),
                             ("POST", "/api/updates"), ("GET", "/api/border-router/network"),
                             ("POST", "/api/border-router/network/reveal"), ("GET", "/api/remote-access"),
                             ("POST", "/api/remote-access/links"), ("DELETE", "/api/devices/1a2b3c4d"),
                             ("POST", "/api/firmware-builds"), ("GET", "/api/home-assistant")]:
            response = await dashboard.request(method, path, headers={**header, **CHANGE}, json={})
            assert response.status_code == 403, (method, path, response.status_code)
        # A wrong key is no key: sign in, as before
        assert (await dashboard.get("/api/devices", headers={remote.KEY_HEADER: "nope"})).status_code == 401
        # It's not a key for another network either
    async with client_for(services, "10.147.17.40", "http://10.147.17.5:8710") as elsewhere:
        assert (await elsewhere.get("/api/devices", headers={remote.KEY_HEADER: key})).status_code == 403

    async with client_for(services) as local:
        link = (await local.get("/api/remote-access")).json()["links"][0]
        assert link["address"] == "192.168.50.30" and link["last_used"]
        # Revoked: it stops at once, and says so (no password page in a dashboard)
        assert (await local.delete(f"/api/remote-access/links/{link['id']}", headers=CHANGE)).status_code == 200
        assert (await local.delete(f"/api/remote-access/links/{link['id']}", headers=CHANGE)).status_code == 404
    async with client_for(services, "192.168.50.30", SERVER) as dashboard:
        page = await dashboard.get(f"/?key={key}")
        assert page.status_code == 401 and "doesn't work any more" in page.text
        assert (await dashboard.get("/api/wall", headers={remote.KEY_HEADER: key})).status_code == 401


async def test_links_from_another_device_take_the_password_again(services):
    await allow_home_network(services)
    key = (await make_link(services))["link"]["key"]
    async with client_for(services, "192.168.50.20", SERVER) as phone:
        await phone.post("/api/login", json={"password": PASSWORD}, headers=CHANGE)
        confirm = lambda password: {**CHANGE, "X-HACoap-Password": password}  # noqa: E731
        make = lambda headers: phone.post("/api/remote-access/links", json={"name": "phone's"}, headers=headers)  # noqa: E731
        nothing = await make(CHANGE)
        assert nothing.status_code == 403 and "Type the password" in nothing.json()["detail"]
        assert services.remote._failures == {}  # nothing typed isn't a wrong password
        assert (await make(confirm("wrong"))).status_code == 403
        made = await make(confirm(PASSWORD))
        assert made.status_code == 200 and made.json()["link"]["key"]
        link_id = next(l["id"] for l in made.json()["links"] if l["name"] == "phone's")
        assert (await phone.delete(f"/api/remote-access/links/{link_id}", headers=CHANGE)).status_code == 403
        assert (await phone.delete(f"/api/remote-access/links/{link_id}", headers=confirm(PASSWORD))).status_code == 200
        # Signing devices out too (itself included)
        assert (await phone.delete("/api/remote-access/sessions", headers=CHANGE)).status_code == 403
        assert (await phone.delete("/api/remote-access/sessions", headers=confirm(PASSWORD))).status_code == 200
        assert (await phone.get("/api/devices")).status_code == 401
        # Wrong ones count with the sign-ins: five, then a wait
    async with client_for(services, "192.168.50.21", SERVER) as tablet:
        await tablet.post("/api/login", json={"password": PASSWORD}, headers=CHANGE)
        for _ in range(5):
            await tablet.post("/api/remote-access/links", json={"name": "x"}, headers={**CHANGE, "X-HACoap-Password": "nope"})
        waiting = await tablet.post("/api/remote-access/links", json={"name": "x"},
                                    headers={**CHANGE, "X-HACoap-Password": PASSWORD})
        assert waiting.status_code == 403 and "Too many wrong passwords" in waiting.json()["detail"]
    # A dashboard link reaches none of it
    async with client_for(services, "192.168.50.30", SERVER) as dashboard:
        for method in ("GET", "POST"):
            assert (await dashboard.request(method, "/api/remote-access/links" if method == "POST" else "/api/remote-access",
                                            headers={remote.KEY_HEADER: key, **CHANGE}, json={"name": "x"})).status_code == 403
    async with client_for(services) as local:
        assert (await local.post("/api/remote-access/links", json={"name": "  "}, headers=CHANGE)).status_code == 400
        # Other devices turned off: links stop too
        await local.put("/api/remote-access", json={"enabled": False}, headers=CHANGE)
    async with client_for(services, "192.168.50.30", SERVER) as dashboard:
        assert (await dashboard.get("/api/wall", headers={remote.KEY_HEADER: key})).status_code == 403


def test_a_dashboard_links_live_events(services, monkeypatch):
    from starlette.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect
    from hacoap_manager import app as app_module

    monkeypatch.setattr(app_module, "EVENTS_SESSION_CHECK_S", 0.1)
    services.remote.configure(enabled=True, networks=["192.168.50.0/24"], password=PASSWORD)
    key = services.remote.create_link("Home Assistant")
    app = create_app(services, background_tasks=False, port=8710)
    with TestClient(app, base_url=SERVER, client=("192.168.50.30", 50000)) as dashboard:
        with dashboard.websocket_connect(f"/api/events?key={key}", headers=WS_HEADERS) as ws:
            services.events.publish("build-log", line="secret build output")  # not for a link
            services.events.publish("devices")
            assert ws.receive_json()["type"] == "devices"
            link_id = next(iter(services.remote.describe()["links"]))["id"]
            services.remote.revoke_link(link_id)
            with pytest.raises(WebSocketDisconnect) as closed:
                ws.receive_json()
            assert closed.value.code == 1008
