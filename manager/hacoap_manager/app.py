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
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

import re

from . import __version__, config, discovery, kconfig, mcuboot, serial_ports
from .builds import VARIANTS, BuildError, BuildRunner
from .db import Database
from .events import EventBus
from .images import ImageLibrary, build_images, find_repository
from .inventory import Inventory, InventoryError
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
    return Services(data_dir, settings, db, events, inventory, images, updates, repository, builds)


def _host_name(host_header):
    if host_header.startswith("["):
        return host_header[: host_header.find("]") + 1]
    return host_header.rsplit(":", 1)[0]


def _bad_request(exc):
    return HTTPException(status_code=400, detail=str(exc))


def create_app(services, auto_refresh=True):
    @contextlib.asynccontextmanager
    async def lifespan(app):
        task = asyncio.create_task(_auto_refresh(services)) if auto_refresh else None
        yield
        if task is not None:
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
        fields = {k: str(v) for k, v in body.items() if k in ("name", "notes", "address")}
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
                           "in_library": s.db.image(info.hash) is not None})
        return result

    @app.post("/api/build-outputs/{variant}/import")
    async def import_build(variant: str):
        for name, path in build_images(s.repository):
            if name == variant:
                try:
                    return s.images.add(path.read_bytes(), path.name,
                                        f"{variant} build, {time.strftime('%Y-%m-%d %H:%M', time.localtime(path.stat().st_mtime))}")
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
                                  bool(body.get("stop_on_failure", True)))
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

    @app.post("/api/updates/{job_id}/cancel")
    async def cancel(job_id: str):
        try:
            return s.updates.cancel(job_id).as_dict()
        except UpdateError as exc:
            raise HTTPException(404, str(exc))

    @app.get("/api/history")
    async def history(device_id: str = None):
        return s.db.updates(device_id)

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
