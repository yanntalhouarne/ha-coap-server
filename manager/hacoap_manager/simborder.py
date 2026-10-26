"""A simulated border router REST API (ot-br-posix), for tests and for trying the Network page.

It serves a small made-up network: the border router (leader), two more routers, and
children of different kinds, two of them boards at the given addresses. "api" mode answers
like a 2025+ border router (/api/devices, /api/actions, /api/diagnostics), "legacy" mode like
an older one (/node and /diagnostics only).
"""

import json
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def link_quality(margin):
    """OpenThread's link quality (0-3) for a link margin in dB."""
    return 3 if margin > 20 else 2 if margin > 10 else 1 if margin > 2 else 0


def scenario(board_addresses=("fd11:22::1", "fd11:22::2")):
    """The made-up network. Margins are in dB; RSSI = margin - 100 (noise floor -100 dBm)."""
    routers = [
        {"name": "border router", "rloc16": 0x5000, "ext": "aa00000000000001", "leader": True, "br": True,
         "ipv6": ["fd11:22::aa"]},
        {"name": "plug", "rloc16": 0x6800, "ext": "bb00000000000002", "ipv6": ["fd11:22::bb"]},
        {"name": "hub", "rloc16": 0x7c00, "ext": "cc00000000000003", "ipv6": ["fd11:22::cc"]},
    ]
    router_links = [(0x5000, 0x6800, 45), (0x6800, 0x7c00, 18), (0x5000, 0x7c00, 28)]
    children = [
        {"rloc16": 0x5001, "ext": "d100000000000001", "parent": 0x5000, "rx_on": False, "ftd": False, "margin": 62,
         "ipv6": [board_addresses[0]]},
        {"rloc16": 0x6801, "ext": "d200000000000002", "parent": 0x6800, "rx_on": False, "ftd": False, "margin": 14,
         "ipv6": [board_addresses[1]] if len(board_addresses) > 1 else ["fd11:22::d2"]},
        {"rloc16": 0x7c02, "ext": "e300000000000003", "parent": 0x7c00, "rx_on": True, "ftd": False, "margin": 35,
         "ipv6": ["fd11:22::e3"]},
        {"rloc16": 0x5003, "ext": "f400000000000004", "parent": 0x5000, "rx_on": True, "ftd": True, "margin": 50,
         "ipv6": ["fd11:22::f4"]},
    ]
    return {"routers": routers, "router_links": router_links, "children": children}


def _margin(net, a, b):
    for x, y, margin in net["router_links"]:
        if {x, y} == {a, b}:
            return margin
    return None


def _mode(rx_on, ftd, pascal=False):
    if pascal:
        return {"RxOnWhenIdle": int(rx_on), "DeviceType": int(ftd), "NetworkData": 1}
    return {"rxOnWhenIdle": rx_on, "fullThreadDevice": ftd, "fullNetworkData": True}


def legacy_diagnostics(net):
    result = []
    for router in net["routers"]:
        route_data = []
        for other in net["routers"]:
            margin = _margin(net, router["rloc16"], other["rloc16"])
            lq = link_quality(margin) if margin is not None else 0
            route_data.append({"RouteId": other["rloc16"] >> 10, "LinkQualityOut": lq, "LinkQualityIn": lq,
                               "RouteCost": 1 if lq else 0})
        child_table = [{"ChildId": c["rloc16"] & 0x1FF, "Timeout": 240, "Mode": _mode(c["rx_on"], c["ftd"], True)}
                       for c in net["children"] if c["parent"] == router["rloc16"]]
        result.append({"ExtAddress": router["ext"], "Rloc16": router["rloc16"], "Mode": _mode(True, True, True),
                       "Route": {"IdSequence": 1, "RouteData": route_data},
                       "LeaderData": {"PartitionId": 1, "LeaderRouterId": 0x5000 >> 10},
                       "IP6AddressList": router["ipv6"], "ChildTable": child_table})
    return result


def api_devices(net):
    data = []
    for router in net["routers"]:
        attributes = {"extAddress": router["ext"], "omrIpv6Address": router["ipv6"],
                      "role": "leader" if router.get("leader") else "router",
                      "mode": _mode(True, True), "hostname": router["name"]}
        if router.get("br"):
            attributes.update(rloc16=f"0x{router['rloc16']:04x}", networkName="SimThread")
        data.append({"id": router["ext"], "type": "threadBorderRouter" if router.get("br") else "threadDevice",
                     "attributes": attributes})
    for child in net["children"]:
        data.append({"id": child["ext"], "type": "threadDevice",
                     "attributes": {"extAddress": child["ext"], "omrIpv6Address": child["ipv6"], "role": "child",
                                    "mode": _mode(child["rx_on"], child["ftd"])}})
    return data


def api_diagnostic(net, ext):
    router = next(r for r in net["routers"] if r["ext"] == ext)
    neighbors = []
    for other in net["routers"]:
        margin = _margin(net, router["rloc16"], other["rloc16"])
        if margin is not None and other is not router:
            neighbors.append({"rloc16": f"0x{other['rloc16']:04x}", "extAddress": other["ext"], "linkMargin": margin,
                              "averageRssi": margin - 100, "lastRssi": margin - 99})
    mine = [c for c in net["children"] if c["parent"] == router["rloc16"]]
    return {"extAddress": router["ext"], "rloc16": f"0x{router['rloc16']:04x}", "ipv6Addresses": router["ipv6"],
            "routerNeighbors": neighbors,
            "children": [{"rloc16": f"0x{c['rloc16']:04x}", "extAddress": c["ext"], "rxOnWhenIdle": c["rx_on"],
                          "fullThreadDevice": c["ftd"], "timeout": 240, "linkMargin": c["margin"],
                          "averageRssi": c["margin"] - 100, "lastRssi": c["margin"] - 98} for c in mine],
            "childIpv6Addresses": [{"rloc16": f"0x{c['rloc16']:04x}", "ipv6Addresses": c["ipv6"]} for c in mine]}


class SimulatedBorderRouter:
    def __init__(self, mode="api", host="127.0.0.1", port=0, net=None):
        self.mode = mode
        self.net = net or scenario()
        self.tasks = {}
        self.diagnostics = {}
        self.requests = []
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _send(self, status, body=None):
                data = json.dumps(body).encode() if body is not None else b""
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                owner.requests.append(("GET", self.path))
                status, body = owner.get(self.path)
                self._send(status, body)

            def do_POST(self):
                length = int(self.headers.get("Content-Length", 0))
                body = json.loads(self.rfile.read(length) or b"{}")
                owner.requests.append(("POST", self.path))
                status, response = owner.post(self.path, body, self.headers.get("Content-Type", ""))
                self._send(status, response)

        self.server = ThreadingHTTPServer((host, port), Handler)
        self.url = f"http://{host}:{self.server.server_address[1]}"

    def start(self):
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        return self

    def stop(self):
        self.server.shutdown()
        self.server.server_close()

    def get(self, path):
        br = next(r for r in self.net["routers"] if r.get("br"))
        if path == "/node/dataset/active":
            return 200, ({"Channel": 15} if self.mode == "legacy" else {"channel": 15})
        if path == "/node":
            if self.mode == "legacy":
                return 200, {"NetworkName": "SimThread", "State": "leader", "Rloc16": br["rloc16"], "ExtAddress": br["ext"]}
            return 200, {"networkName": "SimThread", "state": "leader", "rloc16": br["rloc16"], "extAddress": br["ext"]}
        if self.mode == "legacy":
            if path == "/diagnostics":
                return 200, legacy_diagnostics(self.net)
            return 404, None
        if path == "/api/devices":
            return 200, {"data": api_devices(self.net)}
        if path.startswith("/api/actions/"):
            task = self.tasks.get(path.rsplit("/", 1)[1])
            return (200, {"data": task}) if task else (404, None)
        if path.startswith("/api/diagnostics/"):
            diag = self.diagnostics.get(path.rsplit("/", 1)[1])
            return (200, {"data": diag}) if diag else (404, None)
        return 404, None

    def post(self, path, body, content_type):
        if self.mode == "legacy" or path != "/api/actions":
            return 404, None
        if "application/vnd.api+json" not in content_type:
            return 415, None
        created = []
        for item in body.get("data", []):
            task_id = str(uuid.uuid4())
            task = {"id": task_id, "type": item["type"], "attributes": {**item["attributes"], "status": "completed"}}
            if item["type"] == "getEnergyScanTask":
                scan_id = str(uuid.uuid4())
                # Quiet channels, except Wi-Fi-like noise around 17-20 (Wi-Fi channel 6) and 24
                noise = {17: -62, 18: -55, 19: -58, 20: -66, 24: -70}
                report = [{"channel": c, "maxRssi": [noise.get(c, -94) + d for d in (0, -3, 2)]}
                          for c in item["attributes"].get("channelMask", range(11, 27))]
                self.diagnostics[scan_id] = {"id": scan_id, "type": "energyScanReport",
                                             "attributes": {"origin": item["attributes"].get("destination"),
                                                            "report": report}}
                task["relationships"] = {"result": {"data": {"type": "diagnostics", "id": scan_id}}}
            if item["type"] == "getNetworkDiagnosticTask":
                diag_id = str(uuid.uuid4())
                self.diagnostics[diag_id] = {"id": diag_id, "type": "threadNetworkDiagnostic",
                                             "attributes": api_diagnostic(self.net, item["attributes"]["destination"])}
                task["relationships"] = {"result": {"data": {"type": "diagnostics", "id": diag_id}}}
            self.tasks[task_id] = task
            created.append({"id": task_id, "type": item["type"], "attributes": {"status": "pending"}})
        return 200, {"data": created}
