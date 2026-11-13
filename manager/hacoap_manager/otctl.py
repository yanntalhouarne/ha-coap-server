"""The Thread network's topology through the border router's command line (ot-ctl), for a
border router running next to this app in Docker (`docker exec <container> ot-ctl ...`).

Faster and steadier than the REST API: the border router's own tables (routers, neighbours
with RSSI, its children with their addresses) answer at once, and one network diagnostic
query to every router (ff03::2) brings back each router's routes and child table in about
5 s. The diagnostic answers are read from their bytes (the TLVs that the Thread specification
fixes), not from the CLI's text, which changes between versions.
"""

import ipaddress
import re
import shlex
import subprocess

from .otbr import ROUTER_ROLES, BorderRouterError, Topology, _hex16, _mode_kind

CONTAINER_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
ALL_ROUTERS = "ff03::2"
DIAG_TLVS = ("0", "1", "2", "5", "8", "16")  # ext address, RLOC16, mode, route, IPv6 addresses, child table

# MLE mode bits
MODE_RX_ON_WHEN_IDLE = 0x08
MODE_FULL_THREAD_DEVICE = 0x02

ERROR_LINE = re.compile(r"^Error \d+:")
DIAG_ANSWER = re.compile(r"^DIAG_GET\.rsp/ans from (\S+): ([0-9a-fA-F]+)\s*$")


def valid_container(name):
    return bool(CONTAINER_NAME.match(name or ""))


def parse_table(lines):
    """A '| a | b |' table as a list of dicts keyed by its header (flag columns like R|D|N included)."""
    rows = [line for line in lines if line.startswith("|")]
    if not rows:
        return []
    header = [cell.strip() for cell in rows[0].strip("|").split("|")]
    table = []
    for row in rows[1:]:
        cells = [cell.strip() for cell in row.strip("|").split("|")]
        if len(cells) == len(header):
            table.append(dict(zip(header, cells)))
    return table


def _int(value, default=None):
    try:
        return int(value, 0) if isinstance(value, str) else int(value)
    except (TypeError, ValueError):
        return default


def parse_diag_tlvs(hex_text):
    """A network diagnostic answer's TLVs: {ext_address, rloc16, mode, routes, ipv6, children}."""
    data = bytes.fromhex(hex_text)
    diag = {}
    i = 0
    while i + 2 <= len(data):
        kind, length = data[i], data[i + 1]
        i += 2
        if length == 0xFF:  # extended length
            length = int.from_bytes(data[i:i + 2], "big")
            i += 2
        value = data[i:i + length]
        i += length
        if kind == 0 and len(value) == 8:
            diag["ext_address"] = value.hex()
        elif kind == 1 and len(value) == 2:
            diag["rloc16"] = int.from_bytes(value, "big")
        elif kind == 2 and len(value) == 1:
            diag["mode"] = value[0]
        elif kind == 5 and len(value) >= 9:
            mask = value[1:9]
            router_ids = [byte * 8 + bit for byte in range(8) for bit in range(8) if mask[byte] & (0x80 >> bit)]
            diag["routes"] = [{"router_id": rid, "lq_out": b >> 6, "lq_in": (b >> 4) & 0x3, "cost": b & 0xF}
                              for rid, b in zip(router_ids, value[9:])]
        elif kind == 8:
            diag["ipv6"] = [str(ipaddress.IPv6Address(value[j:j + 16])) for j in range(0, len(value) - 15, 16)]
        elif kind == 16:
            children = []
            for j in range(0, len(value) - 2, 3):
                word = int.from_bytes(value[j:j + 2], "big")
                children.append({"timeout": 2 ** ((word >> 11) - 4) if word >> 11 >= 4 else 0,
                                 "link_quality": (word >> 9) & 0x3, "child_id": word & 0x1FF, "mode": value[j + 2]})
            diag["children"] = children
    return diag


def _address(text):
    """An IPv6 address in its short form (ot-ctl prints every group: fe80:0:0:0:...), as the
    inventory keeps them, so boards are named by their address."""
    try:
        return str(ipaddress.IPv6Address(text.strip()))
    except ValueError:
        return text.strip()


class CliBorderRouter:
    """Reads the network with ot-ctl inside the border router's Docker container."""

    def __init__(self, container, timeout=30.0, run=None):
        if not valid_container(container):
            raise BorderRouterError(f"'{container}' isn't a container name")
        self.container = container
        self.timeout = timeout
        self._run_command = run or self._subprocess

    # ------------------------------------------------------------ commands

    def _subprocess(self, args):
        command = ["docker", "exec", self.container, "ot-ctl", *args]
        try:
            done = subprocess.run(command, capture_output=True, text=True, timeout=self.timeout)
        except FileNotFoundError as exc:
            raise BorderRouterError("Docker isn't installed here, so the border router's command line can't be used") from exc
        except subprocess.TimeoutExpired as exc:
            raise BorderRouterError(f"ot-ctl {' '.join(args)}: no answer in {self.timeout:.0f} s") from exc
        if done.returncode != 0:
            reason = (done.stderr or done.stdout).strip().splitlines()
            raise BorderRouterError(f"Cannot run ot-ctl in the container '{self.container}': "
                                    f"{reason[-1] if reason else f'exit code {done.returncode}'}")
        return done.stdout

    def run(self, *args):
        """The lines a command prints, without its closing 'Done'. Raises on 'Error N: ...'."""
        lines = [line.rstrip() for line in self._run_command(list(args)).splitlines()]
        errors = [line for line in lines if ERROR_LINE.match(line)]
        if errors:
            raise BorderRouterError(f"ot-ctl {' '.join(shlex.quote(a) for a in args)}: {errors[0]}")
        return [line for line in lines if line and line != "Done"]

    def _value(self, *args):
        lines = self.run(*args)
        return lines[0].strip() if lines else ""

    # ------------------------------------------------------------ readings

    def node_info(self):
        return {"state": self._value("state"), "extAddress": self._value("extaddr"),
                "rloc16": "0x" + self._value("rloc16"), "networkName": self._value("networkname")}

    def channel(self):
        try:
            return _int(self._value("channel"))
        except BorderRouterError:
            return None

    def energy_scan(self, runs=3, duration_ms=100):
        """The radio noise on each channel, as the border router's own radio hears it:
        [{channel, max_rssi, average_rssi}], RSSI in dBm (higher is noisier)."""
        heard = {}
        for _ in range(runs):
            for row in parse_table(self.run("scan", "energy", str(duration_ms))):
                channel, rssi = _int(row.get("Ch")), _int(row.get("RSSI"))
                if channel is not None and rssi is not None:
                    heard.setdefault(channel, []).append(rssi)
        if not heard:
            raise BorderRouterError("The channel scan gave no results")
        return [{"channel": channel, "max_rssi": max(values), "average_rssi": round(sum(values) / len(values), 1)}
                for channel, values in sorted(heard.items())]

    def topology(self):
        topology = Topology("cli")
        state = self._value("state")
        own_ext = self._value("extaddr").lower()
        own_rloc16 = _int("0x" + self._value("rloc16"))
        leader_id = next((_int(line.split(":", 1)[1]) for line in self.run("leaderdata")
                          if line.startswith("Leader Router ID")), None)
        topology.border_router = {"network_name": self._value("networkname"), "state": state,
                                  "rloc16": _hex16(own_rloc16), "channel": self.channel()}
        own_ipv6 = [_address(a) for a in self.run("ipaddr") if not a.startswith("fe80")]
        is_router = state in ROUTER_ROLES
        me = topology.add_node(own_rloc16, own_ext, role=state, kind="router" if is_router else "",
                               ipv6=own_ipv6, border_router=True)

        neighbors = {row["Extended MAC"].lower(): row for row in parse_table(self.run("neighbor", "table"))}

        def signal(ext):
            row = neighbors.get(ext, {})
            return {"average_rssi": _int(row.get("Avg RSSI")), "last_rssi": _int(row.get("Last RSSI")),
                    "link_quality_in": _int(row.get("LQ In"))}

        # Every router, and the border router's own links to them
        for row in parse_table(self.run("router", "table")):
            rloc16, ext = _int(row.get("RLOC16")), row.get("Extended MAC", "").lower()
            router_id = _int(row.get("ID"))
            role = "leader" if router_id == leader_id else "router"
            node = topology.add_node(rloc16, ext, role=role, kind="router")
            if ext != own_ext and row.get("Link") == "1":
                topology.add_link(me["id"], node["id"], "mesh", link_quality_out=_int(row.get("LQ Out")), **signal(ext))

        # The border router's own children: addresses and signal
        child_ips = {}
        for line in self.run("childip"):
            rloc, _, address = line.partition(":")
            child_ips.setdefault(_int("0x" + rloc.strip()), []).append(_address(address))
        for row in parse_table(self.run("child", "table")):
            rloc16, ext = _int(row.get("RLOC16")), row.get("Extended MAC", "").lower()
            node = topology.add_node(rloc16, ext, role="child", parent=me["id"], ipv6=child_ips.get(rloc16),
                                     kind=_mode_kind(row.get("R") == "1", row.get("D") == "1"),
                                     timeout=_int(row.get("Timeout")))
            topology.add_link(node["id"], me["id"], "child", **signal(ext))

        # Every router's diagnostics at once: routes between routers, and their children
        answers = {}
        for line in self.run("networkdiagnostic", "get", ALL_ROUTERS, *DIAG_TLVS):
            match = DIAG_ANSWER.match(line)
            if match:
                diag = parse_diag_tlvs(match.group(2))
                if diag.get("rloc16") is not None:
                    answers[diag["rloc16"]] = diag
        for diag in answers.values():
            self._add_router_diagnostics(topology, diag)
        for node in list(topology.nodes.values()):
            if node["kind"] == "router" and node["rloc16"] not in answers:
                topology.warnings.append(f"No diagnostics from router {node['rloc16_hex']}")
        return topology

    @staticmethod
    def _add_router_diagnostics(topology, diag):
        rloc16 = diag["rloc16"]
        router = topology.add_node(rloc16, diag.get("ext_address"), kind="router",
                                   ipv6=[a for a in diag.get("ipv6", []) if not a.startswith("fe80")])
        for route in diag.get("routes", []):
            neighbor = route["router_id"] << 10
            if neighbor == rloc16 or not route["lq_in"] or not route["lq_out"]:
                continue  # itself, or no direct link
            other = topology.node(neighbor) or topology.add_node(neighbor, kind="router")
            topology.add_link(router["id"], other["id"], "mesh", link_quality_in=route["lq_in"],
                              link_quality_out=route["lq_out"])
        for child in diag.get("children", []):
            mode, child_rloc16 = child["mode"], rloc16 | child["child_id"]
            known = topology.node(child_rloc16)
            # The diagnostics round the timeout to a power of 2: the child table's exact one wins
            timeout = None if known and known.get("timeout") else (child["timeout"] or None)
            node = topology.add_node(child_rloc16, role="child", parent=router["id"], timeout=timeout,
                                     kind=_mode_kind(bool(mode & MODE_RX_ON_WHEN_IDLE), bool(mode & MODE_FULL_THREAD_DEVICE)))
            topology.add_link(node["id"], router["id"], "child", link_quality_in=child["link_quality"])
