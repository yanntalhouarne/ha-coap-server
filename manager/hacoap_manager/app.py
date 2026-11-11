"""The web server: the API under /api, the live event WebSocket, and the page itself.

It listens on this computer (127.0.0.1), and also on its addresses in the networks chosen
for other devices when that's on (remote.py): those must sign in first. Two checks keep
other websites open in the same browser from using it: the Host header must name this
computer (against DNS rebinding), and every change must carry an 'X-HACoap: 1' header,
which a page from another site can't add without the server's permission (against
cross-site requests).
"""

import asyncio
import contextlib
import hashlib
import ipaddress
import json
import logging
import time
from dataclasses import dataclass
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

import re

from . import (__version__, autostart, backup, coap, config, demo, discovery, feed, fleet, homeassistant, housekeeping,
               kconfig, mcuboot, naming, otctl, remote, report, serial_ports, signing, summary, swd)
from .alerts import AlertService
from .autowater import AutoWatering, RuleError, checked_rule, rule_of
from .autowater import watch as autowater_watch
from .appupdate import UpdateCheck
from .borderrouter import BorderRouterService, BorderRouterSetupError
from .builds import VARIANTS, BuildError, BuildRunner
from .console import ConsoleError, SerialConsole
from .db import Database, current_actor
from .doctor import Doctor
from .events import EventBus
from .images import ImageLibrary, build_commit, build_images, changes, find_repository
from .inventory import Inventory, InventoryError
from .network import NetworkError, NetworkService
from .pictures import PhotoStore, PictureError
from .setup_tools import SetupError, SetupRunner
from .updates import UpdateError, UpdateManager

log = logging.getLogger(__name__)

STATIC = Path(__file__).parent / "static"
LOCAL_HOSTS = {"127.0.0.1", "localhost", "[::1]"}
CHANGE_HEADER = "x-hacoap"
SIGNED_OUT_PATHS = ("/login", "/api/login", "/static/", "/v/")  # the sign-in page and what it loads
# What a revoked dashboard link shows instead of the password page (inside a dashboard, no one would sign in there)
LINK_REVOKED_PAGE = ("<!doctype html><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\">"
                     "<title>HA-CoAP</title><body style=\"font-family:sans-serif;padding:1.5rem;color:#888\">"
                     "<p>This dashboard link doesn't work any more: it was revoked, or the app doesn't accept other "
                     "devices now. Make a new one in the app's Settings, Other devices.</p></body>")
# Never from another device: turning other devices on or off, their networks and the password
# (the rest of Other devices takes the password again, from a signed-in device), and quitting
LOCAL_ONLY = [(("PUT",), "/api/remote-access"), (("POST",), "/api/quit")]
CONFIRM_HEADER = "X-HACoap-Password"  # the password typed again, for a change from another device
EVENTS_SESSION_CHECK_S = 15  # how soon a signed-out device's live events stop
DAY_S = 86400


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
    alerts: AlertService
    signing: signing.SigningCheck
    photos: PhotoStore
    app_update: UpdateCheck
    doctor: Doctor
    ha_token: homeassistant.TokenStore
    launch: dict = None   # how this app was started (for starting it with the computer)
    demo: bool = False    # this app is the demo (simulated boards, a throwaway data folder)
    remote: "remote.RemoteAccess" = None  # other devices (off unless chosen)
    border_router: BorderRouterService = None  # the border router in Docker here
    autowater: AutoWatering = None  # the automatic watering rules
    backup_copy: dict = None  # the last copy of a backup to settings.backup_copy_dir: {time, ok, message, name}


def create_services(data_dir, discover=discovery.discover):
    data_dir = Path(data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    report.install()
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
    alerts = AlertService(db, inventory, settings, events)
    updates.on_failure = lambda job, target: alerts.update_failed(job.id, target.device_id, target.label, target.message)
    inventory.on_restart = alerts.restarted
    inventory.on_pushed = lambda device: alerts.scan()  # a plant that needs water, a board unplugged: at once
    border_router = BorderRouterService(data_dir, settings, events)
    border_router.on_board_joined = inventory.discover  # a board that joined over the air: in the list
    return Services(data_dir, settings, db, events, inventory, images, updates, repository, builds, network,
                    SerialConsole(events), setup, alerts, signing.SigningCheck(repository, data_dir),
                    PhotoStore(data_dir), UpdateCheck(), Doctor(db, settings, discover),
                    homeassistant.TokenStore(data_dir), remote=remote.RemoteAccess(data_dir),
                    border_router=border_router, autowater=AutoWatering(db, inventory, events, alerts, updates))


def _host_name(host_header):
    if host_header.startswith("["):
        return host_header[: host_header.find("]") + 1]
    return host_header.rsplit(":", 1)[0]


def _bad_request(exc):
    return HTTPException(status_code=400, detail=str(exc))


def _is_ip(text):
    try:
        ipaddress.ip_address(text)
        return True
    except ValueError:
        return False


def _access(services, client, host_header, cookies, key=None):
    """'local' for this computer (and SSH tunnels to it), 'remote' for a signed-in device on a
    chosen network, 'link' for a dashboard link's key there (the plants only), 'sign-in' for a
    device that isn't signed in yet, or None."""
    host = _host_name(host_header)
    address = client.host if client else ""
    if host in LOCAL_HOSTS and (remote.is_loopback(address) or not _is_ip(address)):  # not an IP: a test client
        return "local"
    access = services.remote
    if access is None or not access.allows(address) or host not in access.addresses():
        return None
    if access.session(cookies.get(remote.COOKIE)):
        return "remote"
    if key and access.link(key, address):
        return "link"
    return "sign-in"


# What each field a device's page changes is called, and its unit, for the activity log
EDITED = {"name": ("name", ""), "plant": ("plant", ""), "location": ("room", ""), "address": ("address", ""),
          "water_below": ("watering target", " %"), "tank_ml": ("tank size", " ml"), "pump_ml_s": ("pump flow", " ml/s"),
          "tags": ("tags", "")}


def described_changes(before, fields):
    """What changed, in words: ["plant “basil” → “Thai basil”", "notes changed", ...]."""
    changes = []
    for field, value in fields.items():
        old = before.get(field)
        if field == "watering":
            old_rule = {k: v for k, v in (json.loads(old) if old else {"on": False}).items() if k not in ("tz", "utc_offset_min")}
            new_rule = {k: v for k, v in json.loads(value).items() if k not in ("tz", "utc_offset_min")}
            if bool(old_rule.get("on")) != bool(new_rule.get("on")):
                changes.append(f"automatic watering {'on' if new_rule.get('on') else 'off'}")
            elif old_rule != new_rule:
                changes.append("automatic watering's limits")
            continue
        if field == "notes":
            if (old or "") != (value or ""):
                changes.append("notes")
            continue
        if field not in EDITED or (old in (None, "") and value in (None, "")) or old == value:
            continue
        label, unit = EDITED[field]
        shown = lambda v: "none" if v in (None, "") else (f"{v:g}{unit}" if isinstance(v, float) else  # noqa: E731
                                                          f"{v}{unit}" if unit else f"“{v}”")
        changes.append(f"{label} {shown(old)} → {shown(value)}")
    return changes


def _actor(services, access, request, link):
    """Who a request comes from, for the activity log: "this computer", a signed-in device's
    browser ("Chrome on Android"), or a dashboard link by its name."""
    if access == "local":
        return "this computer"
    if access == "remote":
        session = services.remote.session(request.cookies.get(remote.COOKIE)) or {}
        return remote.browser_name(session.get("device", ""))
    if access == "link" and link:
        return f"the link “{link['name']}”"
    return ""


# What a dashboard link opens: the page, and the plants (simple view) with watering, beeping and
# naming them; the network map and the charts, to look at. Never updates, builds, settings,
# backups, the border router...
LINK_ALLOWED = [
    (("GET", "HEAD"), re.compile(r"^/$")),
    (("GET", "HEAD"), re.compile(r"^/api/(devices|wall|alerts|status|activity-feed|images|updates|setup|away)$")),
    (("PUT",), re.compile(r"^/api/away$")),  # going away (or back): it only sets the date the plants are checked for
    (("GET", "HEAD"), re.compile(r"^/api/devices/[^/]+/(details|photo)$")),
    # Read-only: the network's map (mesh, tree, floor plan) and its history, and the charts
    (("GET", "HEAD"), re.compile(r"^/api/(network|network/history|network/floorplan|graph|readings\.csv)$")),
    (("GET", "HEAD"), re.compile(r"^/api/network/history/[^/]+$")),
    (("POST",), re.compile(r"^/api/devices/[^/]+/(pump|ping|tank/refilled)$")),
    (("GET", "HEAD"), re.compile(r"^/api/devices/[^/]+/care$")),
    (("POST",), re.compile(r"^/api/care/\d+/done$")),  # a care task done (adding or removing them: the full app)
    (("POST",), re.compile(r"^/api/network/refresh$")),  # reading the network again (it changes nothing)
    (("POST",), re.compile(r"^/api/alerts/(dismiss|\d+/dismiss)$")),
    (("PATCH",), re.compile(r"^/api/devices/[^/]+$")),  # its plant's name only (edit_device)
]
LINK_EVENTS = {"device", "devices", "alert", "alerts", "network"}  # what its page is told live
# What a view-only link may still ask with a POST: it only looks
VIEW_ONLY_POSTS = {"/api/network/refresh"}
LINK_NETWORK_GAP_S = 60  # from a link, a network reading this soon after the last one is that one


def _link_allows(method, path):
    return any(method in methods and pattern.match(path) for methods, pattern in LINK_ALLOWED)


# What a link for the HA CoAP integration opens: the boards' firmware, and updating one of them
# to the release image (never another image, nothing else)
HA_LINK_ALLOWED = [
    (("GET", "HEAD"), re.compile(r"^/api/ha/firmware$")),
    (("POST",), re.compile(r"^/api/ha/update$")),
]


def _ha_link_allows(method, path):
    return any(method in methods and pattern.match(path) for methods, pattern in HA_LINK_ALLOWED)


def _link_key(request):
    return request.headers.get(remote.KEY_HEADER) or request.query_params.get("key")


def create_app(services, background_tasks=True, on_quit=None, port=None):
    listener = None

    async def follow_remote_access():
        """Listens for other devices on this computer's addresses in the chosen networks, as
        they come and go."""
        while True:
            with contextlib.suppress(Exception):
                await listener.apply(services.remote.addresses())
            await asyncio.sleep(30)

    @contextlib.asynccontextmanager
    async def lifespan(app):
        nonlocal listener
        tasks = []
        if background_tasks:
            tasks = [asyncio.create_task(_auto_refresh(services)), asyncio.create_task(_auto_backup(services)),
                     asyncio.create_task(_auto_alerts(services)), asyncio.create_task(_watch_border_router(services)),
                     asyncio.create_task(autowater_watch(services.autowater))]
            if port and services.remote is not None:
                listener = remote.RemoteListener(app, port)
                tasks.append(asyncio.create_task(follow_remote_access()))
        yield
        for task in tasks:
            task.cancel()
        if listener is not None:
            await listener.stop()
        services.inventory.close()
        services.db.close()

    app = FastAPI(title="HA-CoAP Fleet Manager", version=__version__, lifespan=lifespan,
                  docs_url=None, redoc_url=None, openapi_url=None)
    s = services

    @app.middleware("http")
    async def guard(request: Request, call_next):
        path = request.url.path
        key = _link_key(request)
        access = _access(s, request.client, request.headers.get("host", ""), request.cookies, key)
        if access is None:
            return JSONResponse({"detail": "This app only answers on this computer (127.0.0.1)"}, status_code=403)
        if access == "sign-in" and key and not path.startswith(SIGNED_OUT_PATHS):
            # A dashboard link that was revoked (or other devices turned off): say so, no password page
            if path.startswith("/api/"):
                return JSONResponse({"detail": "This dashboard link doesn't work any more"}, status_code=401)
            return HTMLResponse(LINK_REVOKED_PAGE, status_code=401)
        link = s.remote.link(key, request.client.host if request.client else "") if access == "link" else None
        if access == "link" and (link or {}).get("kind") == "home_assistant":
            if not _ha_link_allows(request.method, path):
                return JSONResponse({"detail": "A Home Assistant link only reads and updates the boards' firmware"},
                                    status_code=403)
        elif access == "link" and not _link_allows(request.method, path):
            return JSONResponse({"detail": "A dashboard link only opens the plants"}, status_code=403)
        view_only = bool((link or {}).get("view_only"))
        if view_only and request.method not in ("GET", "HEAD") and not (request.method == "POST" and path in VIEW_ONLY_POSTS):
            return JSONResponse({"detail": "This dashboard link is view only"}, status_code=403)
        if access == "sign-in" and not path.startswith(SIGNED_OUT_PATHS):
            if path.startswith("/api/"):
                return JSONResponse({"detail": "Sign in first"}, status_code=401)
            return Response(status_code=303, headers={"Location": "/login"})
        if access != "local" and any(request.method in methods and path == p for methods, p in LOCAL_ONLY):
            return JSONResponse({"detail": "Only on the computer the app runs on"}, status_code=403)
        if request.method not in ("GET", "HEAD") and request.headers.get(CHANGE_HEADER) != "1":
            return JSONResponse({"detail": f"Missing {CHANGE_HEADER} header"}, status_code=403)
        request.state.access = access
        request.state.view_only = view_only
        token = current_actor.set(_actor(s, access, request, link))  # what it does is noted with who did it
        try:
            response = await call_next(request)
        finally:
            current_actor.reset(token)
        if request.url.path.startswith(("/static/", "/v/")):
            # The browser checks with the app each time (a 304 when unchanged), so a new
            # version's page is never run with an older cached script.
            response.headers["Cache-Control"] = "no-cache"
        return response

    # ------------------------------------------------------------ status and settings

    @app.get("/api/status")
    async def status(request: Request):
        return {
            "version": __version__,
            "demo": s.demo,
            "access": request.state.access,  # "remote" on another device (signed in)
            "view_only": request.state.view_only,  # a view-only dashboard link
            "data_dir": str(s.data_dir),
            "repository": str(s.repository) if s.repository else None,
            "discovery_available": discovery.discovery_available(),
            "update_running": s.updates.running_job() is not None,
            "settings": s.settings.as_dict(),
        }

    @app.put("/api/settings")
    async def put_settings(values: dict):
        container = str(values.get("border_router_container", "")).strip()
        if container and not otctl.valid_container(container):
            raise _bad_request(f"'{container}' isn't a Docker container name")
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
    async def edit_device(device_id: str, body: dict, request: Request):
        if getattr(request.state, "access", None) == "link" and set(body) - {"plant"}:
            raise HTTPException(403, "A dashboard link only names the plant")  # not its address, notes...
        if s.db.device(device_id) is None:
            raise HTTPException(404, "Unknown device")
        fields = {k: str(v).strip() for k, v in body.items() if k in ("name", "notes", "address", "location", "plant")}
        if "water_below" in body:
            value = body["water_below"]
            try:
                fields["water_below"] = None if value in (None, "") else int(value)
            except (TypeError, ValueError):
                raise _bad_request("The watering target is a percentage, from 0 to 100") from None
            if fields["water_below"] is not None and not 0 <= fields["water_below"] <= 100:
                raise _bad_request("The watering target is a percentage, from 0 to 100")
        for name, kind, low, high, what in (("tank_ml", int, 10, 1_000_000, "The tank's size is in ml, from 10"),
                                            ("pump_ml_s", float, 0.1, 1000, "The pump's flow is in ml per second")):
            if name in body:
                value = body[name]
                try:
                    fields[name] = None if value in (None, "", 0, "0") else kind(float(value))
                except (TypeError, ValueError):
                    raise _bad_request(what) from None
                if fields[name] is not None and not low <= fields[name] <= high:
                    raise _bad_request(what)
        if "watering" in body:
            try:
                fields["watering"] = json.dumps(checked_rule(body["watering"], rule_of(s.db.device(device_id))))
            except RuleError as exc:
                raise _bad_request(exc)
        if "tank_ml" in fields and fields["tank_ml"] and not s.db.device(device_id)["tank_ml"]:
            fields["tank_filled"] = time.time()  # a tank just set up: full from now
        if "tags" in body:
            tags = body["tags"] if isinstance(body["tags"], list) else str(body["tags"]).split(",")
            fields["tags"] = ",".join(sorted({t.strip().lower() for t in tags if t.strip()}))
        changes = described_changes(s.db.device(device_id), fields)
        device = s.db.upsert_device(device_id, **fields)
        if changes:
            s.db.add_activity(device_id, "edit", "Changed: " + ", ".join(changes))
        s.events.publish("device", device=s.inventory.describe(device))
        s.alerts.scan()
        return s.inventory.describe(device)

    @app.delete("/api/devices/{device_id}")
    async def delete_device(device_id: str):
        if not s.db.delete_device(device_id):
            raise HTTPException(404, "Unknown device")
        s.photos.delete(device_id)
        s.events.publish("devices")
        return {"deleted": device_id}

    @app.post("/api/devices/remove-simulated")
    async def remove_simulated():
        """Removes the simulated boards (at a loopback address, such as 127.0.0.2) and their history."""
        removed = []
        for device in s.db.devices():
            try:
                simulated = ipaddress.ip_address(device["address"].split("%")[0]).is_loopback
            except ValueError:
                continue
            if simulated:
                s.db.purge_device(device["device_id"])
                s.photos.delete(device["device_id"])
                removed.append(device["device_id"])
        if removed:
            s.events.publish("devices")
            s.alerts.scan()
        return {"removed": removed}

    @app.get("/api/devices/{device_id}/photo")
    async def device_photo(device_id: str):
        found = s.photos.read(device_id) if s.db.device(device_id) else None
        if found is None:
            raise HTTPException(404, "No photo")
        data, content_type = found
        return Response(data, media_type=content_type, headers={"Cache-Control": "no-cache"})

    @app.post("/api/devices/{device_id}/photo")
    async def set_device_photo(device_id: str, request: Request, taken: float = 0):
        """Adds a photo to the device's timeline. 'taken': when (Unix time; the file's date, or now)."""
        if s.db.device(device_id) is None:
            raise HTTPException(404, "Unknown device")
        if not 946684800 <= taken <= time.time() + DAY_S:  # after 2000, and not in the future
            taken = time.time()
        try:
            s.photos.add(device_id, await request.body(), taken)
        except PictureError as exc:
            raise _bad_request(exc)
        return _photo_changed(device_id, True)

    def _photo_changed(device_id, any_left):
        device = s.inventory.describe(s.db.upsert_device(device_id, photo=time.time() if any_left else None))
        s.events.publish("device", device=device)
        return device

    @app.get("/api/devices/{device_id}/photos")
    async def device_photos(device_id: str):
        if s.db.device(device_id) is None:
            raise HTTPException(404, "Unknown device")
        try:
            return [{"taken": t} for t in s.photos.timeline(device_id)]
        except PictureError as exc:
            raise _bad_request(exc)

    @app.get("/api/devices/{device_id}/photos/{taken}")
    async def device_photo_taken(device_id: str, taken: int):
        found = s.photos.read(device_id, taken) if s.db.device(device_id) else None
        if found is None:
            raise HTTPException(404, "No such photo")
        data, content_type = found
        return Response(data, media_type=content_type, headers={"Cache-Control": "max-age=86400"})

    @app.delete("/api/devices/{device_id}/photos/{taken}")
    async def delete_device_photo_taken(device_id: str, taken: int):
        if s.db.device(device_id) is None:
            raise HTTPException(404, "Unknown device")
        try:
            left = s.photos.remove(device_id, taken)
        except PictureError as exc:
            raise _bad_request(exc)
        return _photo_changed(device_id, left > 0)

    @app.delete("/api/devices/{device_id}/photo")
    async def delete_device_photo(device_id: str):
        """Removes all of the device's photos."""
        if s.db.device(device_id) is None:
            raise HTTPException(404, "Unknown device")
        s.photos.delete(device_id)
        return _photo_changed(device_id, False)

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
            device = s.inventory.describe(await s.inventory.refresh(device_id))
        except InventoryError as exc:
            raise _bad_request(exc)
        s.alerts.scan()
        return device

    @app.post("/api/refresh")
    async def refresh_all():
        devices = await s.inventory.refresh_all()
        s.alerts.scan()
        return devices

    @app.post("/api/devices/{device_id}/slots")
    async def slots(device_id: str, body: dict = None):
        body = body or {}
        try:
            return await s.inventory.read_slots(device_id, body.get("transport", "udp"), body.get("serial_port", ""))
        except InventoryError as exc:
            raise _bad_request(exc)

    # ------------------------------------------------------------ the board's own settings (mcumgr group 64)

    def _not_updating(device_ids):
        job = s.updates.running_job()
        if job is not None and any(t.device_id in device_ids for t in job.targets):
            raise _bad_request("An update is running on this board: wait for it to finish")

    @app.post("/api/devices/{device_id}/board-settings/read")
    async def board_settings(device_id: str, body: dict = None):
        body = body or {}
        _not_updating([device_id])
        try:
            return await s.inventory.board_settings(device_id, body.get("transport", "udp"), body.get("serial_port", ""))
        except InventoryError as exc:
            raise _bad_request(exc)

    @app.put("/api/devices/{device_id}/board-settings")
    async def set_board_settings(device_id: str, body: dict):
        _not_updating([device_id])
        values = body.get("values")
        if not isinstance(values, dict) or not values:
            raise _bad_request("No settings to change")
        try:
            return await s.inventory.set_board_settings(device_id, values, body.get("transport", "udp"),
                                                        body.get("serial_port", ""))
        except (InventoryError, ValueError, TypeError) as exc:
            raise _bad_request(exc)

    @app.post("/api/devices/{device_id}/board-settings/sample")
    async def sample_soil(device_id: str, body: dict = None):
        body = body or {}
        _not_updating([device_id])
        try:
            return await s.inventory.sample_soil(device_id, body.get("transport", "udp"), body.get("serial_port", ""))
        except InventoryError as exc:
            raise _bad_request(exc)

    @app.post("/api/devices/{device_id}/forget-network")
    async def forget_network(device_id: str, body: dict = None):
        body = body or {}
        _not_updating([device_id])
        try:
            return await s.inventory.forget_network(device_id, body.get("transport", "udp"), body.get("serial_port", ""))
        except InventoryError as exc:
            raise _bad_request(exc)

    @app.post("/api/board-settings")
    async def set_fleet_settings(body: dict):
        device_ids = [str(d) for d in body.get("device_ids", [])]
        values = body.get("values")
        if not device_ids or not isinstance(values, dict) or not values:
            raise _bad_request("Choose the boards and the settings to change")
        _not_updating(device_ids)
        try:
            return {"results": await s.inventory.set_fleet_settings(device_ids, values)}
        except (ValueError, TypeError) as exc:
            raise _bad_request(exc)

    @app.get("/api/devices/{device_id}/timeline")
    async def device_timeline(device_id: str, limit: int = 300):
        device = s.db.device(device_id)
        if device is None:
            raise HTTPException(404, "Unknown device")
        return feed.device_timeline(s.db, device, s.photos, max(1, min(limit, 1000)))

    @app.get("/api/graph")
    async def graph(metric: str = "soil_moisture", days: int = 7, device_ids: str = ""):
        try:
            return await asyncio.to_thread(fleet.graph, s.db, s.inventory, metric, max(1, min(days, 365)),
                                           [d for d in device_ids.split(",") if d])
        except ValueError as exc:
            raise _bad_request(exc)

    @app.get("/api/fleet-health")
    async def fleet_health():
        return await asyncio.to_thread(fleet.fleet_health, s.db, s.inventory)

    @app.get("/api/devices/{device_id}/details")
    async def device_details(device_id: str, days: int = 30):
        device = s.db.device(device_id)
        if device is None:
            raise HTTPException(404, "Unknown device")
        since = time.time() - max(1, min(days, 365)) * 86400
        target = fleet.water_target(device, s.settings)
        effect_since = time.time() - 90 * 86400
        described = s.inventory.describe(device)
        return {"device": described, "autowater": s.autowater.explain(described),
                "health": {**fleet.device_health(s.db, device, s.db.release_image(), target=target),
                           "pump_effect": fleet.pump_effect(s.db.readings(device_id, effect_since),
                                                            s.db.activity(device_id, effect_since))},
                "readings": s.db.readings(device_id, since), "links": s.db.link_samples(device_id, since),
                "updates": s.db.updates(device_id, limit=50), "network_events": s.db.network_events_for(device_id),
                "activity": s.db.activity(device_id, since), "care": s.db.care_tasks(device_id),
                "watering_report": fleet.watering_report(
                    s.db.readings(device_id, time.time() - fleet.REPORT_DAYS * 86400),
                    s.db.activity_kind_since(device_id, "pump", time.time() - fleet.REPORT_DAYS * 86400)),
                "restarts": s.db.recent_activity(device_id, "restart", 20),
                "drain": await asyncio.to_thread(fleet.battery_drain, s.db, device)}

    @app.post("/api/devices/{device_id}/tank/refilled")
    async def tank_refilled(device_id: str):
        """Its water tank is full again: it's counted from now."""
        device = s.db.device(device_id)
        if device is None:
            raise HTTPException(404, "Unknown device")
        if not device["tank_ml"]:
            raise _bad_request("Set its tank's size first (on its page, Watering)")
        device = s.inventory.describe(s.db.upsert_device(device_id, tank_filled=time.time()))
        s.db.add_activity(device_id, "tank", "Water tank refilled")
        s.events.publish("device", device=device)
        s.alerts.scan()
        return device

    @app.post("/api/devices/{device_id}/pump")
    async def pump(device_id: str, body: dict):
        on = body.get("on")
        try:
            result = await s.inventory.pump(device_id, on=None if on is None else bool(on), seconds=body.get("seconds"))
        except InventoryError as exc:
            raise _bad_request(exc)
        if on:
            s.db.add_activity(device_id, "pump", f"Pump started from the app ({result['duration']} s)")
        return result

    @app.post("/api/slots/read-all")
    async def read_all_slots():
        return await s.inventory.read_all_slots()

    @app.get("/api/dashboard")
    async def dashboard():
        return fleet.dashboard(s.db, s.inventory, s.network.last())

    @app.get("/api/wall")
    async def wall():
        return await asyncio.to_thread(fleet.wall, s.db, s.inventory)

    # ------------------------------------------------------------ care tasks: fertilize, repot...

    def _care_values(body, partial=False):
        """{what, every_days, due} from the page, checked (only those given, when 'partial')."""
        values = {}
        if "what" in body or not partial:
            values["what"] = " ".join(str(body.get("what") or "").split())[:60]
            if not values["what"]:
                raise _bad_request("Say what to do (such as: Fertilize)")
        if "every_days" in body or not partial:
            try:
                values["every_days"] = int(body.get("every_days"))
            except (TypeError, ValueError):
                raise _bad_request("Every how many days: a number from 1 to 365") from None
            if not 1 <= values["every_days"] <= 365:
                raise _bad_request("Every how many days: a number from 1 to 365")
        if "due" in body or not partial:
            try:
                values["due"] = float(body.get("due") or time.time())
            except (TypeError, ValueError):
                raise _bad_request("When: a time") from None
            if abs(values["due"] - time.time()) > 400 * DAY_S:
                raise _bad_request("When: within a year")
        return values

    def _care_changed(device_id):
        device = s.db.device(device_id)
        if device is not None:
            s.events.publish("device", device=s.inventory.describe(device))

    @app.get("/api/devices/{device_id}/care")
    async def care_tasks(device_id: str):
        return s.db.care_tasks(device_id)

    @app.post("/api/devices/{device_id}/care")
    async def add_care_task(device_id: str, body: dict):
        if s.db.device(device_id) is None:
            raise HTTPException(404, "Unknown device")
        task = s.db.add_care_task(device_id, **_care_values(body))
        s.db.add_activity(device_id, "care", f"Care task added: {task['what']}, every {task['every_days']} days")
        _care_changed(device_id)
        return task

    def _task(task_id):
        task = s.db.care_task(task_id)
        if task is None:
            raise HTTPException(404, "No such care task")
        return task

    @app.patch("/api/care/{task_id}")
    async def edit_care_task(task_id: int, body: dict):
        task = _task(task_id)
        values = _care_values(body, partial=True)
        task = s.db.update_care_task(task_id, **values) if values else task
        _care_changed(task["device_id"])
        return task

    @app.delete("/api/care/{task_id}")
    async def delete_care_task(task_id: int):
        task = _task(task_id)
        s.db.delete_care_task(task_id)
        s.db.add_activity(task["device_id"], "care", f"Care task removed: {task['what']}")
        _care_changed(task["device_id"])
        return {"deleted": task_id}

    @app.post("/api/care/{task_id}/done")
    async def care_done(task_id: int):
        """Done: next due its number of days from now."""
        task = _task(task_id)
        now = time.time()
        task = s.db.update_care_task(task_id, last_done=now, due=now + task["every_days"] * DAY_S)
        s.db.add_activity(task["device_id"], "care", f"Done: {task['what']}")
        _care_changed(task["device_id"])
        return task

    @app.get("/api/away")
    async def away(until: float = 0):
        """What would go wrong while away: until 'until', else the away date set (none: nothing)."""
        until = until or s.settings.away_until
        if until <= time.time():
            return {"until": 0, "plants": []}
        return {"until": until, "plants": await asyncio.to_thread(fleet.away_check, s.db, s.inventory, until)}

    @app.put("/api/away")
    async def set_away(body: dict):
        """Away until a time (0 or none: back). The plants are checked for it."""
        try:
            until = float(body.get("until") or 0)
        except (TypeError, ValueError):
            raise _bad_request("until: a time") from None
        if until and not time.time() < until < time.time() + 366 * DAY_S:
            raise _bad_request("Away until a day in the coming year")
        s.settings.update({"away_until": until})
        config.save_settings(s.data_dir, s.settings)
        s.events.publish("devices")  # the plants' pages show it
        return await away()

    @app.get("/api/summary")
    async def weekly_summary(days: int = 7, end: float = 0):
        return await asyncio.to_thread(summary.build, s.db, s.inventory, s.settings, max(1, min(days, 90)), end or None)

    @app.post("/api/demo")
    async def start_demo():
        """Starts the demo (a second copy of the app, with simulated boards) and returns its address."""
        if s.demo:
            raise _bad_request("This is the demo already")
        try:
            return {"url": await demo.launch_async()}
        except OSError as exc:
            raise _bad_request(f"The demo didn't start: {exc}")

    @app.get("/api/activity-feed")
    async def activity_feed(before: float = 0, limit: int = 30):
        return await asyncio.to_thread(feed.build, s.db, s.inventory, s.photos, before or None, max(1, min(limit, 200)))

    @app.get("/api/battery-drain")
    async def battery_drain():
        return await asyncio.to_thread(fleet.drain_by_image, s.db, s.inventory)

    @app.post("/api/doctor")
    async def doctor(body: dict = None):
        device_id = (body or {}).get("device_id") or None
        if device_id and s.db.device(device_id) is None:
            raise HTTPException(404, "Unknown device")
        return await s.doctor.check(device_id)

    @app.post("/api/devices/{device_id}/ping")
    async def ping(device_id: str):
        try:
            await s.inventory.ping(device_id)
        except InventoryError as exc:
            raise _bad_request(exc)
        s.db.add_activity(device_id, "ping", "Beeped, to be found")
        return {"ok": True}

    # ------------------------------------------------------------ the CoAP tab

    @app.get("/api/coap/resources")
    async def coap_resources():
        return {"resources": coap.RESOURCES, "methods": list(coap.METHODS)}

    @app.post("/api/devices/{device_id}/coap")
    async def coap_request(device_id: str, body: dict):
        """A CoAP request to a board: {method, path, payload (text) or payload_hex, query: [...],
        confirmable}. The answer, described for people (coap.describe), or why there's none."""
        device = s.db.device(device_id)
        if device is None:
            raise HTTPException(status_code=404, detail="Unknown device")
        if not device["address"]:
            raise _bad_request("This board has no network address")
        _not_updating([device_id])
        method = str(body.get("method", "GET")).upper()
        if method not in coap.METHODS:
            raise _bad_request(f"Unknown method {method}: GET, POST, PUT or DELETE")
        path = str(body.get("path", "")).strip().strip("/")
        if (not re.fullmatch(r"[A-Za-z0-9._~-]{1,63}(/[A-Za-z0-9._~-]{1,63}){0,7}", path)
                or any(segment in (".", "..") for segment in path.split("/"))):
            raise _bad_request("A path such as data, or a/b (letters, digits, . _ ~ -)")
        query = [str(q).strip() for q in body.get("query") or [] if str(q).strip()]
        if len(query) > 8 or any(len(q) > 128 or not q.isprintable() for q in query):
            raise _bad_request("A query is up to 8 items such as from=0")
        try:
            payload = bytes.fromhex(body["payload_hex"]) if body.get("payload_hex") else str(body.get("payload", "")).encode()
        except ValueError:
            raise _bad_request("The payload isn't hex, such as 31 or 01 ff")
        if len(payload) > 512:
            raise _bad_request("The payload is up to 512 bytes")
        confirmable = bool(body.get("confirmable", True))
        started = time.perf_counter()
        try:
            code, answer = await coap.request(device["address"], path, coap.METHODS[method], payload,
                                              port=s.settings.coap_port, query=tuple(query),
                                              ack_timeout=s.settings.coap_timeout_s, confirmable=confirmable,
                                              timeout=None if confirmable else s.settings.coap_timeout_s * 2)
            result = {"answered": True, **coap.describe(path, code, answer)}
        except TimeoutError:
            result = {"answered": False, "detail": "No answer" + ("" if confirmable else
                                                                 " (a non-confirmable request may get none)")}
        except (coap.CoapError, OSError) as exc:
            result = {"answered": False, "detail": str(exc)}
        result["elapsed_ms"] = round((time.perf_counter() - started) * 1000)
        if method != "GET":  # a change: in its timeline
            shown = payload.decode("utf-8", errors="replace") if payload.isascii() else payload.hex(" ")
            outcome = f"{result['code']} {result['code_name']}".strip() if result["answered"] else result["detail"]
            s.db.add_activity(device_id, "coap", f"CoAP {method} {path}{f' {shown[:40]!r}' if payload else ''}: {outcome}")
        return result

    @app.get("/api/serial-ports")
    async def ports():
        try:
            return serial_ports.list_ports()
        except ImportError:
            return []

    # ------------------------------------------------------------ images

    def _signature(image_hash, key):
        return s.signing.check(image_hash, lambda: s.images.data(image_hash), key)

    @app.get("/api/images")
    async def images():
        key = await asyncio.to_thread(s.signing.public_key)
        return [{**image, **await asyncio.to_thread(_signature, image["hash"], key)} for image in s.db.images()]

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
            data = path.read_bytes()
            result.append({"variant": variant, "path": str(path), "hash": info.hash, "version": info.mcumgr_version,
                           "size": info.size, "modified": path.stat().st_mtime,
                           "git_commit": build_commit(path.parent.parent),
                           "in_library": s.db.image(info.hash) is not None,
                           **s.signing.check(info.hash, lambda: data)})
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
            return s.builds.start(str(body.get("profile", "")), bool(body.get("allow_development_key", False)),
                                  str(body.get("sign_with", "yours")))
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

    def _development_boards(image_hash, targets):
        """The boards (names) that run an image signed with the development key, when this image
        is signed with your key: their bootloader most likely still has the development key, and
        would refuse it (MCUboot reverts the update on every one of them)."""
        if s.db.image(image_hash) is None or _signature(image_hash, None)["signer"] != "yours":
            return []
        names = []
        for target in targets:
            device = s.db.device(str(target.get("device_id", ""))) if isinstance(target, dict) else None
            running = device["image_hash"] if device else ""
            if running and s.db.image(running) is not None and _signature(running, None)["signer"] == "development":
                names.append(naming.display_name(device))
        return names

    @app.post("/api/updates")
    async def start_update(body: dict):
        image_hash = str(body.get("image_hash", ""))
        if s.db.image(image_hash) is not None and not body.get("allow_unverified"):
            check = await asyncio.to_thread(_signature, image_hash, None)
            if check["signer"] in signing.REFUSED:
                raise _bad_request(f"{check['detail']}. Start it anyway only for the simulator, or a board "
                                   "with a development bootloader.")
        if not body.get("allow_key_change"):
            boards = await asyncio.to_thread(_development_boards, image_hash, list(body.get("targets", [])))
            if boards:
                one = len(boards) == 1
                raise HTTPException(409, f"{', '.join(boards)} {'runs' if one else 'run'} an image signed with the "
                                         f"development key, so {'its' if one else 'their'} bootloader most likely only "
                                         "accepts that key: this image is signed with yours, and would be refused "
                                         "(MCUboot reverts the update). Build it with 'sign with: development key', "
                                         "or go on if the bootloader was flashed with your key.")
        try:
            job = s.updates.start(image_hash, list(body.get("targets", [])), bool(body.get("stop_on_failure", True)),
                                  bool(body.get("staged", False)), s.console, bool(body.get("ignore_battery", False)),
                                  permanent=bool(body.get("permanent", False)))
        except UpdateError as exc:
            raise _bad_request(exc)
        return job.as_dict()

    # ------------------------------------------------------------ for the HA CoAP integration

    def _last_update_of(device_id):
        """The newest update job's step for a board: {status, step, progress, message}, or None."""
        for job_item in sorted(s.updates.jobs.values(), key=lambda j: j.created, reverse=True):
            for target in job_item.targets:
                if target.device_id == device_id:
                    return {"job": job_item.id, "status": target.status, "step": target.step,
                            "progress": target.progress, "message": target.message}
        return None

    @app.get("/api/ha/firmware")
    async def ha_firmware():
        """The release image, and what each board runs (with its last update's state)."""
        release = s.db.release_image()
        commits = {i["hash"]: i["git_commit"] for i in s.db.images()}
        return {
            "release": {"hash": release["hash"], "version": release["version"], "git_commit": release["git_commit"],
                        "notes": release["notes"]} if release else None,
            "running": s.updates.running_job() is not None,
            "devices": [{"device_id": d["device_id"], "name": naming.display_name(d), "image_hash": d["image_hash"],
                         "image_version": d["image_version"], "git_commit": commits.get(d["image_hash"], "") or d["fw_version"],
                         "update": _last_update_of(d["device_id"])} for d in s.db.devices()],
        }

    @app.post("/api/ha/update")
    async def ha_update(body: dict):
        """Updates one board to the release image (as the Updates tab does, one board). Its
        signature isn't checked against this computer's key: the release is the image chosen
        for the fleet (a board whose bootloader refuses it stays on the image it runs)."""
        device_id = str(body.get("device_id", ""))
        if s.db.device(device_id) is None:
            raise HTTPException(404, "Unknown device")
        release = s.db.release_image()
        if release is None:
            raise _bad_request("No release image: choose one in the fleet manager's Images")
        return await start_update({"image_hash": release["hash"], "targets": [{"device_id": device_id}],
                                   "allow_unverified": True})

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
    async def refresh_network(request: Request):
        # From a dashboard link, not more than once a minute: the last reading, if it's that recent
        last = s.network.last()
        if getattr(request.state, "access", None) == "link" and last and \
                time.time() - (last.get("fetched") or 0) < LINK_NETWORK_GAP_S:
            return s.network.state()
        try:
            return await s.network.refresh()
        except NetworkError as exc:
            raise _bad_request(exc)

    @app.get("/api/network/history")
    async def network_history():
        return s.network.history()

    @app.get("/api/network/history/{snapshot_id}")
    async def network_snapshot(snapshot_id: int):
        topology = await asyncio.to_thread(s.network.snapshot, snapshot_id)
        if topology is None:
            raise HTTPException(404, "Unknown reading")
        return topology

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
        if body.get("device_id"):
            # Over the air: the board's 'log' resource
            device = s.db.device(str(body["device_id"]))
            if device is None:
                raise HTTPException(404, "No such device")
            options = {"port": s.settings.coap_port, "ack_timeout": s.settings.coap_timeout_s, "max_retransmit": 1}
            try:
                s.console.open_air(device, options)
            except ConsoleError as exc:
                raise _bad_request(exc)
            return s.console.state()
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

    # ------------------------------------------------------------ flashing a board over SWD

    def _flashable():
        """The builds that can be flashed, with who signed them: the same key as their bootloader."""
        result = []
        for build in swd.hex_files(s.repository):
            signer = "unknown"
            if build["app"] is not None:
                try:
                    signer = s.signing.signer(build["app"].read_bytes())
                except (OSError, mcuboot.ImageError):
                    pass
            result.append({"variant": build["variant"], "path": str(build["path"]), "modified": build["modified"],
                           "signer": signer})
        return result

    @app.get("/api/swd")
    async def swd_state():
        return {"builds": await asyncio.to_thread(_flashable), "tools": swd.nrfutil_device_installed(),
                "jlink": swd.find_jlink() is not None}

    @app.get("/api/swd/probes")
    async def swd_probes():
        nrfutil = s.setup.nrfutil()
        if nrfutil is None or not swd.nrfutil_device_installed():
            raise _bad_request("Install the SWD flashing tools first (Set up this computer)")
        try:
            return await asyncio.to_thread(swd.probes, nrfutil)
        except swd.SwdError as exc:
            raise _bad_request(exc)

    @app.post("/api/swd/flash")
    async def swd_flash(body: dict):
        variant = str(body.get("variant", ""))
        build = next((b for b in await asyncio.to_thread(_flashable) if b["variant"] == variant), None)
        if build is None:
            raise _bad_request(f"No {variant} build to flash: build it first")
        if build["signer"] in signing.REFUSED and not body.get("allow_development_key"):
            raise _bad_request("This build's bootloader isn't made with your signing key: a board flashed with it "
                               "would accept updates signed with that key instead of yours")
        try:
            return s.setup.flash(Path(build["path"]), str(body.get("serial", "")), str(body.get("erase", "keep")),
                                 f"the {variant} build")
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

    @app.get("/api/backups/copy")
    async def backup_copy_state():
        return {"folder": s.settings.backup_copy_dir, **(s.backup_copy or {})}

    @app.post("/api/backups/copy")
    async def copy_backup_now():
        """Copies the newest automatic backup to the chosen folder now (making one first if there's none)."""
        if not s.settings.backup_copy_dir.strip():
            raise _bad_request("Choose a folder first: Settings, Copy backups to")
        await asyncio.to_thread(_copy_backups, s, True)
        return {"folder": s.settings.backup_copy_dir, **(s.backup_copy or {})}

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
        s.border_router.reload()
        s.events.publish("devices")
        s.events.publish("border-router")
        return result

    # ------------------------------------------------------------ the border router (Docker here)

    def _border_router_error(exc):
        return HTTPException(status_code=409 if str(exc).startswith("Busy") else 400, detail=str(exc))

    @app.get("/api/border-router")
    async def border_router_status():
        return await asyncio.to_thread(s.border_router.status)

    @app.get("/api/border-router/newest")
    async def border_router_newest(refresh: bool = False):
        """Whether Docker Hub has a newer build (asked at most every 6 hours, or now with refresh)."""
        return await asyncio.to_thread(s.border_router.newest, refresh)

    @app.get("/api/border-router/candidates")
    async def border_router_candidates():
        return await asyncio.to_thread(s.border_router.candidates)

    @app.get("/api/border-router/logs")
    async def border_router_logs(lines: int = 300, warnings: bool = False):
        try:
            return {"lines": await asyncio.to_thread(s.border_router.logs, lines, warnings)}
        except BorderRouterSetupError as exc:
            raise _border_router_error(exc)

    @app.get("/api/border-router/network")
    async def border_router_network():
        try:
            return await asyncio.to_thread(s.border_router.network_settings, False)
        except BorderRouterSetupError as exc:
            raise _border_router_error(exc)

    @app.post("/api/border-router/network/reveal")
    async def border_router_network_reveal():
        """With the network key: a POST (with the app's header), so no other page can read it."""
        try:
            return await asyncio.to_thread(s.border_router.network_settings, True)
        except BorderRouterSetupError as exc:
            raise _border_router_error(exc)

    @app.post("/api/border-router/network")
    async def border_router_network_import(body: dict):
        try:
            return s.border_router.import_dataset(str(body.get("dataset", "")))
        except BorderRouterSetupError as exc:
            raise _border_router_error(exc)

    @app.post("/api/border-router/setup")
    async def border_router_setup(body: dict):
        try:
            return s.border_router.setup(str(body.get("rcp_device", "")), str(body.get("infra_if", "")))
        except BorderRouterSetupError as exc:
            raise _border_router_error(exc)

    @app.post("/api/border-router/commission")
    async def border_router_commission(body: dict):
        """Lets boards with the PSKd join for a few minutes (the PSKd isn't kept)."""
        try:
            return s.border_router.commission(str(body.get("pskd", "")), int(body.get("minutes", 10)),
                                              str(body.get("eui64", "") or "*"))
        except (BorderRouterSetupError, ValueError) as exc:
            raise _border_router_error(exc)

    @app.post("/api/border-router/commission/stop")
    async def border_router_commission_stop():
        try:
            return s.border_router.stop_commissioning()
        except BorderRouterSetupError as exc:
            raise _border_router_error(exc)

    @app.post("/api/border-router/channel")
    async def border_router_channel(body: dict):
        try:
            return s.border_router.change_channel(int(body.get("channel", 0)), int(body.get("delay_s", 300)))
        except (BorderRouterSetupError, ValueError) as exc:
            raise _border_router_error(exc)

    @app.post("/api/border-router/{action}")
    async def border_router_action(action: str):
        jobs = {"restart": s.border_router.restart, "update": s.border_router.update, "rollback": s.border_router.rollback}
        if action not in jobs:
            raise HTTPException(404, "Unknown action")
        try:
            return jobs[action]()
        except BorderRouterSetupError as exc:
            raise _border_router_error(exc)

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

    @app.get("/api/readings.csv")
    async def readings_csv(device_id: str = "", days: int = 365):
        since = time.time() - max(1, min(days, 3650)) * 86400
        rows = await asyncio.to_thread(s.db.all_readings, since, device_id or None)
        prefix = f"{device_id}-" if device_id else ""
        name = f"hacoap-readings-{prefix}{time.strftime('%Y%m%d')}.csv"
        return Response(backup.readings_csv(rows), media_type="text/csv",
                        headers={"Content-Disposition": f'attachment; filename="{name}"'})

    @app.get("/api/report")
    async def problem_report():
        jobs = [job.as_dict() for job in s.updates.jobs.values()]
        data = await asyncio.to_thread(report.create_report, s, jobs)
        name = f"hacoap-manager-report-{time.strftime('%Y%m%d-%H%M')}.zip"
        return Response(data, media_type="application/zip",
                        headers={"Content-Disposition": f'attachment; filename="{name}"'})

    # ------------------------------------------------------------ alerts and app updates

    @app.get("/api/alerts")
    async def alerts():
        return s.alerts.state()

    @app.post("/api/alerts/dismiss")
    async def dismiss_alerts(body: dict):
        """Several at once ("Dismiss all": the ones shown, not one raised meanwhile)."""
        ids = body.get("ids")
        if not isinstance(ids, list) or not all(isinstance(i, int) and not isinstance(i, bool) for i in ids):
            raise HTTPException(400, "ids: a list of alert IDs")
        s.alerts.dismiss_many(ids)
        return s.alerts.state()

    @app.post("/api/alerts/{alert_id}/dismiss")
    async def dismiss_alert(alert_id: int):
        if not s.alerts.dismiss(alert_id):
            raise HTTPException(404, "No such open alert")
        return s.alerts.state()

    @app.get("/api/app-update")
    async def app_update(force: bool = False):
        if not force and not s.settings.check_app_updates:
            return {"current": __version__, "checking": False}
        return await asyncio.to_thread(s.app_update.check, force)

    # ------------------------------------------------------------ Home Assistant history

    def _home_assistant():
        try:
            return homeassistant.HomeAssistant(s.settings.home_assistant_url, s.ha_token.get())
        except homeassistant.HomeAssistantError as exc:
            raise _bad_request(exc)

    @app.get("/api/home-assistant")
    async def home_assistant_state():
        return {"url": s.settings.home_assistant_url, "token_set": bool(s.ha_token.get())}

    @app.put("/api/home-assistant")
    async def home_assistant_set(body: dict):
        """{url, token}: a token of null keeps the saved one, "" removes it."""
        url = str(body.get("url", s.settings.home_assistant_url)).strip()
        if url and not url.startswith(("http://", "https://")):
            raise _bad_request("The address starts with http:// or https://")
        s.settings.update({"home_assistant_url": url})
        config.save_settings(s.data_dir, s.settings)
        if body.get("token") is not None:
            s.ha_token.set(str(body["token"]))
        return await home_assistant_state()

    @app.post("/api/home-assistant/check")
    async def home_assistant_check():
        ha = _home_assistant()
        try:
            about = await asyncio.to_thread(ha.check)
            boards = await asyncio.to_thread(ha.boards)
        except homeassistant.HomeAssistantError as exc:
            raise _bad_request(exc)
        known = {d["device_id"]: d for d in s.db.devices()}
        for board in boards:
            device = known.get(board["device_id"])
            board["name"] = naming.display_name(device) if device else ""
        return {**about, "boards": boards}

    @app.post("/api/home-assistant/import")
    async def home_assistant_import(body: dict = None):
        ha = _home_assistant()
        days = int((body or {}).get("days", 10))
        try:
            results = await asyncio.to_thread(homeassistant.import_history, s.db, ha, s.db.devices(), days)
        except homeassistant.HomeAssistantError as exc:
            raise _bad_request(exc)
        return {"results": results, "imported": sum(r["imported"] for r in results)}

    # ------------------------------------------------------------ the data folder's size

    @app.get("/api/storage")
    async def storage():
        return await asyncio.to_thread(housekeeping.usage, s.data_dir, s.db)

    @app.post("/api/storage/prune")
    async def storage_prune():
        removed = await asyncio.to_thread(housekeeping.prune, s.db, s.settings)
        backup.prune_backups(s.data_dir, max(s.settings.keep_backups, 1))
        return {"removed": removed, **await asyncio.to_thread(housekeeping.usage, s.data_dir, s.db)}

    @app.post("/api/storage/compact")
    async def storage_compact():
        _busy()
        await asyncio.to_thread(s.db.compact)
        return await asyncio.to_thread(housekeeping.usage, s.data_dir, s.db)

    # ------------------------------------------------------------ running in the background

    @app.get("/api/autostart")
    async def autostart_state():
        return {"supported": autostart.supported() and bool(s.launch), "enabled": autostart.enabled(),
                "log": str(Path(s.data_dir) / "hacoap-manager.log")}

    @app.put("/api/autostart")
    async def autostart_set(body: dict):
        if not s.launch:
            raise _bad_request("Start the app normally (not from a test) to use this")
        try:
            if body.get("enabled"):
                autostart.enable(autostart.command(s.launch["workdir"], s.launch.get("data_dir"), s.launch.get("port")))
            else:
                autostart.disable()
        except OSError as exc:
            raise _bad_request(f"Couldn't change it: {exc}")
        return await autostart_state()

    @app.post("/api/quit")
    async def quit_app():
        if s.updates.running_job() is not None or s.builds.running() or s.setup.running():
            raise _bad_request("Wait for the update, build or setup step in progress to finish")
        if on_quit is None:
            raise _bad_request("This app can't be stopped from the page")
        asyncio.get_running_loop().call_later(0.5, on_quit)  # after answering
        return {"stopping": True}

    # ------------------------------------------------------------ other devices

    @app.get("/login")
    async def login_page(request: Request):
        if request.state.access != "sign-in":
            return Response(status_code=303, headers={"Location": "/"})
        page = (STATIC / "login.html").read_text(encoding="utf-8").replace('="/static/', f'="/v/{static_version()}/')
        return Response(page, media_type="text/html", headers={"Cache-Control": "no-cache"})

    @app.post("/api/login")
    async def login(request: Request, body: dict):
        if request.state.access != "sign-in":
            return {"signed_in": True}
        try:
            token = await asyncio.to_thread(s.remote.sign_in, request.client.host, str(body.get("password", "")),
                                            request.headers.get("user-agent", ""))
        except remote.RemoteError as exc:
            raise HTTPException(status_code=401, detail=str(exc))
        response = JSONResponse({"signed_in": True})
        response.set_cookie(remote.COOKIE, token, max_age=remote.SESSION_DAYS * DAY_S, httponly=True, samesite="strict")
        return response

    @app.post("/api/logout")
    async def logout(request: Request):
        s.remote.sign_out(token=request.cookies.get(remote.COOKIE))
        response = JSONResponse({"signed_out": True})
        response.delete_cookie(remote.COOKIE)
        return response

    @app.get("/api/remote-access")
    async def remote_access(request: Request):
        state = await asyncio.to_thread(s.remote.describe, port)
        return {**state, "here": request.state.access}  # "remote": only links and sign-outs, with the password

    async def _confirm(request):
        """From another device (signed in), a change here needs the password typed again."""
        if request.state.access == "local":
            return
        password = request.headers.get(CONFIRM_HEADER, "")
        if not password:  # not a wrong password: nothing typed yet
            raise HTTPException(403, "Type the password again to confirm, from this device")
        try:
            await asyncio.to_thread(s.remote.check_password, request.client.host, password)
        except remote.RemoteError as exc:
            raise HTTPException(403, f"{exc} (type the password again to confirm)") from None

    @app.put("/api/remote-access")
    async def put_remote_access(body: dict, request: Request):
        password = body.get("password") or None
        try:
            await asyncio.to_thread(s.remote.configure, body.get("enabled"), body.get("networks"), password)
        except remote.RemoteError as exc:
            raise _bad_request(exc)
        if listener is not None:
            await listener.apply(s.remote.addresses())
        return await remote_access(request)

    @app.delete("/api/remote-access/sessions")
    async def sign_everyone_out(request: Request):
        await _confirm(request)
        s.remote.sign_out(everyone=True)
        return await remote_access(request)

    @app.delete("/api/remote-access/sessions/{session_id}")
    async def sign_one_out(session_id: str, request: Request):
        await _confirm(request)
        s.remote.sign_out(session_id=session_id)
        return await remote_access(request)

    @app.post("/api/remote-access/links")
    async def make_link(body: dict, request: Request):
        """A dashboard link: its addresses carry the key, shown this once."""
        await _confirm(request)
        try:
            key = await asyncio.to_thread(s.remote.create_link, body.get("name", ""), bool(body.get("view_only")),
                                          str(body.get("kind") or "dashboard"))
        except remote.RemoteError as exc:
            raise _bad_request(exc)
        addresses = [f"http://{a}:{port}/?key={key}#plants" for a in s.remote.addresses()] if port else []
        return {**(await remote_access(request)), "link": {"key": key, "addresses": addresses}}

    @app.delete("/api/remote-access/links/{link_id}")
    async def revoke_link(link_id: str, request: Request):
        await _confirm(request)
        try:
            await asyncio.to_thread(s.remote.revoke_link, link_id)
        except remote.RemoteError as exc:
            raise HTTPException(404, str(exc))
        return await remote_access(request)

    # ------------------------------------------------------------ live events

    @app.websocket("/api/events")
    async def events(websocket: WebSocket):
        origin = websocket.headers.get("origin", "")
        host = websocket.headers.get("host", "")
        key = websocket.query_params.get("key")
        access = _access(s, websocket.client, host, websocket.cookies, key)
        if access not in ("local", "remote", "link") or (origin and origin.split("//", 1)[-1] != host):
            await websocket.close(code=1008)
            return
        token = websocket.cookies.get(remote.COOKIE)
        await websocket.accept()
        with s.events.subscribe() as queue:
            try:
                while True:
                    try:
                        event = await asyncio.wait_for(queue.get(), timeout=EVENTS_SESSION_CHECK_S)
                    except asyncio.TimeoutError:
                        event = None
                    # Another device signed out, a link revoked (or other devices turned off): no more events
                    if (access == "remote" and s.remote.session(token) is None) or \
                            (access == "link" and s.remote.link(key, websocket.client.host) is None):
                        await websocket.close(code=1008)
                        break
                    if event is not None and (access != "link" or event.get("type") in LINK_EVENTS):
                        await websocket.send_json(event)
            except (WebSocketDisconnect, RuntimeError):
                pass

    # ------------------------------------------------------------ the page

    @app.get("/")
    async def index():
        # The page asks for its files at /v/<version>/..., a new address whenever any of them
        # changes: a browser that saved a file from an older version (before no-cache, it could
        # keep one for days) never runs it with a newer page.
        page = (STATIC / "index.html").read_text(encoding="utf-8")
        page = page.replace('="/static/', f'="/v/{static_version()}/')
        return Response(page, media_type="text/html", headers={"Cache-Control": "no-cache"})

    app.mount("/v/{version}", StaticFiles(directory=STATIC), name="versioned")
    app.mount("/static", StaticFiles(directory=STATIC), name="static")
    return app


def static_version():
    """Changes whenever a file of the page does (its name, size or time)."""
    digest = hashlib.sha256()
    for path in sorted(STATIC.rglob("*")):
        if path.is_file():
            info = path.stat()
            digest.update(f"{path.relative_to(STATIC).as_posix()} {info.st_size} {info.st_mtime_ns}\n".encode())
    return digest.hexdigest()[:12]


async def _auto_refresh(services):
    """Refreshes every device's status, and reads the network (with a border router set), soon
    after the start and then now and then while the app runs."""
    await asyncio.sleep(5)
    while True:
        minutes = services.settings.auto_refresh_minutes
        if minutes > 0 and services.updates.running_job() is None:
            try:
                await services.inventory.refresh_all()
                services.alerts.scan()
            except Exception:  # noqa: BLE001 - try again next time
                log.exception("automatic refresh")
            if services.network.configured():
                try:
                    await services.network.refresh()
                except NetworkError as exc:
                    log.info("automatic network reading: %s", exc)
                except Exception:  # noqa: BLE001
                    log.exception("automatic network reading")
        await asyncio.sleep(max(minutes, 1) * 60)


async def _auto_alerts(services):
    """Checks for alerts every minute (a device going quiet raises one without any event)."""
    while True:
        await asyncio.sleep(60)
        try:
            services.alerts.scan()
        except Exception:  # noqa: BLE001
            log.exception("alerts")


async def _watch_border_router(services, period_s=60):
    """Checks the border router every minute, for its alerts (alerts.check_border_router)."""
    while True:
        await asyncio.sleep(period_s)
        settings = services.settings
        try:
            problems = await asyncio.to_thread(services.border_router.health, settings.border_router_container.strip(),
                                               settings.border_router_url.strip())
            services.alerts.check_border_router(problems)
        except Exception:  # noqa: BLE001 - try again next time
            log.exception("border router check")


def _copy_backups(services, make=False):
    """Copies the newest automatic backup to the chosen folder, unless it's there already ('make':
    a backup first if there's none). Notes how it went, and an alert when it failed."""
    folder = services.settings.backup_copy_dir.strip()
    if not folder:
        services.backup_copy = None
        services.alerts.set_problem("backup-copy", None)
        return
    try:
        newest = backup.newest_auto_backup(services.data_dir)
        if newest is None and make:
            newest = backup.auto_backup(services.data_dir, services.db, services.settings,
                                        max(services.settings.keep_backups, 1), min_age_hours=0)
        if newest is None:
            return
        copied = backup.copy_backup(newest, folder, max(services.settings.keep_backups, 1))
        services.backup_copy = {"time": time.time(), "ok": True, "name": copied.name,
                                "message": f"{copied.name} is in {folder}"}
        services.alerts.set_problem("backup-copy", None)
    except backup.BackupError as exc:
        services.backup_copy = {"time": time.time(), "ok": False, "name": "", "message": str(exc)}
        services.alerts.set_problem("backup-copy", ("backup", f"The daily backup couldn't be copied to {folder}: {exc}"))


async def _auto_backup(services):
    """A backup a day in the data folder's backups/, while the app runs, and the old data deleted
    as the settings say."""
    while True:
        try:
            await asyncio.to_thread(backup.auto_backup, services.data_dir, services.db, services.settings,
                                    max(services.settings.keep_backups, 1))
        except Exception:  # noqa: BLE001 - try again later
            log.exception("automatic backup")
        try:
            await asyncio.to_thread(_copy_backups, services)
        except Exception:  # noqa: BLE001
            log.exception("copying the backup")
        try:
            await asyncio.to_thread(housekeeping.prune, services.db, services.settings)
        except Exception:  # noqa: BLE001
            log.exception("pruning old data")
        await asyncio.sleep(6 * 3600)
