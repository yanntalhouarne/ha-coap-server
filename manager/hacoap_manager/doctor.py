"""Check my connection: walks the path from this computer to the boards, one step at a time,
and says which step fails and what usually fixes it.

1. The border router's REST API answers (when its address is set).
2. mDNS finds the boards (the border router answers for them on the LAN).
3. This computer has a route to each Thread network prefix the boards use.
4. Each board answers CoAP and mcumgr, how fast, and how long an update would take.
"""

import asyncio
import ipaddress
import socket
import time

from . import coap, discovery
from .mcumgr import DeviceLink, McumgrError
from .otbr import BorderRouter, BorderRouterError

DEFAULT_IMAGE_SIZE = 300 * 1024   # bytes, when no release image is set
SMP_OVERHEAD = 120                # bytes of each upload packet that aren't image data
MAX_DEVICES = 24                  # devices timed in one check (each can take seconds)


def step(name, state, detail, advice=""):
    """state: ok, warn, fail or skip."""
    return {"name": name, "state": state, "detail": detail, "advice": advice}


def route_to(address, port=coap.COAP_PORT):
    """The source address this computer would use to reach 'address' (connecting a UDP socket
    sends nothing, it only picks a route). Raises OSError when there's no route."""
    family = socket.AF_INET6 if ":" in address else socket.AF_INET
    with socket.socket(family, socket.SOCK_DGRAM) as sock:
        sock.connect((address, port))
        return sock.getsockname()[0]


def prefix_of(address):
    """The /64 a Thread address belongs to (IPv4, for the simulator: the address itself)."""
    ip = ipaddress.ip_address(address)
    return str(ipaddress.ip_network(f"{address}/64", strict=False)) if ip.version == 6 else address


def estimate_upload_s(round_trip_s, image_size, mtu):
    """Upload time from one mcumgr round trip: one packet of image data per round trip."""
    per_packet = max(mtu - SMP_OVERHEAD, 128)
    return -(-image_size // per_packet) * round_trip_s


class Doctor:
    def __init__(self, db, settings, discover=discovery.discover):
        self.db = db
        self.settings = settings
        self._discover = discover

    async def check(self, device_id=None):
        steps = [await self._border_router(), await self._mdns()]
        devices = [self.db.device(device_id)] if device_id else [d for d in self.db.devices() if d["address"]]
        devices = [d for d in devices if d and d["address"]]
        steps.append(self._routes(devices))
        semaphore = asyncio.Semaphore(4)   # a few at a time: each can wait seconds for a sleepy board

        async def timed(device):
            async with semaphore:
                return await self._time_device(device)

        timings = list(await asyncio.gather(*(timed(d) for d in devices[:MAX_DEVICES])))
        steps.append(self._devices_step(timings, len(devices)))
        failed = next((s for s in steps if s["state"] == "fail"), None)
        warned = next((s for s in steps if s["state"] == "warn"), None)
        summary = (f"Stuck at: {failed['name']}" if failed else f"Mostly fine; look at: {warned['name']}" if warned
                   else "Everything answers")
        return {"summary": summary, "ok": failed is None, "steps": steps, "devices": timings, "checked": time.time()}

    async def _border_router(self):
        name = "Border router"
        url = self.settings.border_router_url.strip()
        if not url:
            return step(name, "skip", "No border router address set (Network tab). Only needed for the map.")
        started = time.monotonic()
        try:
            node = await asyncio.to_thread(BorderRouter(url, timeout=5).node_info)
        except BorderRouterError as exc:
            return step(name, "fail", str(exc),
                        "Check the address and port (8081). If `curl http://localhost:8081/node` works on the "
                        "border router itself but not from here, its REST API only listens locally: start otbr-agent "
                        "with --rest-listen-address set to its LAN address (or ::).")
        took = (time.monotonic() - started) * 1000
        state = (node or {}).get("State") or (node or {}).get("state") or ""
        return step(name, "ok", f"{url} answers in {took:.0f} ms" + (f" (Thread role: {state})" if state else ""))

    async def _mdns(self):
        name = "Finding boards (mDNS)"
        if self._discover is None or not discovery.discovery_available():
            return step(name, "skip", "Browsing for boards isn't available in this app (zeroconf missing).")
        try:
            found = await self._discover(self.settings.discovery_timeout_s)
        except Exception as exc:  # noqa: BLE001 - zeroconf raises many kinds
            return step(name, "fail", f"Browsing failed: {exc}", "Another mDNS program may hold the port; try again.")
        boards = [f for f in found if f.instance.startswith(discovery.NAME_PREFIX)]
        if not boards:
            return step(name, "warn", f"No ha-coap board answered in {self.settings.discovery_timeout_s:.0f} s.",
                        "The border router answers for the boards over mDNS on your LAN. This computer must be on "
                        "the same network (same VLAN, no Wi-Fi client isolation) and its firewall must let mDNS in "
                        "(UDP 5353). Adding a board by its address still works.")
        return step(name, "ok", f"{len(boards)} board(s) found: " + ", ".join(b.instance for b in boards[:6])
                    + ("…" if len(boards) > 6 else ""))

    def _routes(self, devices):
        name = "Route to the Thread network"
        if not devices:
            return step(name, "skip", "No board addresses known yet: find or add a board first.")
        prefixes = {}
        for device in devices:
            prefixes.setdefault(prefix_of(device["address"]), device["address"])
        missing, via = [], []
        for prefix, address in prefixes.items():
            try:
                via.append(f"{prefix} via {route_to(address, self.settings.coap_port)}")
            except OSError:
                missing.append(prefix)
        if missing:
            return step(name, "fail", "No route from this computer to " + ", ".join(missing) + ".",
                        "The border router announces the Thread network's prefix to your LAN in router "
                        "advertisements; this computer must accept them. On Linux, set "
                        "net.ipv6.conf.<interface>.accept_ra_rt_info_max_plen=64 (and accept_ra=2 if it forwards "
                        "packets). Also check that IPv6 is on, and that no VPN takes all the traffic.")
        return step(name, "ok", "; ".join(via))

    async def _time_device(self, device):
        """How fast a board answers CoAP and mcumgr, and an update's upload time from that."""
        result = {"device_id": device["device_id"], "name": device["name"] or device["device_id"],
                  "address": device["address"], "coap_ms": None, "mcumgr_first_ms": None, "mcumgr_ms": None,
                  "upload_s": None, "error": ""}
        options = {"port": self.settings.coap_port, "ack_timeout": self.settings.coap_timeout_s, "max_retransmit": 1}
        started = time.monotonic()
        try:
            await coap.get_info(device["address"], **options)
            result["coap_ms"] = (time.monotonic() - started) * 1000
        except (coap.CoapError, TimeoutError, OSError) as exc:
            result["error"] = f"No CoAP answer: {exc}"
            return result
        try:
            async with DeviceLink("udp", device["address"], self.settings.link_settings()) as link:
                # The first answer can wait for a sleepy board's next poll; after it, the board
                # polls fast while mcumgr is in use, as during an update.
                started = time.monotonic()
                await link.echo()
                result["mcumgr_first_ms"] = (time.monotonic() - started) * 1000
                started = time.monotonic()
                await link.echo()
                result["mcumgr_ms"] = (time.monotonic() - started) * 1000
        except McumgrError as exc:
            result["error"] = f"No mcumgr answer: {exc}"
            return result
        release = self.db.release_image()
        size = release["size"] if release and release.get("size") else DEFAULT_IMAGE_SIZE
        result["upload_s"] = estimate_upload_s(result["mcumgr_ms"] / 1000, size, self.settings.udp_mtu)
        return result

    @staticmethod
    def _devices_step(timings, total):
        name = "Boards answering"
        if not timings:
            return step(name, "skip", "No board addresses known yet.")
        failing = [t for t in timings if t["error"]]
        timed = f"{len(timings)} of {total} checked" if total > len(timings) else f"{len(timings)} checked"
        if len(failing) == len(timings):
            return step(name, "fail", f"None answered ({timed}).",
                        "If the route step passed, check that the boards are on (and on this Thread network), and "
                        "that no firewall on this computer blocks UDP 5683 (CoAP) and 1337 (mcumgr) replies.")
        if failing:
            return step(name, "warn", f"{len(timings) - len(failing)} answered, {len(failing)} didn't ({timed}): "
                        + ", ".join(t["name"] for t in failing) + ".",
                        "A board that doesn't answer may be off, out of range, or have a flat battery.")
        return step(name, "ok", f"All answered ({timed}).")
