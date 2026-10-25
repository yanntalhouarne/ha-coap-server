"""The Network page: the border router's view of the Thread network, with the boards from
the inventory named, and a log of boards changing parent."""

import asyncio
import json
from pathlib import Path

from .otbr import BorderRouter, BorderRouterError

MESHCOP_SERVICE = "_meshcop._udp.local."  # every Thread border router advertises it
REST_PORT = 8081


class NetworkError(Exception):
    pass


class NetworkService:
    def __init__(self, data_dir, db, settings, events):
        self.cache = Path(data_dir) / "network.json"
        self.db = db
        self.settings = settings
        self.events = events
        self._lock = asyncio.Lock()

    def last(self):
        """The last topology read, or None."""
        try:
            return json.loads(self.cache.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def state(self):
        return {"topology": self.last(), "events": self.db.network_events(),
                "border_router_url": self.settings.border_router_url}

    async def refresh(self):
        url = self.settings.border_router_url.strip()
        if not url:
            raise NetworkError("Set the border router's address first (for example http://192.168.1.20:8081)")
        if self._lock.locked():
            raise NetworkError("Already reading the network")
        async with self._lock:
            try:
                topology = (await asyncio.to_thread(BorderRouter(url).topology)).as_dict()
            except BorderRouterError as exc:
                raise NetworkError(str(exc)) from exc
            self._name_boards(topology)
            self._log_changes(self.last(), topology)
            self.cache.write_text(json.dumps(topology), encoding="utf-8")
        self.events.publish("network")
        return self.state()

    def _name_boards(self, topology):
        """Names the nodes that are boards in the inventory, by their IPv6 address."""
        by_address = {d["address"].lower(): d for d in self.db.devices() if d["address"]}
        for node in topology["nodes"]:
            for address in node["ipv6"]:
                device = by_address.get(address.lower())
                if device is not None:
                    node["device_id"] = device["device_id"]
                    node["name"] = device["name"] or device["device_id"]
                    break

    def _log_changes(self, before, after):
        if not before:
            return
        def parents(topology):
            nodes = {n["id"]: n for n in topology["nodes"]}
            return {n["device_id"]: (nodes.get(n["parent"]) or {}) for n in topology["nodes"] if n.get("device_id")}

        old, new = parents(before), parents(after)
        names = {n["device_id"]: n.get("name") for n in after["nodes"] if n.get("device_id")}
        for device_id, parent in new.items():
            previous = old.get(device_id)
            if previous is None:
                continue
            if parent.get("id") != previous.get("id"):
                describe = lambda p: p.get("rloc16_hex") or "no parent"  # noqa: E731
                self.db.add_network_event(device_id, f"{names.get(device_id)}: parent changed from "
                                                     f"{describe(previous)} to {describe(parent)}")
        for device_id in set(old) - set(new):
            self.db.add_network_event(device_id, f"{device_id}: not in the network any more")

    async def find_border_router(self, timeout=4.0):
        """Looks for border routers on the LAN (mDNS). Returns their REST URLs, best first."""
        from zeroconf import IPVersion, ServiceStateChange
        from zeroconf.asyncio import AsyncServiceBrowser, AsyncServiceInfo, AsyncZeroconf

        names = set()

        def on_change(zeroconf, service_type, name, state_change):
            if state_change in (ServiceStateChange.Added, ServiceStateChange.Updated):
                names.add(name)

        aiozc = AsyncZeroconf()
        urls = []
        try:
            browser = AsyncServiceBrowser(aiozc.zeroconf, MESHCOP_SERVICE, handlers=[on_change])
            await asyncio.sleep(timeout)
            await browser.async_cancel()
            for name in sorted(names):
                info = AsyncServiceInfo(MESHCOP_SERVICE, name)
                if not await info.async_request(aiozc.zeroconf, 3000):
                    continue
                for address in info.parsed_addresses(IPVersion.V4Only) + info.parsed_addresses(IPVersion.V6Only):
                    host = f"[{address}]" if ":" in address else address
                    url = f"http://{host}:{REST_PORT}"
                    if url not in urls and not address.startswith("fe80"):
                        urls.append(url)
        finally:
            await aiozc.async_close()

        working = []
        for url in urls:
            try:
                if await asyncio.to_thread(BorderRouter(url, timeout=3).node_info) is not None:
                    working.append(url)
            except BorderRouterError:
                continue
        return working
