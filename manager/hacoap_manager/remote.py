"""Opening the app from other devices (Settings → Other devices), off by default.

The main server only listens on 127.0.0.1: this computer, and SSH tunnels to it, need no
password. With other devices allowed, the app also listens on this computer's own addresses
in the networks chosen (the home network, ZeroTier...), and a device there must sign in with
the password first. Its session is a random token in a cookie (HttpOnly, SameSite=Strict),
kept here only as a hash, and ends after 30 days without use or when signed out.

Dashboard links open the app without the password, for a page that shows it in a frame (Home
Assistant's dashboards), where browsers don't send its cookie: a long random key in the link's
address (?key=...), which the page then sends with each request. A link only opens the plants
(the simple view: their readings, watering, beeping, naming them), never the rest. It works from
the chosen networks only, like signing in, and until it's revoked. Only the key's hash is kept.

The settings, the password's hash, the sessions and the links are in remote-access.json, readable
only by this user and never in a backup. Turning other devices on or off, the networks and the
password change on this computer only (or through an SSH tunnel to it). A signed-in device may
make and revoke dashboard links and sign devices out, with the password typed again for each.
"""

import asyncio
import contextlib
import hashlib
import hmac
import ipaddress
import json
import logging
import os
import secrets
import socket
import time
from pathlib import Path

log = logging.getLogger(__name__)

FILE_NAME = "remote-access.json"
COOKIE = "hacoap_session"
SESSION_DAYS = 30
MAX_SESSIONS = 50
MIN_PASSWORD = 8
SCRYPT = {"n": 2 ** 14, "r": 8, "p": 1}
FREE_TRIES = 5           # wrong passwords from one address before it has to wait
WAIT_S = (30, 15 * 60)   # then 30 s, doubling with each wrong one, at most 15 min
TOUCH_S = 600            # a session's last use is saved at most this often
KEY_HEADER = "X-HACoap-Key"  # a dashboard link's key, as the page sends it (or ?key= in an address)
MAX_LINKS = 20
LINK_KINDS = ("dashboard", "home_assistant")  # the plants (in a dashboard), or the HA CoAP integration's firmware updates
MAX_LINK_NAME = 80


class RemoteError(Exception):
    pass


def browser_name(agent):
    """"Edge on Windows" from a browser's User-Agent (as js/settings.js browserName)."""
    agent = agent or ""
    system = next((name for name in ("iPhone", "iPad", "Android") if name in agent), "") or \
        ("Windows" if "Windows" in agent else "macOS" if "Mac OS X" in agent else "Linux" if "Linux" in agent else "")
    browser = "Home Assistant" if "Home Assistant" in agent else "Edge" if "Edg/" in agent else \
        "Firefox" if "Firefox/" in agent else "Chrome" if "Chrome/" in agent else "Safari" if "Safari/" in agent else ""
    return " on ".join(part for part in (browser, system) if part) or "a signed-in device"


def _hash_password(password, salt):
    return hashlib.scrypt(password.encode("utf-8"), salt=salt, dklen=32, maxmem=64 * 1024 * 1024, **SCRYPT)


def _token_hash(token):
    return hashlib.sha256(token.encode("ascii", errors="replace")).hexdigest()


def is_loopback(address):
    try:
        return ipaddress.ip_address(address).is_loopback
    except ValueError:
        return False


def local_networks():
    """This computer's networks, for choosing: [{network, address, interface, kind}], kind
    being "zerotier" or "lan". Link-local, loopback and VPN tunnels without a subnet are left out."""
    import ifaddr  # comes with zeroconf

    found, seen = [], set()
    for adapter in ifaddr.get_adapters():
        names = f"{adapter.name} {adapter.nice_name}".lower()
        for ip in adapter.ips:
            if not isinstance(ip.ip, str):
                continue  # IPv4 only: the home network and ZeroTier both give one
            address = ipaddress.ip_address(ip.ip)
            if address.is_loopback or address.is_link_local or ip.network_prefix >= 32:
                continue
            network = ipaddress.ip_network(f"{ip.ip}/{ip.network_prefix}", strict=False)
            if str(network) in seen:
                continue
            seen.add(str(network))
            kind = "zerotier" if "zerotier" in names or adapter.name.startswith("zt") else "lan"
            found.append({"network": str(network), "address": ip.ip, "interface": adapter.nice_name, "kind": kind})
    return found


class RemoteAccess:
    def __init__(self, data_dir, networks=local_networks):
        self.path = Path(data_dir) / FILE_NAME
        self._networks = networks
        self._failures = {}  # address: (wrong tries, may try again at)
        self._own = (0.0, [])  # this computer's addresses in the chosen networks, and when found
        self._state = self._load()

    # ------------------------------------------------------------ stored state

    def _load(self):
        try:
            state = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            state = {}
        state.setdefault("enabled", False)
        state.setdefault("networks", [])
        state.setdefault("password", None)
        state.setdefault("sessions", {})
        state.setdefault("links", {})  # key hash: {name, created, last_used, address}
        return state

    def _save(self):
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self._state, indent=2), encoding="utf-8")
        with contextlib.suppress(OSError):
            os.chmod(tmp, 0o600)  # Windows: the per-user data folder is already private
        tmp.replace(self.path)

    @property
    def enabled(self):
        return bool(self._state["enabled"] and self._state["password"] and self._state["networks"])

    def describe(self, port=None):
        """The settings as the page shows them (never the password's hash or a token)."""
        now = time.time()
        sessions = [{"id": key[:12], "created": s["created"], "last_used": s["last_used"], "address": s["address"],
                     "device": s["device"]} for key, s in self._live_sessions(now)]
        return {"enabled": self.enabled, "wanted": self._state["enabled"], "networks": self._state["networks"],
                "password_set": bool(self._state["password"]), "available": self._networks(),
                "addresses": [f"http://{a}:{port}/" for a in self.addresses()] if port else [],
                "sessions": sorted(sessions, key=lambda s: -s["last_used"]),
                "links": sorted(({"id": key[:12], **link} for key, link in self._state["links"].items()),
                                key=lambda link: -link["created"])}

    def configure(self, enabled=None, networks=None, password=None):
        """Changes what's given (None: unchanged), all of it or nothing (RemoteError)."""
        if password is not None and len(password) < MIN_PASSWORD:
            raise RemoteError(f"The password needs at least {MIN_PASSWORD} characters")
        parsed = self._state["networks"]
        if networks is not None:
            parsed = []
            for text in networks:
                try:
                    network = ipaddress.ip_network(str(text).strip(), strict=False)
                except ValueError as exc:
                    raise RemoteError(f"Not a network: {text!r} (write it like 192.168.1.0/24)") from exc
                if network.version != 4 or network.prefixlen < 8 or network.is_loopback:
                    raise RemoteError(f"Choose a home or ZeroTier network, not {network}")
                if str(network) not in parsed:
                    parsed.append(str(network))
        if enabled and not (password or self._state["password"]):
            raise RemoteError("Set a password first")
        if enabled and not parsed:
            raise RemoteError("Choose at least one network")
        if password is not None:
            salt = os.urandom(16)
            self._state["password"] = {"salt": salt.hex(), "hash": _hash_password(password, salt).hex(), **SCRYPT}
            self._state["sessions"] = {}  # a new password signs every device out
        self._state["networks"] = parsed
        if enabled is not None:
            self._state["enabled"] = bool(enabled)
        self._own = (0.0, [])
        self._save()

    # ------------------------------------------------------------ who may come in

    def allows(self, address):
        """Whether a device at 'address' may open the app (once signed in)."""
        if not self.enabled:
            return False
        try:
            ip = ipaddress.ip_address(address)
        except ValueError:
            return False
        if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
            ip = ip.ipv4_mapped
        return any(ip in ipaddress.ip_network(n) for n in self._state["networks"])

    def addresses(self, max_age_s=30):
        """This computer's own addresses in the chosen networks: where the app listens for them
        (looked up again after 'max_age_s': ZeroTier's comes up after the app at boot)."""
        if not self.enabled:
            return []
        found, addresses = self._own
        if time.monotonic() - found > max_age_s or not found:
            addresses = [n["address"] for n in self._networks() if self.allows(n["address"])]
            self._own = (time.monotonic(), addresses)
        return addresses

    def _live_sessions(self, now):
        limit = now - SESSION_DAYS * 86400
        return [(key, s) for key, s in self._state["sessions"].items() if s["last_used"] > limit]

    def session(self, token):
        """The session for a cookie's token, or None. Notes its use."""
        if not token or not self.enabled:
            return None
        key = _token_hash(token)
        session = self._state["sessions"].get(key)
        now = time.time()
        if session is None or session["last_used"] < now - SESSION_DAYS * 86400:
            return None
        if now - session["last_used"] > TOUCH_S:
            session["last_used"] = now
            self._save()
        return session

    def check_password(self, address, password):
        """RemoteError unless 'password' is the password (and after too many wrong ones from
        'address', until the wait is over): for signing in, and for confirming a change."""
        now = time.time()
        tries, until = self._failures.get(address, (0, 0))
        if now < until:
            raise RemoteError(f"Too many wrong passwords: try again in {int(until - now) + 1} s")
        stored = self._state["password"]
        if not self.enabled or not stored:
            raise RemoteError("Signing in from other devices is off")
        expected = bytes.fromhex(stored["hash"])
        given = hashlib.scrypt(str(password).encode("utf-8"), salt=bytes.fromhex(stored["salt"]), dklen=len(expected),
                               maxmem=64 * 1024 * 1024, n=stored["n"], r=stored["r"], p=stored["p"])
        if not hmac.compare_digest(given, expected):
            tries += 1
            wait = 0 if tries < FREE_TRIES else min(WAIT_S[0] * 2 ** (tries - FREE_TRIES), WAIT_S[1])
            self._failures[address] = (tries, now + wait)
            log.warning("wrong password from %s (%d)", address, tries)
            raise RemoteError("Wrong password")
        self._failures.pop(address, None)

    def sign_in(self, address, password, device=""):
        """A new session's token for the right password; RemoteError otherwise (and after too
        many wrong ones, until the wait is over)."""
        self.check_password(address, password)
        now = time.time()
        token = secrets.token_urlsafe(32)
        sessions = dict(self._live_sessions(now))
        while len(sessions) >= MAX_SESSIONS:  # the least recently used goes
            sessions.pop(min(sessions, key=lambda k: sessions[k]["last_used"]))
        sessions[_token_hash(token)] = {"created": now, "last_used": now, "address": address, "device": device[:200]}
        self._state["sessions"] = sessions
        self._save()
        log.info("signed in from %s", address)
        return token

    # ------------------------------------------------------------ dashboard links

    def create_link(self, name, view_only=False, kind="dashboard"):
        """A new dashboard link: returns its key (shown once: only its hash is kept). A view-only
        one shows the plants without watering, beeping, naming them or dismissing alerts. Kind
        "home_assistant": for the HA CoAP integration, which only reads the boards' firmware and
        updates a board to the release image (/api/ha/...), nothing else."""
        if kind not in LINK_KINDS:
            raise RemoteError(f"Unknown kind of link: {kind}")
        name = " ".join(str(name or "").split())[:MAX_LINK_NAME]
        if not name:
            raise RemoteError("Name the link (such as: Home Assistant, plants)")
        if len(self._state["links"]) >= MAX_LINKS:
            raise RemoteError(f"At most {MAX_LINKS} links: revoke one first")
        key = secrets.token_urlsafe(32)
        self._state["links"][_token_hash(key)] = {"name": name, "created": time.time(), "last_used": None, "address": "",
                                                  "view_only": bool(view_only) and kind == "dashboard", "kind": kind}
        self._save()
        log.info("dashboard link made: %s", name)
        return key

    def link(self, key, address=""):
        """The dashboard link for a key, or None (also while other devices are off). Notes its use."""
        if not key or not self.enabled:
            return None
        link = self._state["links"].get(_token_hash(key))
        if link is None:
            return None
        now = time.time()
        if link["last_used"] is None or now - link["last_used"] > TOUCH_S or link["address"] != address:
            link["last_used"], link["address"] = now, address
            self._save()
        return link

    def revoke_link(self, link_id):
        before = len(self._state["links"])
        self._state["links"] = {k: v for k, v in self._state["links"].items() if not k.startswith(str(link_id))}
        if len(self._state["links"]) == before:
            raise RemoteError("No such link")
        self._save()

    def sign_out(self, token=None, session_id=None, everyone=False):
        if everyone:
            self._state["sessions"] = {}
        elif token:
            self._state["sessions"].pop(_token_hash(token), None)
        elif session_id:
            self._state["sessions"] = {k: s for k, s in self._state["sessions"].items() if not k.startswith(session_id)}
        self._save()


class RemoteListener:
    """Serves the app on the addresses RemoteAccess gives (the main server keeps 127.0.0.1),
    started, changed and stopped while the app runs."""

    def __init__(self, app, port):
        self.app = app
        self.port = port
        self.listening = []
        self._server = None
        self._task = None
        self._sockets = []

    async def apply(self, addresses):
        addresses = sorted(set(addresses))
        if addresses == self.listening:
            return
        await self.stop()
        sockets = []
        for address in addresses:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            try:
                if os.name != "nt":
                    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                sock.bind((address, self.port))
                sock.listen(100)
                sock.setblocking(False)
            except OSError as exc:
                log.warning("can't listen on %s:%d: %s", address, self.port, exc)
                sock.close()
                continue
            sockets.append(sock)
        if not sockets:
            return
        import uvicorn

        config = uvicorn.Config(self.app, lifespan="off", log_level="warning", timeout_graceful_shutdown=2)
        config.load()
        server = uvicorn.Server(config)
        server.lifespan = config.lifespan_class(config)
        await server.startup(sockets=sockets)
        self._server, self._sockets = server, sockets
        self._task = asyncio.create_task(server.main_loop())
        self.listening = [s.getsockname()[0] for s in sockets]
        log.info("other devices can open the app at %s", ", ".join(f"http://{a}:{self.port}/" for a in self.listening))

    async def stop(self):
        if self._server is None:
            return
        self._server.should_exit = True
        with contextlib.suppress(Exception):
            await self._task
        with contextlib.suppress(Exception):
            await self._server.shutdown(sockets=self._sockets)
        for sock in self._sockets:
            sock.close()
        self._server, self._task, self._sockets, self.listening = None, None, [], []
