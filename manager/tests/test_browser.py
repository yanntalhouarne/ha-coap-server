"""Opens every tab of the page in a real headless browser (Chrome, Chromium or Edge) and
checks that it shows the data, which catches script errors a syntax check can't. Skipped
when no such browser is installed (GitHub's runners have Chrome)."""

import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest
import uvicorn

from hacoap_manager.app import create_app, create_services
from hacoap_manager.otbr import BorderRouter
from hacoap_manager.simborder import SimulatedBorderRouter, scenario

from conftest import NEW_HASH, NEW_IMAGE

CANDIDATES = [
    os.environ.get("CHROME", ""),
    "google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome", "msedge",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]


def find_browser():
    for candidate in CANDIDATES:
        if not candidate:
            continue
        found = shutil.which(candidate) or (candidate if Path(candidate).is_file() else None)
        if found:
            return found
    return None


@pytest.fixture(scope="module")
def page(tmp_path_factory):
    browser = find_browser()
    if browser is None:
        pytest.skip("no Chrome, Chromium or Edge installed")
    tmp = tmp_path_factory.mktemp("browser")
    services = create_services(tmp / "data", discover=None)
    services.db.upsert_device("1a2b3c4d", name="basil", address="fd11:22::1", battery=87, temperature=-5,
                              last_seen=time.time())
    services.images.add(NEW_IMAGE, "app_update.bin", "browser test image")
    services.db.add_update("job", "1a2b3c4d", "udp", NEW_HASH, "1.1.0", 1.0, 2.0, "updated", "Updated and confirmed")
    border = SimulatedBorderRouter("api", net=scenario()).start()
    services.settings.border_router_url = border.url
    topology = BorderRouter(border.url, poll_interval=0.01).topology().as_dict()
    services.network._name_boards(topology)
    services.network.cache.write_text(__import__("json").dumps(topology))

    app = create_app(services, background_tasks=False)
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    for _ in range(100):
        if server.started:
            break
        time.sleep(0.05)
    port = server.servers[0].sockets[0].getsockname()[1]

    def dump(tab):
        command = [browser, "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
                   f"--user-data-dir={tmp / 'profile'}", "--virtual-time-budget=8000", "--dump-dom",
                   f"http://127.0.0.1:{port}/#{tab}"]
        result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=90)
        return result.stdout

    yield dump
    server.should_exit = True
    thread.join(10)
    border.stop()
    services.db.close()


def test_devices_tab(page):
    dom = page("devices")
    assert "basil" in dom and "87 %" in dom and "-5 °C" in dom
    assert "Update history" in dom


def test_network_tab(page):
    dom = page("network")
    assert "<svg" in dom and "Border router" in dom and "basil" in dom
    assert "with signal strength" in dom


def test_updates_tab(page):
    dom = page("updates")
    assert "browser test image" in dom          # the image choice
    assert "Updated and confirmed" in dom       # the history


def test_images_tab(page):
    assert "v1.1.0" in page("images")


def test_builds_tab(page):
    dom = page("builds")
    assert "Production" in dom and "Sensor sampling period" in dom


def test_settings_tab(page):
    dom = page("settings")
    assert "Data folder" in dom and "Border router REST API" in dom


def test_dark_by_default(page):
    assert 'data-bs-theme="dark"' in page("devices")
