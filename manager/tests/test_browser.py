"""Opens every tab of the page in a real headless browser (Chrome, Chromium or Edge) and
checks that it shows the data, which catches script errors a syntax check can't. Skipped
when no such browser is installed (GitHub's runners have Chrome)."""

import os
import re
import shutil
import subprocess
import sys
import threading
import struct
import time
import zlib
from pathlib import Path

import pytest
import uvicorn

from hacoap_manager import builds
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


def tiny_png(width=40, height=30):
    """A plain gray PNG, for the floor plan."""
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    rows = b"".join(b"\x00" + b"\x80" * width for _ in range(height))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


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
                              soil_moisture=18, last_seen=time.time())
    services.alerts.scan()  # basil needs water
    services.images.add(NEW_IMAGE, "app_update.bin", "browser test image")
    services.db.add_update("job", "1a2b3c4d", "udp", NEW_HASH, "1.1.0", 1.0, 2.0, "updated", "Updated and confirmed")
    services.db.set_release(NEW_HASH)
    now = time.time()
    for hours in range(48, -1, -6):
        services.db.add_reading("1a2b3c4d", 90 - (48 - hours) / 16, 40, 55, -5, when=now - hours * 3600)
        services.db.add_link_sample("1a2b3c4d", "0x6800", link_margin=40, when=now - hours * 3600)
    services.db.add_activity("1a2b3c4d", "pump", "Pump started from the app (3 s)", when=now - 12 * 3600)
    # What the board reports about itself ('diag'): a watchdog restart 6 hours ago
    services.db.upsert_device("1a2b3c4d", boots=5, reset_cause="watchdog", uptime_s=6 * 3600, role="child",
                              rloc16="0x5c01", parent_rloc16="0x6800", parent_rssi=-64, link_quality=3, soil_mv=1650,
                              diag_time=now)
    services.db.add_activity("1a2b3c4d", "restart", "Restarted: the watchdog: it stopped responding",
                             when=now - 6 * 3600)
    # A checkout with nothing set up, so the Builds tab offers its setup buttons.
    empty_checkout = tmp / "checkout"
    (empty_checkout / "application").mkdir(parents=True)
    services.builds.checks = lambda: builds.checks(empty_checkout)
    border = SimulatedBorderRouter("api", net=scenario()).start()
    services.settings.border_router_url = border.url
    topology = BorderRouter(border.url, poll_interval=0.01).topology().as_dict()
    services.network._name_boards(topology)
    services.network.cache.write_text(__import__("json").dumps(topology))
    services.network.set_floorplan(tiny_png(), "home.png")
    services.network.set_position("1a2b3c4d", 0.5, 0.5)

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
    assert "Check my connection" in dom and "Print labels" in dom


def test_network_tab(page):
    dom = page("network")
    assert "<svg" in dom and "Border router" in dom and "basil" in dom
    assert "avatar" in dom and "map-toolbar" in dom and "link-flow" in dom    # the map, its backbone flowing
    assert "with signal strength" in dom
    assert "net-figure" in dom and "weakest link" in dom                       # the figures across the top
    assert 'class="net-row' in dom and "Your boards" in dom                    # the list of nodes


def test_tree_view(page):
    dom = page("network/tree")
    assert 'class="tree"' in dom and "tree-card" in dom and "tree-link" in dom
    assert "basil" in dom and " dB<" in dom                                    # a card with its signal


def test_updates_tab(page):
    dom = page("updates")
    assert "browser test image" in dom          # the image choice
    assert "Updated and confirmed" in dom       # the history


def test_images_tab(page):
    dom = page("images")
    assert "v1.1.0" in dom and "unsigned" in dom   # who signed it


def test_builds_tab(page):
    dom = page("builds")
    assert "Production" in dom and "Sensor sampling period" in dom
    assert "Set up this computer" in dom
    assert "Create my signing key" in dom and "Set my PSKd" in dom   # the fix buttons
    assert "SWD flashing tools" in dom and "J-Link software" in dom   # the optional checks
    assert "Flash a board over SWD" in dom and "Needs " in dom       # nothing to flash yet


def test_settings_tab(page):
    dom = page("settings")
    assert "Remove the simulated boards" in dom
    assert "Data folder" in dom and "Border router REST API" in dom
    assert "Check GitHub for app updates" in dom and "Download a problem report" in dom
    assert "Keep readings (days)" in dom and "home_assistant_url" not in dom          # its own card
    assert "Running in the background" in dom and "Home Assistant history" in dom
    assert "readings," in dom                                                         # space used


def test_dark_by_default(page):
    dom = page("devices")
    assert 'data-theme="tokyo-night"' in dom and 'data-bs-theme="dark"' in dom
    assert "1/1 online" in dom  # the status bar


def test_dashboard_tab(page):
    dom = page("dashboard")
    assert re.search(r'id="dash-restarts".*basil.*1×.*\(1 bad\)', dom)        # restarts this week
    assert "behind the release" in dom and "low battery" in dom      # the tiles
    assert "★ release" in dom or "Release:" in dom
    assert "basil needs water" in dom                                 # the alert
    assert "Run the pump" in dom                                      # the needs-water list
    assert "basil" in dom                                             # under batteries
    assert "Battery drain by firmware" in dom
    assert "Wall display" in dom and "Weekly summary" in dom and "Getting started" in dom


def test_device_page(page):
    dom = page("device/1a2b3c4d")
    assert "Last seen" in dom and "-5 °C" in dom
    assert "Run the pump" in dom                                      # the controls
    assert "Add a photo" in dom and "it needs water" in dom
    assert "plant-photo" not in dom                                   # one photo: the one at the top
    assert "</div>null" not in dom                                    # nothing missing printed as "null"
    assert "Soil moisture" in dom and "<svg" in dom                   # the charts
    assert "chart-event event-pump" in dom                            # a pump run marked on them
    assert "Battery drain by firmware" in dom                         # its drain (48 h of readings)
    assert "Updated and confirmed" in dom                             # its update history
    assert "the watchdog: it stopped responding" in dom and "0x6800 · -64 dBm" in dom   # its health
    assert "chart-event event-restart" in dom                         # the restart on the charts
    assert "Read from the board" in dom                               # its settings


def test_floorplan_view(page):
    dom = page("network/floorplan")
    assert "/api/network/floorplan" in dom and "plan-dim" in dom
    assert 'class="pin"' in dom and "place-chip" in dom                # basil on the plan, the others to place
    assert 'class="plan' in dom and 'data-node=' in dom                 # the placed node, ready for the highlight
    assert "basil" in dom


def test_console_tab(page):
    dom = page("console")
    assert 'id="console-port"><option' in dom                         # the ports were listed
    assert 'id="console-from-air"' in dom
    dom = page("console/1a2b3c4d")                                    # a board's log, from its page
    assert re.search(r'<button type="button" id="console-from-air"[^>]*class="active"', dom)
    assert '<option value="1a2b3c4d">basil' in dom


def test_wall_display(page):
    dom = page("wall")
    assert "wall-card" in dom and "basil" in dom and "needs water" in dom
    assert 'class="wall-mode' in dom or "wall-mode" in dom          # the header and status bar hidden


def test_weekly_summary(page):
    dom = page("summary")
    assert "ha-coap fleet summary" in dom and "basil" in dom and "Batteries" in dom
