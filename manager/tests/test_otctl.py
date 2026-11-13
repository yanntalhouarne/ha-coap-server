"""Reading the network through the border router's command line (ot-ctl in its Docker container).
The outputs are the real ones of an OTBR (ot-br-posix main, 2026-11) next to an older leader."""

import httpx
import pytest

from hacoap_manager import config
from hacoap_manager.app import create_app, create_services
from hacoap_manager.otbr import BorderRouterError
from hacoap_manager.otctl import CliBorderRouter, parse_diag_tlvs, parse_table, valid_container

CHANGE = {"X-HACoap": "1"}

ROUTER_TABLE = """\
| ID | RLOC16 | Next Hop | Path Cost | LQ In | LQ Out | Age | Extended MAC     | Link |
+----+--------+----------+-----------+-------+--------+-----+------------------+------+
| 16 | 0x4000 |       63 |         0 |     0 |      0 |   0 | 523194ec3f32d36f |    0 |
| 62 | 0xf800 |       63 |         0 |     3 |      3 |  38 | 1ad1ce7bd899afa6 |    1 |

Done
"""
NEIGHBOR_TABLE = """\
| Role | RLOC16 | Age | Avg RSSI | Last RSSI | LQ In |R|D|N| Extended MAC     | Version |
+------+--------+-----+----------+-----------+-------+-+-+-+------------------+---------+
|   C  | 0x4001 |   1 |      -70 |       -69 |     3 |0|0|0| 5a1ee4c0395bbe93 |       4 |
|   C  | 0x4002 |   0 |      -71 |       -71 |     3 |0|0|0| ce0ee1add2d95862 |       4 |
|   R  | 0xf800 |  38 |      -51 |       -51 |     3 |1|1|1| 1ad1ce7bd899afa6 |       4 |

Done
"""
CHILD_TABLE = """\
| ID  | RLOC16 | Timeout    | Age        | LQ In | C_VN |R|D|N|Ver|CSL|QMsgCnt|Suprvsn| Extended MAC     |
+-----+--------+------------+------------+-------+------+-+-+-+---+---+-------+-------+------------------+
|   1 | 0x4001 |        240 |          1 |     3 |  176 |0|0|0|  4| 0 |     0 |   129 | 5a1ee4c0395bbe93 |
|   2 | 0x4002 |        240 |          0 |     3 |  176 |0|0|0|  4| 0 |     0 |   129 | ce0ee1add2d95862 |

Done
"""
CHILD_IP = """\
4001: fd84:b787:982b:adb3:1c3d:d824:1c3e:4495
4001: fd2a:83c:28ba:1:8b89:6736:7a5d:f64b
4002: fd84:b787:982b:adb3:3341:1bfa:3b68:50ee
4002: fd2a:83c:28ba:1:0:c18f:4c26:9573
Done
"""
IPADDR = """\
fd84:b787:982b:adb3:0:ff:fe00:fc38
fd84:b787:982b:adb3:0:ff:fe00:4000
fd2a:83c:28ba:1:61b1:9e2a:1aca:b055
fe80:0:0:0:5031:94ec:3f32:d36f
Done
"""
LEADER_DIAG = ("00081ad1ce7bd899afa60102f80002010f050b150000800000000002f1010850fd2a083c28ba0001e6e5120650aa6a0c"
               "fd84b787982badb3000000fffe00fc00fd84b787982badb3000000fffe00f800fd84b787982badb3fdd06d6f6e4a0768"
               "fe8000000000000018d1ce7bd899afa61009660204660304660404")
OWN_DIAG = ("0008523194ec3f32d36f0102400002010f050b15000080000000000201f10870fd84b787982badb3000000fffe00fc38"
            "fd84b787982badb3000000fffe00fc11fd84b787982badb3000000fffe00fc10fd84b787982badb3000000fffe004000"
            "fd2a083c28ba000161b19e2a1acab055fd84b787982badb30ab23f1513cab492fe80000000000000503194ec3f32d36f"
            "1006660104660204")
DIAG_GET = f"""\
DIAG_GET.rsp/ans from fd84:b787:982b:adb3:0:ff:fe00:4000: {OWN_DIAG}
Ext Address: 523194ec3f32d36f
Rloc16: 0x4000
DIAG_GET.rsp/ans from fd84:b787:982b:adb3:0:ff:fe00:f800: {LEADER_DIAG}
Ext Address: 1ad1ce7bd899afa6
Rloc16: 0xf800
Done
"""
SCAN = """\
| Ch | RSSI |
+----+------+
| 11 |  -65 |
| 15 |  -41 |
| 26 |  -61 |
Done
"""

OUTPUTS = {
    ("state",): "router\nDone\n",
    ("extaddr",): "523194ec3f32d36f\nDone\n",
    ("rloc16",): "4000\nDone\n",
    ("networkname",): "ha-coap-ot\nDone\n",
    ("channel",): "15\nDone\n",
    ("leaderdata",): "Partition ID: 825447412\nWeighting: 64\nData Version: 111\nStable Data Version: 176\n"
                     "Leader Router ID: 62\nDone\n",
    ("ipaddr",): IPADDR,
    ("router", "table"): ROUTER_TABLE,
    ("neighbor", "table"): NEIGHBOR_TABLE,
    ("child", "table"): CHILD_TABLE,
    ("childip",): CHILD_IP,
    ("networkdiagnostic", "get", "ff03::2", "0", "1", "2", "5", "8", "16"): DIAG_GET,
    ("scan", "energy", "100"): SCAN,
}


def fake_ot_ctl(outputs=OUTPUTS):
    calls = []

    def run(args):
        calls.append(tuple(args))
        return outputs.get(tuple(args), "Error 35: InvalidCommand\n")

    run.calls = calls
    return run


def by_rloc(topology):
    return {n["rloc16_hex"]: n for n in topology["nodes"]}


def link(topology, a, b):
    nodes = by_rloc(topology)
    ids = {nodes[a]["id"], nodes[b]["id"]}
    return next(l for l in topology["links"] if {l["a"], l["b"]} == ids)


def test_tables():
    rows = parse_table(NEIGHBOR_TABLE.splitlines())
    assert rows[2] == {"Role": "R", "RLOC16": "0xf800", "Age": "38", "Avg RSSI": "-51", "Last RSSI": "-51",
                       "LQ In": "3", "R": "1", "D": "1", "N": "1", "Extended MAC": "1ad1ce7bd899afa6", "Version": "4"}
    assert parse_table(["Done"]) == []


def test_diagnostic_tlvs():
    diag = parse_diag_tlvs(LEADER_DIAG)
    assert diag["ext_address"] == "1ad1ce7bd899afa6" and diag["rloc16"] == 0xF800 and diag["mode"] == 0x0F
    assert diag["routes"] == [{"router_id": 16, "lq_out": 3, "lq_in": 3, "cost": 1},
                              {"router_id": 62, "lq_out": 0, "lq_in": 0, "cost": 1}]
    assert "fd2a:83c:28ba:1:e6e5:1206:50aa:6a0c" in diag["ipv6"] and "fe80::18d1:ce7b:d899:afa6" in diag["ipv6"]
    assert [c["child_id"] for c in diag["children"]] == [2, 3, 4]
    assert diag["children"][0] == {"timeout": 256, "link_quality": 3, "child_id": 2, "mode": 0x04}


def test_topology():
    run = fake_ot_ctl()
    topology = CliBorderRouter("otbr", run=run).topology().as_dict()
    assert topology["source"] == "cli"
    assert topology["border_router"] == {"network_name": "ha-coap-ot", "state": "router", "rloc16": "0x4000", "channel": 15}
    nodes = by_rloc(topology)
    assert set(nodes) == {"0x4000", "0xf800", "0x4001", "0x4002", "0xf802", "0xf803", "0xf804"}
    assert nodes["0x4000"]["border_router"] and nodes["0x4000"]["role"] == "router"
    assert nodes["0xf800"]["role"] == "leader" and nodes["0xf800"]["kind"] == "router"
    assert "fd2a:83c:28ba:1:e6e5:1206:50aa:6a0c" in nodes["0xf800"]["ipv6"]
    assert not any(a.startswith("fe80") for n in nodes.values() for a in n["ipv6"])
    # The border router's children: their addresses (short form, as the inventory keeps them) and signal
    assert nodes["0x4002"]["ipv6"] == ["fd2a:83c:28ba:1:0:c18f:4c26:9573", "fd84:b787:982b:adb3:3341:1bfa:3b68:50ee"]
    assert nodes["0x4001"]["kind"] == "SED" and nodes["0x4001"]["parent"] == nodes["0x4000"]["id"]
    assert nodes["0x4001"]["timeout"] == 240
    assert link(topology, "0x4001", "0x4000")["average_rssi"] == -70
    # The leader's children, from its diagnostics: link quality only
    assert nodes["0xf803"]["parent"] == nodes["0xf800"]["id"] and nodes["0xf803"]["kind"] == "SED"
    assert link(topology, "0xf803", "0xf800")["link_quality_in"] == 3
    # The link between the two routers, with the border router's own measure of it
    mesh = link(topology, "0x4000", "0xf800")
    assert (mesh["average_rssi"], mesh["link_quality_in"], mesh["link_quality_out"]) == (-51, 3, 3)
    assert len([l for l in topology["links"] if l["kind"] == "mesh"]) == 1
    assert not topology["warnings"]
    # One diagnostic query to every router, not one per router
    assert sum(1 for c in run.calls if c[0] == "networkdiagnostic") == 1


def test_a_router_that_does_not_answer():
    outputs = dict(OUTPUTS)
    outputs[("networkdiagnostic", "get", "ff03::2", "0", "1", "2", "5", "8", "16")] = \
        DIAG_GET.split("DIAG_GET.rsp/ans from fd84:b787:982b:adb3:0:ff:fe00:f800")[0] + "Done\n"
    topology = CliBorderRouter("otbr", run=fake_ot_ctl(outputs)).topology().as_dict()
    assert topology["warnings"] == ["No diagnostics from router 0xf800"]
    assert "0xf802" not in by_rloc(topology)


def test_errors():
    with pytest.raises(BorderRouterError, match="Error 35"):
        CliBorderRouter("otbr", run=fake_ot_ctl({})).topology()
    with pytest.raises(BorderRouterError, match="container name"):
        CliBorderRouter("otbr; rm -rf /")
    assert valid_container("otbr") and valid_container("ot-br_1.2")
    assert not valid_container("") and not valid_container("-it") and not valid_container("a b")


def test_energy_scan():
    scan = CliBorderRouter("otbr", run=fake_ot_ctl()).energy_scan(runs=2)
    assert scan == [{"channel": 11, "max_rssi": -65, "average_rssi": -65.0},
                    {"channel": 15, "max_rssi": -41, "average_rssi": -41.0},
                    {"channel": 26, "max_rssi": -61, "average_rssi": -61.0}]


async def test_the_container_setting_wins(tmp_path, monkeypatch):
    from hacoap_manager import network
    run = fake_ot_ctl()
    monkeypatch.setattr(network, "CliBorderRouter", lambda container: CliBorderRouter(container, run=run))
    services = create_services(tmp_path, discover=None)
    services.settings.border_router_url = "http://127.0.0.1:9"  # nothing there: not used
    app = create_app(services, background_tasks=False)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8710") as client:
        assert (await client.put("/api/settings", json={"border_router_container": "otbr; reboot"},
                                 headers=CHANGE)).status_code == 400
        assert (await client.put("/api/settings", json={"border_router_container": "otbr"},
                                 headers=CHANGE)).status_code == 200
        state = (await client.post("/api/network/refresh", headers=CHANGE)).json()
        assert state["border_router_container"] == "otbr"
        assert state["topology"]["source"] == "cli" and len(state["topology"]["nodes"]) == 7
    assert config.load_settings(tmp_path).border_router_container == "otbr"
    assert services.network.configured()
    services.db.close()
