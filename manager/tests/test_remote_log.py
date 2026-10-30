"""The log over the air: the 'log' resource in the CoAP client and the simulated board, and the
console that reads it (firmware built with CONFIG_HACOAP_REMOTE_LOG)."""

import asyncio

import httpx
import pytest

from hacoap_manager import coap, console
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


@pytest.fixture(autouse=True)
def quick_polls(monkeypatch):
    monkeypatch.setattr(console, "POLL_S", 0.05)
    monkeypatch.setattr(console, "RETRY_S", 0.05)


async def wait_for(condition, seconds=5.0):
    for _ in range(int(seconds / 0.05)):
        if condition():
            return True
        await asyncio.sleep(0.05)
    return False


# ---------------------------------------------------------------- the CoAP client

def test_uri_query_round_trip():
    data = coap.encode(coap.TYPE_CON, coap.GET, 1, b"\x01", "log", query=("from=1234", "x=1"))
    message = coap.decode(data)
    assert message.path == "log" and message.query == ("from=1234", "x=1")


def test_parse_log():
    chunk = coap.parse_log(b"0000002b 12\n<inf> hello\n")
    assert (chunk.boot_id, chunk.start, chunk.text, chunk.full) == ("0000002b", 12, b"<inf> hello\n", False)
    assert coap.parse_log(b"0000002b 0\n" + b"x" * 501).full
    for bad in (b"", b"0000002b\nx", b"0000002b x\n", b"no newline"):
        with pytest.raises(coap.CoapError):
            coap.parse_log(bad)


async def test_reads_the_log_by_offset(start_sim):
    server = await start_sim()
    first = await coap.get_log("127.0.0.1", 0, port=server.coap_port)
    assert first.start == 0 and first.text.startswith(b"*** Booting") and first.full
    rest = await coap.get_log("127.0.0.1", len(first.text), port=server.coap_port)
    assert rest.boot_id == first.boot_id and rest.start == len(first.text)
    assert b"SRP callback: OK" in first.text + rest.text


async def test_a_board_without_the_log_answers_not_found(start_sim):
    server = await start_sim(remote_log=False)
    with pytest.raises(coap.NoLog):
        await coap.get_log("127.0.0.1", 0, port=server.coap_port)


# ---------------------------------------------------------------- the console

async def open_air(client, services, server):
    fast_settings(services.settings, server)
    services.db.upsert_device("1a2b3c4d", name="basil", address="127.0.0.1")
    return (await client.post("/api/console/open", json={"device_id": "1a2b3c4d"}, headers=CHANGE)).json()


async def test_console_shows_a_boards_log(client, services, start_sim):
    server = await start_sim()
    state = await open_air(client, services, server)
    assert state["open"] and state["source"] == "air" and state["device_name"] == "basil" and state["port"] is None
    assert await wait_for(lambda: any("SRP callback: OK" in line for line in services.console.lines))
    lines = list(services.console.lines)
    assert lines[0] == "*** Booting nRF Connect SDK v2.4.3 ***"
    assert len(lines) == len(set(lines))                     # every line once, none cut in two

    # New lines as they come
    await coap.ping("127.0.0.1", port=server.coap_port)
    assert await wait_for(lambda: any("'ping' PUT" in line for line in services.console.lines))

    # Nothing to send over the air
    assert (await client.post("/api/console/send", json={"text": "x"}, headers=CHANGE)).status_code == 400
    assert not (await client.post("/api/console/close", headers=CHANGE)).json()["open"]


async def test_console_notices_a_restart(client, services, start_sim):
    server = await start_sim()
    await open_air(client, services, server)
    assert await wait_for(lambda: any("SRP callback" in line for line in services.console.lines))
    server.device.reset()
    assert await wait_for(lambda: "[console: the board restarted]" in services.console.lines)
    after = list(services.console.lines)[list(services.console.lines).index("[console: the board restarted]"):]
    assert await wait_for(lambda: any("Booting" in line for line in
                                      list(services.console.lines)[len(services.console.lines) - len(after):]))


async def test_console_says_when_the_firmware_has_no_log(client, services, start_sim):
    server = await start_sim(remote_log=False)
    await open_air(client, services, server)
    assert await wait_for(lambda: not services.console.state()["open"])
    assert "keeps no log over the air" in services.console.lines[-1]


async def test_console_needs_a_known_device_with_an_address(client, services):
    response = await client.post("/api/console/open", json={"device_id": "nope"}, headers=CHANGE)
    assert response.status_code == 404
    services.db.upsert_device("5e6f7a8b", name="fern")
    response = await client.post("/api/console/open", json={"device_id": "5e6f7a8b"}, headers=CHANGE)
    assert response.status_code == 400 and "address" in response.json()["detail"]
