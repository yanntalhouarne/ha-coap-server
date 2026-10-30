"""The Network page: the border router's view of the Thread network, with the boards from
the inventory named, a log of boards changing parent, and every reading kept (compressed)
to look back at."""

import asyncio
import json
import time
import zlib
from pathlib import Path

from .otbr import BorderRouter, BorderRouterError
from .pictures import PictureError, picture_type

# How recent a board's own report ('diag') must be to name it on the map by its short address
BOARD_REPORT_FRESH_S = 2 * 3600

MESHCOP_SERVICE = "_meshcop._udp.local."  # every Thread border router advertises it
REST_PORT = 8081


class NetworkError(Exception):
    pass


class NetworkService:
    def __init__(self, data_dir, db, settings, events):
        self.data_dir = Path(data_dir)
        self.cache = self.data_dir / "network.json"
        self.scan_cache = self.data_dir / "channel-scan.json"
        self.floorplan_file = self.data_dir / "floorplan.img"
        self.floorplan_meta = self.data_dir / "floorplan.json"
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
                "border_router_url": self.settings.border_router_url, "channel_scan": self._read(self.scan_cache),
                "floorplan": self.floorplan_info(), "positions": self.db.floorplan_positions()}

    @staticmethod
    def _read(path):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def _border_router(self):
        url = self.settings.border_router_url.strip()
        if not url:
            raise NetworkError("Set the border router's address first (for example http://192.168.1.20:8081)")
        return BorderRouter(url)

    async def channel_scan(self):
        """Measures the radio noise on every Thread channel, from the border router."""
        border_router = self._border_router()
        try:
            channels = await asyncio.to_thread(border_router.energy_scan)
            current = await asyncio.to_thread(border_router.channel)
        except BorderRouterError as exc:
            raise NetworkError(str(exc)) from exc
        scan = {"time": time.time(), "channels": channels, "current_channel": current}
        self.scan_cache.write_text(json.dumps(scan), encoding="utf-8")
        self.events.publish("network")
        return scan

    # ------------------------------------------------------------ floor plan

    def floorplan_info(self):
        meta = self._read(self.floorplan_meta)
        return meta if meta and self.floorplan_file.exists() else None

    def set_floorplan(self, data, name=""):
        try:
            content_type = picture_type(data)
        except PictureError as exc:
            raise NetworkError(str(exc)) from exc
        self.floorplan_file.write_bytes(data)
        self.floorplan_meta.write_text(json.dumps({"content_type": content_type, "name": name, "time": time.time()}),
                                       encoding="utf-8")
        self.events.publish("network")
        return self.floorplan_info()

    def remove_floorplan(self):
        self.floorplan_file.unlink(missing_ok=True)
        self.floorplan_meta.unlink(missing_ok=True)
        self.events.publish("network")

    def set_position(self, node_key, x, y):
        if x is not None and not (0 <= x <= 1 and 0 <= y <= 1):
            raise NetworkError("Positions are fractions of the picture, from 0 to 1")
        self.db.set_floorplan_position(node_key, x, y)

    async def refresh(self):
        border_router = self._border_router()
        if self._lock.locked():
            raise NetworkError("Already reading the network")
        async with self._lock:
            try:
                topology = (await asyncio.to_thread(border_router.topology)).as_dict()
            except BorderRouterError as exc:
                raise NetworkError(str(exc)) from exc
            self._name_boards(topology)
            self._log_changes(self.last(), topology)
            self._record_links(topology)
            text = json.dumps(topology)
            self.cache.write_text(text, encoding="utf-8")
            self.db.add_network_snapshot(topology.get("fetched") or time.time(), len(topology["nodes"]),
                                         sum(1 for n in topology["nodes"] if n.get("device_id")),
                                         zlib.compress(text.encode("utf-8")), keep=max(self.settings.keep_network_readings, 2))
        self.events.publish("network")
        return self.state()

    def history(self):
        """The readings kept: [{id, time, nodes, boards}], oldest first."""
        return self.db.network_snapshots()

    def snapshot(self, snapshot_id):
        """An earlier reading's topology, or None."""
        row = self.db.network_snapshot(snapshot_id)
        return json.loads(zlib.decompress(row["topology"])) if row else None

    def _name_boards(self, topology):
        """Names the nodes that are boards in the inventory: by their IPv6 address, else by the
        short address the board itself reported in 'diag' lately (an older border router gives
        no addresses for children). A board's own measure of its parent fills in a link the
        border router gave no signal for."""
        devices = self.db.devices()
        by_address = {d["address"].lower(): d for d in devices if d["address"]}
        recent = time.time() - BOARD_REPORT_FRESH_S
        by_rloc16 = {d["rloc16"].lower(): d for d in devices if d["rloc16"] and (d["diag_time"] or 0) > recent}
        boards = {}
        for node in topology["nodes"]:
            for address in node["ipv6"]:
                device = by_address.get(address.lower())
                if device is not None:
                    boards[node["id"]] = device
                    break
        named = {d["device_id"] for d in boards.values()}
        for node in topology["nodes"]:
            device = by_rloc16.get((node.get("rloc16_hex") or "").lower())
            if node["id"] not in boards and device is not None and device["device_id"] not in named:
                boards[node["id"]] = device
                named.add(device["device_id"])
                node["named_by"] = "rloc16"
        nodes = {n["id"]: n for n in topology["nodes"]}
        for node_id, device in boards.items():
            node = nodes[node_id]
            node["device_id"] = device["device_id"]
            node["name"] = device["name"] or device["device_id"]
            parent = nodes.get(node.get("parent"), {})
            if device["parent_rssi"] is None or device["parent_rloc16"] != parent.get("rloc16_hex"):
                continue
            link = next((l for l in topology["links"] if {l["a"], l["b"]} == {node_id, parent["id"]}), None)
            if link is not None and link["average_rssi"] is None and link["link_margin"] is None:
                link["average_rssi"] = device["parent_rssi"]
                if link["link_quality_in"] is None:
                    link["link_quality_in"] = device["link_quality"]
                link["from_board"] = True

    def _record_links(self, topology):
        """Each board's link to its parent, for the link history."""
        nodes = {n["id"]: n for n in topology["nodes"]}
        for node in topology["nodes"]:
            if not node.get("device_id") or not node.get("parent"):
                continue
            parent = nodes.get(node["parent"], {})
            link = next((l for l in topology["links"] if {l["a"], l["b"]} == {node["id"], node["parent"]}), {})
            self.db.add_link_sample(node["device_id"], parent.get("rloc16_hex", ""), link.get("link_margin"),
                                    link.get("average_rssi"), link.get("link_quality_in"),
                                    when=topology.get("fetched"))

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
