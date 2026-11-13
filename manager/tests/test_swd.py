"""Flashing a board over SWD: the probe list, the commands, the runner, the checks and the API.
No J-Link here: nrfutil is replaced by stand-ins."""

import asyncio
import json
import sys

import httpx
import pytest

from hacoap_manager import builds, mcuboot, swd
from hacoap_manager.app import create_app, create_services
from hacoap_manager.setup_tools import SetupError, SetupRunner

CHANGE = {"X-HACoap": "1"}

# What 'nrfutil --json device list' prints: progress lines, then the devices in 'task_end'.
DEVICE_LIST = "\n".join(json.dumps(line) for line in [
    {"type": "task_begin", "data": {"task": {"name": "list"}}},
    {"type": "task_end", "data": {"data": {"devices": [
        {"serialNumber": "000683123456", "traits": {"jlink": True, "seggerUsb": True, "usb": True}},
        {"serialNumber": "001050799999", "traits": {"jlink": True, "devkit": True}},
        {"serialNumber": None, "traits": {"serialPorts": True}},             # a plain USB serial port
        {"serialNumber": "-rf", "traits": {"jlink": True}},                   # never passed on as a flag
    ]}}},
])


def test_parse_probes():
    assert swd.parse_probes(DEVICE_LIST) == [{"serial": "000683123456", "devkit": False},
                                             {"serial": "001050799999", "devkit": True}]
    assert swd.parse_probes("not json\n") == []


def test_flash_commands():
    keep = swd.flash_commands("nrfutil", "merged.hex", "000683123456", "keep")
    assert keep == [["nrfutil", "device", "program", "--firmware", "merged.hex", "--serial-number", "000683123456",
                     "--options", "chip_erase_mode=ERASE_RANGES_TOUCHED_BY_FIRMWARE,reset=RESET_SYSTEM"]]
    everything = swd.flash_commands("nrfutil", "merged.hex", "000683123456", "all")
    assert everything[0] == ["nrfutil", "device", "recover", "--serial-number", "000683123456"]
    assert "chip_erase_mode=ERASE_ALL,reset=RESET_SYSTEM" in everything[1]
    with pytest.raises(swd.SwdError):
        swd.flash_commands("nrfutil", "merged.hex", "--erase", "keep")
    with pytest.raises(swd.SwdError):
        swd.flash_commands("nrfutil", "merged.hex", "000683123456", "some")


def make_build(repo, variant="battery", app=b"application"):
    folder = builds.build_dir(repo, variant) / "zephyr"
    folder.mkdir(parents=True)
    (folder / "merged.hex").write_text(":00000001FF\n")
    (folder / "app_update.bin").write_bytes(mcuboot.build_image(app))


def test_hex_files(tmp_path):
    make_build(tmp_path, "battery")
    (builds.build_dir(tmp_path, "debug") / "zephyr").mkdir(parents=True)   # a build that didn't finish
    found = swd.hex_files(tmp_path)
    assert [b["variant"] for b in found] == ["battery"] and found[0]["app"].name == "app_update.bin"
    assert swd.hex_files(None) == []


async def test_flash_runs_each_step_and_stops_at_a_failure(tmp_path, monkeypatch):
    steps = [[sys.executable, "-c", "print('recovered')"],
             [sys.executable, "-c", "import sys; print('programming'); sys.exit(3)"],
             [sys.executable, "-c", "print('never')"]]
    monkeypatch.setattr(swd, "flash_commands", lambda *args: steps)

    class Events:
        def publish(self, kind, **data):
            pass

    runner = SetupRunner(tmp_path, Events(), nrfutil=lambda: "nrfutil")
    runner.flash(tmp_path / "merged.hex", "000683123456", "all", "the battery build")
    state = await asyncio.wait_for(runner.wait(), 30)
    assert state["state"] == "failed" and state["name"] == "SWD flash of the battery build"
    assert "recovered" in runner.log and "programming" in runner.log and "never" not in runner.log

    no_nrfutil = SetupRunner(tmp_path, Events(), nrfutil=lambda: None)
    with pytest.raises(SetupError, match="build tools"):
        no_nrfutil.start("device")


def test_checks(tmp_path, monkeypatch):
    monkeypatch.setattr(builds, "find_nrfutil", lambda: "nrfutil")
    monkeypatch.setattr(swd, "nrfutil_device_installed", lambda: False)
    monkeypatch.setattr(swd, "find_jlink", lambda: None)
    checks = {c["name"]: c for c in builds.checks(tmp_path)}
    tools, jlink = checks["SWD flashing tools"], checks["J-Link software"]
    assert not tools["ok"] and tools["optional"] and tools["fix"] == "device"
    assert not jlink["ok"] and jlink["link"] == swd.JLINK_DOWNLOAD and "fix" not in jlink
    monkeypatch.setattr(builds, "find_nrfutil", lambda: None)
    assert builds.checks(tmp_path)[-2]["fix"] is None   # nothing to install it with yet


async def test_api(tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    make_build(repo, "battery")                  # its application is unsigned
    services = create_services(tmp_path / "data", discover=None)
    services.repository = repo
    services.setup.repository = repo
    services.setup._nrfutil = lambda: None
    app = create_app(services, background_tasks=False)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8710") as client:
            state = (await client.get("/api/swd")).json()
            assert [(b["variant"], b["signer"]) for b in state["builds"]] == [("battery", "unsigned")]
            flash = {"variant": "battery", "serial": "000683123456", "erase": "keep"}
            refused = await client.post("/api/swd/flash", json=flash, headers=CHANGE)
            assert refused.status_code == 400 and "signing key" in refused.json()["detail"]
            anyway = await client.post("/api/swd/flash", json={**flash, "allow_development_key": True}, headers=CHANGE)
            assert anyway.status_code == 400 and "build tools" in anyway.json()["detail"]   # no nrfutil here
            missing = await client.post("/api/swd/flash", json={**flash, "variant": "debug"}, headers=CHANGE)
            assert missing.status_code == 400 and "build it first" in missing.json()["detail"]
            assert (await client.get("/api/swd/probes")).status_code == 400
    finally:
        services.console.close()
        services.db.close()
