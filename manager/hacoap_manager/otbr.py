"""The Thread network's topology, from the border router's REST API (ot-br-posix, port 8081).

Two generations of the API are supported:
- current (2025 on): /api/devices and /api/actions. The border router lists every device
  (with its OMR IPv6 address), then asks each router for its neighbours and children, with
  link margin and RSSI.
- older: GET /diagnostics, the routers' diagnostics: link quality (0-3) between routers, and
  each router's child table (no signal strength, no addresses for children).

Both are turned into the same topology: nodes (routers, children) and links (router to
router, child to parent), with whatever signal information the border router gives.
"""

import json
import time
import urllib.error
import urllib.request

JSON_API = "application/vnd.api+json"
ROUTER_ROLES = ("leader", "router")
DIAG_TYPES = ["extAddress", "rloc16", "mode", "route", "childTable", "ipv6Addresses",
              "children", "childIpv6Addresses", "routerNeighbors"]


class BorderRouterError(Exception):
    pass


def _get(data, *names, default=None):
    """The first of 'names' found in a dict, also in the older API's PascalCase."""
    for name in names:
        for key in (name, name[:1].upper() + name[1:]):
            if isinstance(data, dict) and key in data:
                return data[key]
    return default


def _rloc16(value):
    if value is None:
        return None
    if isinstance(value, str):
        return int(value, 16)  # "0x5c01" or "5c01"
    return int(value)


def _hex16(value):
    return f"0x{value:04x}" if value is not None else ""


def _mode_kind(rx_on_when_idle, ftd):
    """How a child is described: SED (sleepy), MED (minimal, always on), or FTD child."""
    if ftd:
        return "FTD child"
    return "MED" if rx_on_when_idle else "SED"


class Topology:
    """Nodes keyed by an ID (the extended address when known, else 'rloc-0x5c01')."""

    def __init__(self, source):
        self.source = source
        self.nodes = {}
        self.links = []
        self.warnings = []
        self.border_router = None

    def node(self, rloc16=None, ext_address=None):
        for node in self.nodes.values():
            if ext_address and node["ext_address"] == ext_address:
                return node
            if rloc16 is not None and node["rloc16"] == rloc16 and (not ext_address or not node["ext_address"]):
                return node
        return None

    def add_node(self, rloc16=None, ext_address=None, **fields):
        node = self.node(rloc16, ext_address)
        if node is None:
            node_id = ext_address or f"rloc-{_hex16(rloc16)}"
            node = {"id": node_id, "rloc16": rloc16, "rloc16_hex": _hex16(rloc16), "ext_address": ext_address or "",
                    "role": "", "kind": "", "ipv6": [], "border_router": False, "parent": None}
            self.nodes[node_id] = node
        if ext_address and not node["ext_address"]:
            node["ext_address"] = ext_address
        if rloc16 is not None and node["rloc16"] is None:
            node["rloc16"], node["rloc16_hex"] = rloc16, _hex16(rloc16)
        for key, value in fields.items():
            if key == "ipv6":
                node["ipv6"] = sorted(set(node["ipv6"]) | set(value or []))
            elif value not in (None, ""):
                node[key] = value
        return node

    def add_link(self, a, b, kind, **signal):
        for link in self.links:
            if {link["a"], link["b"]} == {a, b}:
                for key, value in signal.items():
                    if value is not None and link.get(key) is None:
                        link[key] = value
                return link
        link = {"a": a, "b": b, "kind": kind, "link_quality_in": None, "link_quality_out": None,
                "link_margin": None, "average_rssi": None, "last_rssi": None}
        link.update({k: v for k, v in signal.items() if v is not None})
        self.links.append(link)
        return link

    def as_dict(self):
        return {"source": self.source, "nodes": list(self.nodes.values()), "links": self.links,
                "warnings": self.warnings, "border_router": self.border_router, "fetched": time.time()}


class BorderRouter:
    def __init__(self, base_url, timeout=10.0, task_timeout=90.0, poll_interval=1.0):
        self.base = base_url.rstrip("/")
        self.timeout = timeout
        self.task_timeout = task_timeout
        self.poll_interval = poll_interval

    # ------------------------------------------------------------ HTTP

    def _request(self, method, path, body=None, accept="application/json", content_type="application/json"):
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(self.base + path, data=data, method=method,
                                         headers={"Accept": accept, **({"Content-Type": content_type} if data else {})})
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                text = response.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as exc:
            if exc.code in (404, 405):
                return None
            raise BorderRouterError(f"{method} {path}: HTTP {exc.code}") from exc
        except (urllib.error.URLError, OSError) as exc:
            raise BorderRouterError(f"Cannot reach the border router at {self.base} ({getattr(exc, 'reason', exc)})") from exc
        try:
            return json.loads(text) if text.strip() else {}
        except ValueError as exc:
            raise BorderRouterError(f"{method} {path}: not JSON") from exc

    def node_info(self):
        return self._request("GET", "/node")

    def channel(self):
        """The network's radio channel (11-26), from the active dataset, or None."""
        try:
            dataset = self._request("GET", "/node/dataset/active") or {}
        except BorderRouterError:
            return None
        value = _get(dataset, "channel")
        return int(value) if value is not None else None

    def energy_scan(self, channels=range(11, 27), count=3, period=32, duration=50):
        """Asks the border router to measure the radio noise on each channel (2025+ API only).
        Returns [{channel, max_rssi, average_rssi}], with RSSI in dBm: higher is noisier."""
        if self._request("GET", "/api/devices", accept=JSON_API) is None:
            raise BorderRouterError("A channel scan needs a border router with the 2025+ REST API (/api/actions)")
        node = self.node_info() or {}
        task = {"type": "getEnergyScanTask",
                "attributes": {"destination": (_get(node, "extAddress") or "").lower(), "channelMask": list(channels),
                               "count": count, "period": period, "scanDuration": duration, "timeout": 60}}
        status, result_id = next(iter(self._wait_tasks(self._post_tasks([task])).values()))
        if status != "completed" or not result_id:
            raise BorderRouterError(f"The channel scan didn't complete ({status})")
        report = ((self._request("GET", f"/api/diagnostics/{result_id}", accept=JSON_API) or {})
                  .get("data", {}).get("attributes", {}).get("report")) or []
        scan = []
        for entry in report:
            values = entry.get("maxRssi") or []
            if values:
                scan.append({"channel": entry.get("channel"), "max_rssi": max(values),
                             "average_rssi": round(sum(values) / len(values), 1)})
        return sorted(scan, key=lambda c: c["channel"])

    # ------------------------------------------------------------ topology

    def topology(self):
        """Reads the network. Raises BorderRouterError if the border router can't tell."""
        devices = self._request("GET", "/api/devices", accept=JSON_API)
        if devices is not None:
            topology = self._topology_api()
        else:
            diagnostics = self._request("GET", "/diagnostics")
            if diagnostics is None:
                raise BorderRouterError("The border router's REST API has neither /api/devices nor /diagnostics")
            topology = self._topology_legacy(diagnostics)
        if topology.border_router is not None:
            topology.border_router["channel"] = self.channel()
        return topology

    # older API: GET /diagnostics -------------------------------------------------

    def _topology_legacy(self, diagnostics):
        topology = Topology("diagnostics")
        node_info = self.node_info() or {}
        br_rloc16 = _rloc16(_get(node_info, "rloc16"))
        br_ext = (_get(node_info, "extAddress") or "").lower()
        topology.border_router = {"network_name": _get(node_info, "networkName", default=""),
                                  "state": _get(node_info, "state", default=""), "rloc16": _hex16(br_rloc16)}
        if isinstance(diagnostics, dict):
            diagnostics = [diagnostics]
        leader_ids = set()
        for diag in diagnostics:
            leader = _get(_get(diag, "leaderData", default={}), "leaderRouterId")
            if leader is not None:
                leader_ids.add(int(leader))
        # Routers first, so that children find their parent
        for diag in diagnostics:
            rloc16 = _rloc16(_get(diag, "rloc16"))
            if rloc16 is None:
                continue
            ext = (_get(diag, "extAddress") or "").lower()
            router_id = rloc16 >> 10
            is_router = (rloc16 & 0x1FF) == 0
            topology.add_node(rloc16, ext, role="leader" if router_id in leader_ids and is_router else
                              ("router" if is_router else "child"), kind="router" if is_router else "",
                              ipv6=_get(diag, "ip6AddressList", "ipv6Addresses", default=[]),
                              border_router=(rloc16 == br_rloc16 or (br_ext and ext == br_ext)))
        for diag in diagnostics:
            rloc16 = _rloc16(_get(diag, "rloc16"))
            if rloc16 is None or rloc16 & 0x1FF:
                continue
            me = topology.node(rloc16)
            route = _get(diag, "route", default={}) or {}
            for entry in _get(route, "routeData", default=[]) or []:
                neighbor = int(_get(entry, "routeId", default=-1)) << 10
                lq_in, lq_out = _get(entry, "linkQualityIn"), _get(entry, "linkQualityOut")
                if neighbor == rloc16 or not lq_in or not lq_out:
                    continue  # no direct link
                other = topology.node(neighbor) or topology.add_node(neighbor, role="router", kind="router")
                topology.add_link(me["id"], other["id"], "mesh", link_quality_in=lq_in, link_quality_out=lq_out)
            for child in _get(diag, "childTable", default=[]) or []:
                child_rloc16 = rloc16 | int(_get(child, "childId", default=0))
                mode = _get(child, "mode", default={}) or {}
                ftd = bool(_get(mode, "deviceType", "fullThreadDevice", default=0))
                rx_on = bool(_get(mode, "rxOnWhenIdle", default=0))
                node = topology.add_node(child_rloc16, role="child", kind=_mode_kind(rx_on, ftd), parent=me["id"])
                topology.add_link(node["id"], me["id"], "child", link_quality_in=_get(child, "linkQuality"))
        if not any(n["kind"] != "router" for n in topology.nodes.values()):
            topology.warnings.append("No children reported.")
        topology.warnings.append("This border router's API version gives link quality (0 to 3) but no signal "
                                 "strength, and no addresses for children: boards can't be named on the map.")
        return topology

    # current API: /api/devices, /api/actions, /api/diagnostics -----------------

    def _post_tasks(self, tasks):
        response = self._request("POST", "/api/actions", {"data": tasks}, accept=JSON_API, content_type=JSON_API)
        if response is None:
            raise BorderRouterError("POST /api/actions isn't supported")
        return [item["id"] for item in response.get("data", [])]

    def _wait_tasks(self, task_ids):
        """Waits for tasks to end. Returns {task id: (status, result id or None)}."""
        deadline = time.monotonic() + self.task_timeout
        results = {}
        while task_ids and time.monotonic() < deadline:
            for task_id in list(task_ids):
                item = (self._request("GET", f"/api/actions/{task_id}", accept=JSON_API) or {}).get("data", {})
                status = item.get("attributes", {}).get("status", "")
                if status in ("completed", "stopped", "failed"):
                    result = (((item.get("relationships") or {}).get("result") or {}).get("data") or {}).get("id")
                    results[task_id] = (status, result)
                    task_ids.remove(task_id)
            if task_ids:
                time.sleep(self.poll_interval)
        for task_id in task_ids:
            results[task_id] = ("timeout", None)
        return results

    def _topology_api(self):
        topology = Topology("api")
        task = {"type": "updateDeviceCollectionTask",
                "attributes": {"maxAge": 30, "maxRetries": 5, "deviceCount": 100, "timeout": 60}}
        status, _ = next(iter(self._wait_tasks(self._post_tasks([task])).values()))
        if status != "completed":
            topology.warnings.append(f"Updating the border router's device list: {status}")

        devices = (self._request("GET", "/api/devices", accept=JSON_API) or {}).get("data", [])
        routers = []
        for item in devices:
            attributes = item.get("attributes", {})
            ext = (attributes.get("extAddress") or item.get("id") or "").lower()
            mode = attributes.get("mode") or {}
            role = attributes.get("role", "")
            is_router = role in ROUTER_ROLES
            omr = attributes.get("omrIpv6Address") or []
            node = topology.add_node(
                _rloc16(attributes.get("rloc16")), ext, role=role,
                kind="router" if is_router else _mode_kind(mode.get("rxOnWhenIdle"), mode.get("fullThreadDevice")),
                ipv6=omr if isinstance(omr, list) else [omr], hostname=attributes.get("hostname", ""),
                border_router=item.get("type") == "threadBorderRouter")
            if node["border_router"]:
                topology.border_router = {"network_name": attributes.get("networkName", ""), "state": role,
                                          "rloc16": node["rloc16_hex"]}
            if is_router:
                routers.append(node)

        if routers:
            tasks = [{"type": "getNetworkDiagnosticTask",
                      "attributes": {"destination": r["ext_address"], "types": DIAG_TYPES, "timeout": 30}}
                     for r in routers]
            results = self._wait_tasks(self._post_tasks(tasks))
            for router, (status, result_id) in zip(routers, results.values()):
                if status != "completed" or not result_id:
                    topology.warnings.append(f"No diagnostics from router {router['rloc16_hex'] or router['id']} ({status})")
                    continue
                diag = (self._request("GET", f"/api/diagnostics/{result_id}", accept=JSON_API) or {}) \
                    .get("data", {}).get("attributes", {})
                self._add_router_diagnostics(topology, router, diag)
        return topology

    def _add_router_diagnostics(self, topology, router, diag):
        rloc16 = _rloc16(diag.get("rloc16"))
        topology.add_node(rloc16, router["ext_address"], ipv6=diag.get("ipv6Addresses"))
        for neighbor in diag.get("routerNeighbors") or []:
            other = topology.add_node(_rloc16(neighbor.get("rloc16")), (neighbor.get("extAddress") or "").lower(),
                                      role=None, kind="router")
            topology.add_link(router["id"], other["id"], "mesh", link_margin=neighbor.get("linkMargin"),
                              average_rssi=neighbor.get("averageRssi"), last_rssi=neighbor.get("lastRssi"))
        route = diag.get("route") or {}
        for entry in route.get("routeData") or []:
            neighbor = int(entry.get("routeId", -1)) << 10
            if neighbor == rloc16 or not entry.get("linkQualityIn") or not entry.get("linkQualityOut"):
                continue
            other = topology.node(neighbor) or topology.add_node(neighbor, kind="router")
            topology.add_link(router["id"], other["id"], "mesh", link_quality_in=entry.get("linkQualityIn"),
                              link_quality_out=entry.get("linkQualityOut"))
        child_ips = {_rloc16(c.get("rloc16")): c.get("ipv6Addresses") or [] for c in diag.get("childIpv6Addresses") or []}
        children = diag.get("children") or []
        for child in children:
            child_rloc16 = _rloc16(child.get("rloc16"))
            node = topology.add_node(child_rloc16, (child.get("extAddress") or "").lower(), role="child",
                                     kind=_mode_kind(child.get("rxOnWhenIdle"), child.get("fullThreadDevice")),
                                     parent=router["id"], ipv6=child_ips.get(child_rloc16), timeout=child.get("timeout"))
            topology.add_link(node["id"], router["id"], "child", link_margin=child.get("linkMargin"),
                              average_rssi=child.get("averageRssi"), last_rssi=child.get("lastRssi"))
        if not children:
            for child in diag.get("childTable") or []:
                mode = child.get("mode") or {}
                node = topology.add_node((rloc16 or 0) | int(child.get("childId", 0)), role="child",
                                         kind=_mode_kind(mode.get("rxOnWhenIdle"), mode.get("fullThreadDevice")),
                                         parent=router["id"], timeout=child.get("timeout"))
                topology.add_link(node["id"], router["id"], "child", link_quality_in=child.get("linkQuality"))
