"""The web server: the API under /api, the live event WebSocket, and the page itself.

It only listens on this computer (127.0.0.1). Two checks keep other websites open in the
same browser from using it: the Host header must name this computer (against DNS
rebinding), and every change must carry an 'X-HACoap: 1' header, which a page from
another site can't add without the server's permission (against cross-site requests).
"""

import asyncio
import contextlib
import logging
import time
from dataclasses import dataclass
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

import re

from . import __version__, backup, config, discovery, fleet, kconfig, mcuboot, serial_ports
from .builds import VARIANTS, BuildError, BuildRunner
from .console import ConsoleError, SerialConsole
from .db import Database
from .events import EventBus
from .images import ImageLibrary, build_commit, build_images, changes, find_repository
from .inventory import Inventory, InventoryError
from .network import NetworkError, NetworkService
from .setup_tools import SetupError, SetupRunner
from .updates import UpdateError, UpdateManager

log = logging.getLogger(__name__)

STATIC = Path(__file__).parent / "static"
LOCAL_HOSTS = {"127.0.0.1", "localhost", "[::1]"}
CHANGE_HEADER = "x-hacoap"


@dataclass
class Services:
    data_dir: Path
    settings: config.Settings
    db: Database
    events: EventBus
    inventory: Inventory
    images: ImageLibrary
    updates: UpdateManager
    repository: Path
    builds: BuildRunner
    network: NetworkService
    console: SerialConsole
    setup: SetupRunner


def create_services(data_dir, discover=discovery.discover):
    data_dir = Path(data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    settings = config.load_settings(data_dir)
    db = Database(data_dir / "manager.db")
    events = EventBus()
    inventory = Inventory(db, settings, events, discover)
    images = ImageLibrary(data_dir, db)
    updates = UpdateManager(db, images, inventory, settings, events)
    repository = find_repository()
    builds = BuildRunner(repository, data_dir, db, images, events)
    db.interrupted_builds()
    if not db.profiles():
        db.save_profile("Production", "battery", {}, "The firmware as configured in the repository")
    network = NetworkService(data_dir, db, settings, events)
    setup = SetupRunner(repository, events)
    builds.other_busy = setup.busy                                                 # one script at a time
    setup.other_busy = lambda: "build" if builds.running() else None
    return Services(data_dir, settings, db, events, inventory, images, updates, repository, builds, network,
                    SerialConsole(events), setup)


def _host_name(host_header):
    if host_header.startswith("["):
        return host_header[: host_header.find("]") + 1]
    return host_header.rsplit(":", 1)[0]


def _bad_request(exc):
    return HTTPException(status_code=400, detail=str(exc))


def create_app(services, background_tasks=True):
    @contextlib.asynccontextmanager
    async def lifespan(app):
        tasks = []
        if background_tasks:
            tasks = [asyncio.create_task(_auto_refresh(services)), asyncio.create_task(_auto_backup(services))]
        yield
        for task in tasks:
            task.cancel()
        services.db.close()

    app = FastAPI(title="HA-CoAP Fleet Manager", version=__version__, lifespan=lifespan,
                  docs_url=None, redoc_url=None, openapi_url=None)
    s = services

    @app.middleware("http")
    async def local_only(request: Request, call_next):
        if _host_name(request.headers.get("host", "")) not in LOCAL_HOSTS:
            return JSONResponse({"detail": "This app only answers on this computer (127.0.0.1)"}, status_code=403)
        if request.method not in ("GET", "HEAD") and request.headers.get(CHANGE_HEADER) != "1":
            return JSONResponse({"detail": f"Missing {CHANGE_HEADER} header"}, status_code=403)
        return await call_next(request)

    # ------------------------------------------------------------ status and settings

    @app.get("/api/status")
    async def status():
        return {
            "version": __version__,
            "data_dir": str(s.data_dir),
            "repository": str(s.repository) if s.repository else None,
            "discovery_available": discovery.discovery_available(),
            "update_running": s.updates.running_job() is not None,
            "settings": s.settings.as_dict(),
        }

    @app.put("/api/settings")
    async def put_settings(values: dict):
        try:
            s.settings.update(values)
        except (TypeError, ValueError) as exc:
            raise _bad_request(exc)
        config.save_settings(s.data_dir, s.settings)
        return s.settings.as_dict()

    # ------------------------------------------------------------ devices

    @app.get("/api/devices")
    async def devices():
        return s.inventory.devices()

    @app.post("/api/devices")
    async def add_device(body: dict):
        address = str(body.get("address", "")).strip()
        if not address:
            raise _bad_request("An address is needed")
        try:
            return s.inventory.describe(await s.inventory.add_by_address(address))
        except InventoryError as exc:
            raise _bad_request(exc)

    @app.patch("/api/devices/{device_id}")
    async def edit_device(device_id: str, body: dict):
        if s.db.device(device_id) is None:
            raise HTTPException(404, "Unknown device")
        fields = {k: str(v).strip() for k, v in body.items() if k in ("name", "notes", "address", "location", "plant")}
        if "tags" in body:
            tags = body["tags"] if isinstance(body["tags"], list) else str(body["tags"]).split(",")
            fields["tags"] = ",".join(sorted({t.strip().lower() for t in tags if t.strip()}))
        device = s.db.upsert_device(device_id, **fields)
        s.events.publish("device", device=s.inventory.describe(device))
        return s.inventory.describe(device)

    @app.delete("/api/devices/{device_id}")
    async def delete_device(device_id: str):
        if not s.db.delete_device(device_id):
            raise HTTPException(404, "Unknown device")
        s.events.publish("devices")
        return {"deleted": device_id}

    @app.post("/api/discover")
    async def discover():
        if not discovery.discovery_available():
            raise _bad_request("Discovery needs the zeroconf package")
        found = await s.inventory.discover()
        s.events.publish("devices")
        return {"found": found}

    @app.post("/api/devices/{device_id}/refresh")
    async def refresh(device_id: str):
        try:
            return s.inventory.describe(await s.inventory.refresh(device_id))
        except InventoryError as exc:
            raise _bad_request(exc)

    @app.post("/api/refresh")
    async def refresh_all():
        return await s.inventory.refresh_all()

    @app.post("/api/devices/{device_id}/slots")
    async def slots(device_id: str, body: dict = None):
        body = body or {}
        try:
            return await s.inventory.read_slots(device_id, body.get("transport", "udp"), body.get("serial_port", ""))
        except InventoryError as exc:
            raise _bad_request(exc)

    @app.get("/api/devices/{device_id}/details")
    async def device_details(device_id: str, days: int = 30):
        device = s.db.device(device_id)
        if device is None:
            raise HTTPException(404, "Unknown device")
        since = time.time() - max(1, min(days, 365)) * 86400
        return {"device": s.inventory.describe(device),
                "health": fleet.device_health(s.db, device, s.db.release_image()),
                "readings": s.db.readings(device_id, since), "links": s.db.link_samples(device_id, since),
                "updates": s.db.updates(device_id, limit=50), "network_events": s.db.network_events_for(device_id)}

    @app.post("/api/devices/{device_id}/pump")
    async def pump(device_id: str, body: dict):
        on = body.get("on")
        try:
            return await s.inventory.pump(device_id, on=None if on is None else bool(on), seconds=body.get("seconds"))
        except InventoryError as exc:
            raise _bad_request(exc)

    @app.post("/api/slots/read-all")
    async def read_all_slots():
        return await s.inventory.read_all_slots()

    @app.get("/api/dashboard")
    async def dashboard():
        return fleet.dashboard(s.db, s.inventory, s.network.last())

    @app.post("/api/devices/{device_id}/ping")
    async def ping(device_id: str):
        try:
            await s.inventory.ping(device_id)
        except InventoryError as exc:
            raise _bad_request(exc)
        return {"ok": True}

    @app.get("/api/serial-ports")
    async def ports():
        try:
            return serial_ports.list_ports()
        except ImportError:
            return []

    # ------------------------------------------------------------ images

    @app.get("/api/images")
    async def images():
        return s.db.images()

    @app.post("/api/images")
    async def add_image(request: Request, filename: str = "app_update.bin", notes: str = ""):
        data = await request.body()
        try:
            return s.images.add(data, filename, notes)
        except mcuboot.ImageError as exc:
            raise _bad_request(exc)

    @app.get("/api/build-outputs")
    async def build_outputs():
        """Images built in this checkout (application/build*/zephyr/app_update.bin)."""
        result = []
        for variant, path in build_images(s.repository):
            try:
                info = mcuboot.parse_image(path.read_bytes())
            except (OSError, mcuboot.ImageError):
                continue
            result.append({"variant": variant, "path": str(path), "hash": info.hash, "version": info.mcumgr_version,
                           "size": info.size, "modified": path.stat().st_mtime,
                           "git_commit": build_commit(path.parent.parent),
                           "in_library": s.db.image(info.hash) is not None})
        return result

    @app.post("/api/build-outputs/{variant}/import")
    async def import_build(variant: str):
        for name, path in build_images(s.repository):
            if name == variant:
                try:
                    return s.images.add(path.read_bytes(), path.name,
                                        f"{variant} build, {time.strftime('%Y-%m-%d %H:%M', time.localtime(path.stat().st_mtime))}",
                                        build_commit(path.parent.parent))
                except (OSError, mcuboot.ImageError) as exc:
                    raise _bad_request(exc)
        raise HTTPException(404, "No such build")

    @app.patch("/api/images/{image_hash}")
    async def edit_image(image_hash: str, body: dict):
        image = s.db.image(image_hash)
        if image is None:
            raise HTTPException(404, "Unknown image")
        return s.db.add_image(image_hash, image["version"], image["filename"], image["size"],
                              str(body.get("notes", image["notes"])))

    @app.post("/api/release")
    async def set_release(body: dict):
        """Marks the image the fleet should run, or none (image_hash null)."""
        image_hash = body.get("image_hash")
        if image_hash and s.db.image(image_hash) is None:
            raise HTTPException(404, "Unknown image")
        s.db.set_release(image_hash)
        s.events.publish("devices")
        return {"release": s.db.release_image()}

    @app.get("/api/images/{image_hash}/changes")
    async def image_changes(image_hash: str, device_id: str):
        image, device = s.db.image(image_hash), s.db.device(device_id)
        if image is None or device is None:
            raise HTTPException(404, "Unknown image or device")
        try:
            result = await asyncio.to_thread(changes, s.repository, device["fw_version"], image["git_commit"])
        except ValueError as exc:
            raise _bad_request(exc)
        return {"from": device["fw_version"], "to": image["git_commit"], **result}

    @app.delete("/api/images/{image_hash}")
    async def delete_image(image_hash: str):
        if not s.images.delete(image_hash):
            raise HTTPException(404, "Unknown image")
        return {"deleted": image_hash}

    # ------------------------------------------------------------ build profiles and builds

    @app.get("/api/kconfig")
    async def kconfig_schema():
        try:
            return {"schema": s.builds.schema(), "variants": list(VARIANTS)}
        except OSError as exc:
            raise _bad_request(exc)

    @app.get("/api/profiles")
    async def profiles():
        return s.db.profiles()

    @app.put("/api/profiles/{name}")
    async def save_profile(name: str, body: dict):
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}", name):
            raise _bad_request("A profile name has 1 to 40 letters, digits, spaces, dots, dashes or underscores")
        variant = body.get("variant", "battery")
        if variant not in VARIANTS:
            raise _bad_request(f"Unknown variant {variant}")
        try:
            settings = kconfig.validate(s.builds.schema(), dict(body.get("settings", {})))
        except kconfig.KconfigError as exc:
            raise _bad_request(exc)
        return s.db.save_profile(name, variant, settings, str(body.get("notes", "")))

    @app.delete("/api/profiles/{name}")
    async def delete_profile(name: str):
        if not s.db.delete_profile(name):
            raise HTTPException(404, "Unknown profile")
        return {"deleted": name}

    @app.get("/api/build-checks")
    async def build_checks():
        return s.builds.checks()

    @app.get("/api/firmware-builds")
    async def firmware_builds():
        return s.db.builds()

    @app.get("/api/firmware-builds/{build_id}")
    async def firmware_build(build_id: int):
        if s.builds.running() and s.builds.current["id"] == build_id:
            return {**s.builds.current, "log": "\n".join(s.builds.log)}
        build = s.db.build(build_id, with_log=True)
        if build is None:
            raise HTTPException(404, "Unknown build")
        return build

    @app.post("/api/firmware-builds")
    async def start_build(body: dict):
        try:
            return s.builds.start(str(body.get("profile", "")), bool(body.get("allow_development_key", False)))
        except (BuildError, kconfig.KconfigError, OSError) as exc:
            raise _bad_request(exc)

    @app.post("/api/firmware-builds/cancel")
    async def cancel_build():
        try:
            s.builds.cancel()
        except BuildError as exc:
            raise _bad_request(exc)
        return {"cancelling": True}

    # ------------------------------------------------------------ updates

    @app.post("/api/updates")
    async def start_update(body: dict):
        try:
            job = s.updates.start(str(body.get("image_hash", "")), list(body.get("targets", [])),
                                  bool(body.get("stop_on_failure", True)), bool(body.get("staged", False)), s.console)
        except UpdateError as exc:
            raise _bad_request(exc)
        return job.as_dict()

    @app.get("/api/updates")
    async def jobs():
        return [job.as_dict() for job in sorted(s.updates.jobs.values(), key=lambda j: j.created, reverse=True)]

    @app.get("/api/updates/{job_id}")
    async def job(job_id: str):
        if job_id not in s.updates.jobs:
            raise HTTPException(404, "Unknown job")
        return s.updates.jobs[job_id].as_dict()

    @app.post("/api/updates/{job_id}/continue")
    async def continue_update(job_id: str):
        try:
            return s.updates.resume(job_id).as_dict()
        except UpdateError as exc:
            raise _bad_request(exc)

    @app.post("/api/updates/{job_id}/cancel")
    async def cancel(job_id: str):
        try:
            return s.updates.cancel(job_id).as_dict()
        except UpdateError as exc:
            raise HTTPException(404, str(exc))

    @app.get("/api/history")
    async def history(device_id: str = None):
        return s.db.updates(device_id)

    # ------------------------------------------------------------ the Thread network

    @app.get("/api/network")
    async def network():
        return s.network.state()

    @app.post("/api/network/refresh")
    async def refresh_network():
        try:
            return await s.network.refresh()
        except NetworkError as exc:
            raise _bad_request(exc)

    @app.post("/api/network/channel-scan")
    async def channel_scan():
        try:
            return await s.network.channel_scan()
        except NetworkError as exc:
            raise _bad_request(exc)

    @app.get("/api/network/floorplan")
    async def floorplan():
        info = s.network.floorplan_info()
        if info is None:
            raise HTTPException(404, "No floor plan")
        return FileResponse(s.network.floorplan_file, media_type=info["content_type"],
                            headers={"Cache-Control": "no-cache"})

    @app.post("/api/network/floorplan")
    async def set_floorplan(request: Request, name: str = ""):
        try:
            return s.network.set_floorplan(await request.body(), name)
        except NetworkError as exc:
            raise _bad_request(exc)

    @app.delete("/api/network/floorplan")
    async def remove_floorplan():
        s.network.remove_floorplan()
        return {"removed": True}

    @app.put("/api/network/positions/{node_key}")
    async def set_position(node_key: str, body: dict):
        try:
            x, y = body.get("x"), body.get("y")
            s.network.set_position(node_key, None if x is None else float(x), None if y is None else float(y))
        except (NetworkError, TypeError, ValueError) as exc:
            raise _bad_request(exc)
        return {"node_key": node_key, "x": x, "y": y}

    @app.post("/api/network/find-border-router")
    async def find_border_router():
        if not discovery.discovery_available():
            raise _bad_request("Finding the border router needs the zeroconf package")
        urls = await s.network.find_border_router(s.settings.discovery_timeout_s)
        if urls and not s.settings.border_router_url:
            s.settings.border_router_url = urls[0]
            config.save_settings(s.data_dir, s.settings)
        return {"found": urls, "border_router_url": s.settings.border_router_url}

    # ------------------------------------------------------------ serial console

    @app.get("/api/console")
    async def console_state():
        return s.console.state()

    @app.post("/api/console/open")
    async def console_open(body: dict):
        job = s.updates.running_job()
        port = str(body.get("port", ""))
        if job and any(t.transport == "serial" and t.address == port for t in job.targets):
            raise _bad_request(f"An update is using {port}")
        try:
            s.console.open(asyncio.get_running_loop(), port, int(body.get("baudrate", 115200)))
        except (ConsoleError, ValueError, ImportError) as exc:
            raise _bad_request(exc)
        return s.console.state()

    @app.post("/api/console/close")
    async def console_close():
        s.console.close()
        return s.console.state()

    @app.post("/api/console/send")
    async def console_send(body: dict):
        try:
            s.console.send(str(body.get("text", "")))
        except ConsoleError as exc:
            raise _bad_request(exc)
        return {"sent": True}

    # ------------------------------------------------------------ setting up this PC to build

    @app.get("/api/setup")
    async def setup_state():
        return {**s.setup.state(), "checks": s.builds.checks()}

    @app.post("/api/setup/pskd")
    async def setup_pskd(body: dict = None):
        try:
            pskd = s.setup.set_pskd((body or {}).get("pskd") or None)
        except SetupError as exc:
            raise _bad_request(exc)
        return {"pskd": pskd, "checks": s.builds.checks()}

    @app.post("/api/setup/cancel")
    async def setup_cancel():
        try:
            s.setup.cancel()
        except SetupError as exc:
            raise _bad_request(exc)
        return {"cancelling": True}

    @app.post("/api/setup/{task}")
    async def setup_start(task: str):
        try:
            return s.setup.start(task)
        except SetupError as exc:
            raise _bad_request(exc)

    # ------------------------------------------------------------ backups and export

    def _busy():
        if s.updates.running_job() is not None or s.builds.running():
            raise _bad_request("Wait for the update or build in progress to finish")

    @app.get("/api/backup")
    async def download_backup():
        data = await asyncio.to_thread(backup.create_backup, s.data_dir, s.db, s.settings)
        name = f"hacoap-manager-backup-{time.strftime('%Y%m%d-%H%M')}.zip"
        return Response(data, media_type="application/zip",
                        headers={"Content-Disposition": f'attachment; filename="{name}"'})

    @app.get("/api/backups")
    async def saved_backups():
        return backup.list_backups(s.data_dir)

    @app.get("/api/backups/{name}")
    async def saved_backup(name: str):
        path = backup.backup_path(s.data_dir, name)
        if path is None:
            raise HTTPException(404, "Unknown backup")
        return FileResponse(path, media_type="application/zip", filename=path.name)

    @app.post("/api/restore")
    async def restore(request: Request):
        _busy()
        data = await request.body()
        try:
            result = await asyncio.to_thread(backup.restore_backup, data, s.data_dir, s.db, s.settings)
        except backup.BackupError as exc:
            raise _bad_request(exc)
        s.events.publish("devices")
        return result

    @app.get("/api/devices.csv")
    async def devices_csv():
        name = f"hacoap-devices-{time.strftime('%Y%m%d')}.csv"
        return Response(backup.devices_csv(s.db), media_type="text/csv",
                        headers={"Content-Disposition": f'attachment; filename="{name}"'})

    @app.post("/api/devices/import")
    async def import_devices(request: Request):
        try:
            result = backup.import_devices_csv((await request.body()).decode("utf-8", errors="replace"), s.db)
        except backup.BackupError as exc:
            raise _bad_request(exc)
        s.events.publish("devices")
        return result

    # ------------------------------------------------------------ live events

    @app.websocket("/api/events")
    async def events(websocket: WebSocket):
        origin = websocket.headers.get("origin", "")
        host = websocket.headers.get("host", "")
        if _host_name(host) not in LOCAL_HOSTS or (origin and origin.split("//", 1)[-1] != host):
            await websocket.close(code=1008)
            return
        await websocket.accept()
        with s.events.subscribe() as queue:
            try:
                while True:
                    await websocket.send_json(await queue.get())
            except (WebSocketDisconnect, RuntimeError):
                pass

    # ------------------------------------------------------------ the page

    @app.get("/")
    async def index():
        return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})

    app.mount("/static", StaticFiles(directory=STATIC), name="static")
    return app


async def _auto_refresh(services):
    """Refreshes every device's status now and then while the app runs."""
    while True:
        minutes = services.settings.auto_refresh_minutes
        await asyncio.sleep(max(minutes, 1) * 60)
        if minutes > 0 and services.updates.running_job() is None:
            try:
                await services.inventory.refresh_all()
            except Exception:  # noqa: BLE001 - try again next time
                log.exception("automatic refresh")


async def _auto_backup(services):
    """A backup a day in the data folder's backups/, while the app runs."""
    while True:
        try:
            await asyncio.to_thread(backup.auto_backup, services.data_dir, services.db, services.settings)
        except Exception:  # noqa: BLE001 - try again later
            log.exception("automatic backup")
        await asyncio.sleep(6 * 3600)
