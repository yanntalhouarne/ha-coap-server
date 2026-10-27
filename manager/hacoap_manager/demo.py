"""The demo: the fleet manager with simulated boards and a simulated border router, in its own
throwaway data folder, to try every page without boards. It runs as a second copy of the app
(Settings → Start the demo, or --demo), so it never touches your own data, and its data folder
is deleted when it stops.

The simulated boards answer on 127.0.0.1 to 127.0.0.9 like the simulator, but on other ports
(CoAP 15683, mcumgr 11337), so a simulator already running doesn't get in the way. They aren't
announced over mDNS, so your own app never finds them. On macOS, where only 127.0.0.1 exists
until more loopback addresses are added, the demo has one board.

Each board follows a small model: the soil dries at the plant's own rate until it's watered
(Run the pump really waters it), and the battery drains faster under the older firmware than
after the update a week ago. Two weeks of that are filled in at the start, so the charts, the
forecasts and the battery drain table have something to show.
"""

import asyncio
import json
import math
import socket
import subprocess
import sys
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from . import config, mcuboot, simdevice
from .discovery import Found
from .simborder import SimulatedBorderRouter, scenario

COAP_PORT, SMP_PORT = 15683, 11337
DAY = 86400
HISTORY_DAYS = 14
UPDATED_DAYS_AGO = 7
# name, plant, location, watering target (%), soil drying (% per day)
PLANTS = [("basil", "basil", "kitchen", 40, 7.0), ("chili", "chili pepper", "balcony", 35, 5.0),
          ("fern", "boston fern", "bathroom", 50, 6.0), ("lemon tree", "lemon tree", "living room", 30, 3.5),
          ("mint", "mint", "kitchen", 45, 8.0), ("monstera", "monstera", "bedroom", 30, 4.0),
          ("orchid", "orchid", "living room", 25, 2.5), ("rosemary", "rosemary", "balcony", 20, 3.0),
          ("tomatoes", "tomatoes", "balcony", 40, 9.0)]
WET = 72   # soil moisture % right after watering


class PlantModel:
    """A board's readings over time: soil drying since its last watering, a battery draining
    (faster before its update), humidity and temperature following the day."""

    def __init__(self, index, start, updated_at):
        self.index = index
        _, _, _, self.target, self.dry_per_day = PLANTS[index % len(PLANTS)]
        self.start = start
        self.updated_at = updated_at          # None: never updated (the older image)
        self.battery_start = 96 - index * 4
        # Waterings in the filled-in history: each time the soil reaches 2 % under the target,
        # starting at a different point of the cycle for each plant.
        cycle = (WET - (self.target - 2)) / self.dry_per_day * DAY
        self.waterings = []
        t = start - cycle * ((index * 0.37) % 1)
        while t < time.time():
            self.waterings.append(t)
            t += cycle

    def water(self, when):
        self.waterings.append(when)

    def soil(self, t):
        last = max((w for w in self.waterings if w <= t), default=self.start)
        return max(5, round(WET - self.dry_per_day * (t - last) / DAY))

    def battery(self, t):
        days = (t - self.start) / DAY
        if self.updated_at is None:
            return max(3, round(self.battery_start - 1.4 * days))
        before = min(t, self.updated_at) - self.start
        after = max(0.0, t - self.updated_at)
        return max(3, round(self.battery_start - 1.4 * before / DAY - 0.6 * after / DAY))

    def reading(self, t):
        day = (t / DAY) % 1
        humidity = round(55 + 8 * math.sin(2 * math.pi * day + self.index))
        temperature = round(20 + 4 * math.sin(2 * math.pi * (day - 0.375)) + self.index % 3)
        return self.soil(t), self.battery(t), humidity, temperature


@dataclass
class DemoDevice(simdevice.SimulatedDevice):
    model: PlantModel = None
    _was_pumping: bool = False

    def readings(self):
        now = time.time()
        if self.pump_running and not self._was_pumping:
            self.model.water(now)              # Run the pump waters the plant
        self._was_pumping = self.pump_running
        soil, battery, humidity, temperature = self.model.reading(now)
        return bytes([soil, battery, humidity, temperature & 0xFF])


class Demo:
    def __init__(self, services, count=len(PLANTS), coap_port=COAP_PORT, smp_port=SMP_PORT):
        self.services = services
        self.count = count
        self.ports = (smp_port, coap_port)
        self.servers = []
        self.border = None

    async def start(self):
        s = self.services
        now = time.time()
        start = now - HISTORY_DAYS * DAY
        current = mcuboot.build_image(b"demo firmware" * 100, (1, 0, 0, 0))
        older = mcuboot.build_image(b"demo firmware, older" * 100, (0, 9, 0, 0))
        for i, (host, plain) in enumerate(simdevice.fleet(self.count)):
            older_image = i % 5 == 3
            model = PlantModel(i, start, None if older_image else now - UPDATED_DAYS_AGO * DAY)
            device = DemoDevice.with_image(older if older_image else current, device_id=plain.device_id, model=model)
            if not self.servers:
                # The first board picks the ports, the next pair along if they're taken (another
                # demo running); the others use the same.
                for attempt in range(10):
                    ports = tuple(p + 10 * attempt if p else 0 for p in self.ports)
                    try:
                        self.servers.append(await simdevice.SimulatorServer(device, host, *ports).start())
                        self.ports = ports
                        break
                    except OSError:
                        if attempt == 9 or not any(self.ports):
                            raise
                continue
            try:
                self.servers.append(await simdevice.SimulatorServer(device, host, *self.ports).start())
            except OSError:
                break   # macOS without extra loopback addresses: fewer boards
        self.border = SimulatedBorderRouter("api", "127.0.0.1", 0, scenario([sv.host for sv in self.servers])).start()

        first = self.servers[0]  # the ports the boards got (the same for all, unless 0 for tests)
        s.settings.update({"coap_port": first.coap_port, "smp_port": first.smp_port, "border_router_url": self.border.url,
                           "coap_timeout_s": 1.0, "mcumgr_timeout_s": 3.0, "reboot_timeout_s": 30.0,
                           "auto_refresh_minutes": 5, "discovery_timeout_s": 1.0})
        config.save_settings(s.data_dir, s.settings)
        found = [Found(f"ha-coap-{sv.device.device_id}", sv.device.device_id, sv.host) for sv in self.servers]

        async def discover(timeout):   # Find devices finds the demo's boards (no mDNS)
            return found

        s.inventory._discover = discover
        s.doctor._discover = discover

        release = s.images.add(current, "app_update.bin", "Demo firmware 1.0.0: the release")
        s.images.add(older, "app_update.bin", "Demo firmware 0.9.0: the one before")
        s.db.set_release(release["hash"])
        for i, server in enumerate(self.servers):
            name, plant, location, target, _ = PLANTS[i % len(PLANTS)]
            device_id = server.device.device_id
            await s.inventory.add_by_address(server.host)
            s.db.upsert_device(device_id, name=name, plant=plant, location=location, water_below=target,
                               tags="herbs" if plant in ("basil", "mint", "rosemary") else "")
            self._fill_history(device_id, server.device.model, current, now)
        await s.inventory.read_all_slots()
        for _ in range(2):                      # two network readings: the history slider shows
            await s.network.refresh()
        s.alerts.scan()
        s.events.publish("devices")

    def _fill_history(self, device_id, model, current, now):
        db = self.services.db
        rows = []
        t = model.start
        while t < now - 600:
            rows.append((device_id, t, *self._reading(model, t)))
            t += 1800
        db.add_readings(rows)
        for i, watered in enumerate(model.waterings):
            if model.start <= watered < now and i % 2 == 0:   # half from the app, half by hand
                db.add_activity(device_id, "pump", "Pump started from the app (3 s)", when=watered)
        if model.updated_at is not None:
            info = mcuboot.parse_image(current)
            db.add_update("demo", device_id, "udp", info.hash, info.mcumgr_version, model.updated_at - 240,
                          model.updated_at, "updated", "Updated and confirmed")

    @staticmethod
    def _reading(model, t):
        soil, battery, humidity, temperature = model.reading(t)
        return battery, soil, humidity, temperature

    async def stop(self):
        if self.border is not None:
            self.border.stop()
        for server in self.servers:
            await server.stop()


# ---------------------------------------------------------------- starting it from the app

def _free_port():
    for port in DEMO_PORTS:
        with socket.socket() as sock:
            try:
                sock.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise OSError("no free port for the demo")


def command(port):
    """Starts this app (packaged, or the source) as the demo, in the background."""
    if getattr(sys, "frozen", False):
        args = [sys.executable]
    else:
        python = Path(sys.executable)
        windowless = python.with_name("pythonw.exe")
        args = [str(windowless if sys.platform == "win32" and windowless.exists() else python),
                str(Path(__file__).resolve().parent.parent / "run_manager.py")]
    return args + ["--demo", "--background", "--port", str(port)]


DEMO_PORTS = range(8790, 8810)


def running():
    """The address of a demo already running on this computer, or None."""
    for port in DEMO_PORTS:
        url = f"http://127.0.0.1:{port}/"
        try:
            with urllib.request.urlopen(url + "api/status", timeout=0.3) as response:
                if json.loads(response.read()).get("demo"):
                    return url
        except (OSError, ValueError):
            continue
    return None


def launch(timeout_s=90.0):
    """Starts the demo (or finds the one running) and waits until it answers. Returns its address."""
    already = running()
    if already:
        return already
    port = _free_port()
    flags = {"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {"start_new_session": True}
    process = subprocess.Popen(command(port), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, **flags)
    url = f"http://127.0.0.1:{port}/"
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if process.poll() is not None:
            raise OSError(f"the demo stopped at start (exit code {process.returncode})")
        try:
            with urllib.request.urlopen(url + "api/status", timeout=2) as response:
                if json.loads(response.read()).get("demo"):
                    return url
        except (OSError, ValueError):
            pass
        time.sleep(0.5)
    process.kill()
    raise OSError("the demo didn't start in time")


async def launch_async():
    return await asyncio.to_thread(launch)
