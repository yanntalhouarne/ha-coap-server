"""The Border router tab's service: a fake `docker` (containers, images, ot-ctl inside) stands in
for the real one. The network's settings here are made up (never a real network key)."""

import asyncio
import io
import json
import zipfile

import httpx
import pytest

from hacoap_manager import backup, config
from hacoap_manager.app import create_app, create_services
from hacoap_manager.borderrouter import (LATEST, BorderRouterService, BorderRouterSetupError, dataset_tlvs, decode_dataset,
                                         pending_dataset)
from hacoap_manager.events import EventBus

CHANGE = {"X-HACoap": "1"}
FAKE_KEY = "00112233445566778899aabbccddeeff"


def tlv(kind, value):
    return bytes([kind, len(value)]) + value


def make_dataset(name="test-net", channel=15, pan_id=0x1234, key=FAKE_KEY):
    return (tlv(14, (1).to_bytes(6, "big") + b"\x00\x00") + tlv(0, b"\x00" + channel.to_bytes(2, "big"))
            + tlv(53, bytes.fromhex("0004001fffe0")) + tlv(2, bytes.fromhex("dead00beef00cafe"))
            + tlv(7, bytes.fromhex("fd00112233440000")) + tlv(5, bytes.fromhex(key)) + tlv(3, name.encode())
            + tlv(4, bytes(16)) + tlv(12, bytes.fromhex("02a0f7f8")) + tlv(1, pan_id.to_bytes(2, "big"))).hex()


DATASET = make_dataset()
OLD = "openthread/border-router@sha256:" + "b8" * 32
NEW = "openthread/border-router@sha256:" + "c9" * 32
BAD = "openthread/border-router@sha256:" + "0d" * 32
RCP = "/dev/serial/by-id/usb-Nordic_Semiconductor_ASA_Thread_Co-Processor_0123456789ABCDEF-if00"


class FakeDocker:
    """Docker with one border router container; ot-ctl answers like a border router on DATASET's
    network, unless its image is BAD (it never becomes a router)."""

    def __init__(self, container=True, latest=NEW, volume_dataset=DATASET, strict_leader=False):
        self.latest_pulled = OLD
        self.latest_remote = latest
        self.volume_dataset = volume_dataset  # what the border router's own data holds
        self.container = self._container(OLD, "eth0", RCP) if container else None
        self.calls = []
        self.commissioner = "disabled"
        self.joiners = []                     # (eui64, pskd, seconds)
        self.hosts = ["ha-coap-1a2b3c4d"]     # registered with SRP
        self.joins_after = None               # a board joins this many host listings after a joiner is added
        self.strict_leader = strict_leader    # takes a pending dataset only with the commissioner's session
        self.pending = ""
        self.switch_after = None              # the network switches after this many channel readings
        self.channel = 15

    @staticmethod
    def _container(image, infra, device):
        return {"image": image, "running": True, "infra": infra, "device": device}

    def _role(self):
        if not self.volume_dataset:
            return "disabled"
        return "detached" if self.container["image"] == BAD else "router"

    def __call__(self, args, timeout=60):
        self.calls.append(args)
        command = args[0]
        if command == "version":
            return "27.5.1\n"
        if command == "inspect":
            if not self.container:
                raise BorderRouterSetupError("docker inspect: No such object: otbr")
            c = self.container
            return json.dumps([{"State": {"Running": c["running"], "Status": "running", "StartedAt": "2026-11-10T02:24:30Z"},
                                "Image": "sha256:" + c["image"][-64:],
                                "Config": {"Image": c["image"], "Env": [f"OT_INFRA_IF={c['infra']}", "OT_REST_LISTEN_ADDR=127.0.0.1"]},
                                "HostConfig": {"Devices": [{"PathOnHost": c["device"], "PathInContainer": "/dev/ttyACM0"}]}}])
        if args[:2] == ["image", "inspect"]:
            ref = args[2]
            digest = self.latest_pulled if ref == LATEST else next(
                (d for d in (OLD, NEW, BAD) if ref in (d, "sha256:" + d[-64:])), None)
            if digest is None:
                raise BorderRouterSetupError(f"docker image: No such image: {ref}")
            return json.dumps([{"RepoDigests": [digest], "Created": "2026-11-10T01:54:07Z",
                                "Config": {"Labels": {"org.opencontainers.image.revision": "83ed278506e480e3"}}}])
        if command == "pull":
            self.latest_pulled = self.latest_remote
            return ""
        if command == "rm":
            self.container = None
            return ""
        if command == "run":
            image = args[-1]
            device = args[args.index("--device") + 1].split(":")[0]
            infra = next(a.split("=", 1)[1] for a in args if a.startswith("OT_INFRA_IF="))
            self.container = self._container(self.latest_pulled if image == LATEST else image, infra, device)
            return "abc123\n"
        if command == "restart":
            return ""
        if command == "logs":
            return "00:00:01.000 [I] Platform------: started\n00:00:02.000 [W] Mle-----------: no parent\n"
        if command == "exec":
            return self._ot_ctl(args[3:])
        raise AssertionError(f"unexpected docker {args}")

    def _ot_ctl(self, args):
        role = self._role()
        if args == ["state"]:
            return f"{role}\nDone\n"
        if args == ["br", "state"]:
            return ("running" if role == "router" else "disabled") + "\nDone\n"
        if args == ["dataset", "active", "-x"]:
            return f"{self.volume_dataset}\nDone\n" if self.volume_dataset else "Error 23: NotFound\n"
        if args[:3] == ["dataset", "set", "active"]:
            self.volume_dataset = args[3]
            return "Done\n"
        if args in (["thread", "stop"], ["thread", "start"], ["ifconfig", "up"]):
            return "Done\n"
        if role == "disabled":
            return "Error 13: InvalidState\n"
        # The commissioner, and boards joining
        if args == ["commissioner", "start"]:
            self.commissioner = "active"
            return "Done\n"
        if args == ["commissioner", "stop"]:
            self.commissioner = "disabled"
            return "Done\n"
        if args == ["commissioner", "state"]:
            return f"{self.commissioner}\nDone\n"
        if args == ["commissioner", "sessionid"]:
            return "4660\nDone\n"
        if args[:3] == ["commissioner", "joiner", "add"]:
            self.joiners.append(tuple(args[3:]))
            return "Done\n"
        if args == ["srp", "server", "host"]:
            if self.joins_after is not None and self.joiners:
                self.joins_after -= 1
                if self.joins_after == 0:
                    self.hosts.append("ha-coap-feedbeef")
            return "".join(f"{h}.default.service.arpa.\n    deleted: false\n" for h in self.hosts) + "Done\n"
        # A channel change: a pending dataset sent to the leader, then the switch
        if args[:4] == ["dataset", "mgmtsetcommand", "pending", "-x"]:
            with_session = "0b021234" in args[4]
            if not self.strict_leader or with_session:
                self.pending = args[4].replace("0b021234", "")
                self.switch_after = 2
            return "Done\n"
        if args == ["dataset", "pending", "-x"]:
            return f"{self.pending}\nDone\n" if self.pending else "Error 23: NotFound\n"
        if args == ["channel"]:
            if self.switch_after is not None:
                self.switch_after -= 1
                if self.switch_after <= 0:
                    tlvs = dict(dataset_tlvs(self.pending))
                    self.channel = int.from_bytes(tlvs[0][1:], "big")
                    self.pending, self.switch_after = "", None
            return f"{self.channel}\nDone\n"
        answers = {("networkname",): "test-net", ("panid",): "0x1234", ("extpanid",): "dead00beef00cafe",
                   ("version",): "OPENTHREAD/333f6d9; POSIX", ("rcp", "version"): "OPENTHREAD/d9abe3071; Zephyr",
                   ("br", "omrprefix"): "Local: fd2a:83c:28ba:1::/64\nFavored: fd2a:83c:28ba:1::/64 prf:low",
                   ("leaderdata",): "Partition ID: 825447412\nLeader Router ID: 62",
                   ("router", "table"): "| ID | RLOC16 |\n+----+--------+\n| 16 | 0x4000 |\n| 62 | 0xf800 |",
                   ("child", "table"): "| ID | RLOC16 |\n+----+--------+\n| 1 | 0x4001 |"}
        return answers.get(tuple(args), "Error 35: InvalidCommand") + "\nDone\n"


def service_with(tmp_path, docker):
    service = BorderRouterService(tmp_path, config.Settings(), EventBus(), run=docker)
    service.ready_timeout, service.poll_s, service.leader_wait_s = 0.3, 0.01, 0.2
    return service


async def finished(service):
    await service._task
    return service.job


def test_decode_dataset():
    values = decode_dataset(DATASET)
    assert (values["network_name"], values["channel"], values["pan_id"], values["ext_pan_id"]) == \
        ("test-net", 15, "0x1234", "dead00beef00cafe")
    assert values["mesh_local_prefix"] == "fd00:1122:3344::/64"
    assert values["network_key"] == FAKE_KEY
    with pytest.raises(BorderRouterSetupError):
        decode_dataset("hello")
    with pytest.raises(BorderRouterSetupError, match="network_key"):
        decode_dataset((tlv(3, b"x") + tlv(0, b"\x00\x00\x0f") + tlv(1, b"\x12\x34") + tlv(2, bytes(8))).hex())


def test_a_container_made_by_hand_is_adopted(tmp_path):
    service = service_with(tmp_path, FakeDocker())
    status = service.status()
    assert status["docker"] == {"ok": True, "version": "27.5.1"}
    assert status["config"]["image"] == OLD and status["config"]["rcp_device"] == RCP
    assert status["config"]["infra_if"] == "eth0" and status["config"]["has_dataset"]
    assert "dataset" not in status["config"]  # the network key isn't in the status
    thread = status["thread"]
    assert (thread["state"], thread["network_name"], thread["omr_prefix"], thread["routers"], thread["children"]) == \
        ("router", "test-net", "fd2a:83c:28ba:1::/64", 2, 1)
    assert status["image"]["revision"].startswith("83ed278")
    # Its network's settings are kept, for the backups
    assert json.loads((tmp_path / "border-router.json").read_text())["dataset"] == DATASET


def test_no_docker(tmp_path):
    def missing(args, timeout=60):
        raise BorderRouterSetupError("Docker isn't installed here: run scripts/install-server.sh")
    status = service_with(tmp_path, missing).status()
    assert not status["docker"]["ok"] and "install-server" in status["docker"]["error"]


async def test_update(tmp_path):
    docker = FakeDocker()
    service = service_with(tmp_path, docker)
    service.status()
    service.update()
    job = await finished(service)
    assert job["state"] == "done", job
    assert (service.config.image, service.config.previous_image) == (NEW, OLD)
    assert docker.container["image"] == NEW
    # Pinned: what runs is the digest, not "latest"
    assert any(call[0] == "run" and call[-1] == NEW for call in docker.calls)

    # Already the newest: nothing restarted
    runs = sum(1 for call in docker.calls if call[0] == "run")
    service.update()
    assert (await finished(service))["message"] == "Already running the newest build"
    assert sum(1 for call in docker.calls if call[0] == "run") == runs

    service.rollback()
    assert (await finished(service))["state"] == "done"
    assert (service.config.image, service.config.previous_image, docker.container["image"]) == (OLD, NEW, OLD)


async def test_an_update_that_does_not_come_back_is_undone(tmp_path):
    docker = FakeDocker(latest=BAD)
    service = service_with(tmp_path, docker)
    service.status()
    service.update()
    job = await finished(service)
    assert job["state"] == "failed"
    assert "didn't come back as a router" in job["message"] and "runs again" in job["message"]
    assert docker.container["image"] == OLD
    assert (service.config.image, service.config.previous_image) == (OLD, "")


async def test_one_job_at_a_time(tmp_path):
    service = service_with(tmp_path, FakeDocker())
    service.status()
    service.restart()
    with pytest.raises(BorderRouterSetupError, match="Busy"):
        service.update()
    assert (await finished(service))["state"] == "done"


async def test_setting_up_on_a_new_computer_joins_the_saved_network(tmp_path):
    # A backup restored here: the network's settings, but no container, and a border router
    # whose own data is empty
    (tmp_path / "border-router.json").write_text(json.dumps({"dataset": DATASET, "image": OLD}))
    docker = FakeDocker(container=False, volume_dataset="")
    service = service_with(tmp_path, docker)
    assert service.status()["container"] is None
    with pytest.raises(BorderRouterSetupError, match="radio"):
        service.setup("/etc/passwd", "eth0")
    with pytest.raises(BorderRouterSetupError, match="interface"):
        service.setup(RCP, "eth0; reboot")
    service.setup(RCP, "ens18")
    job = await finished(service)
    assert job["state"] == "done", job
    assert any("saved settings" in step["message"] for step in job["steps"])
    assert docker.volume_dataset == DATASET and docker.container["infra"] == "ens18"
    # The app reads the network through it from now on
    assert service.settings.border_router_container == "otbr"
    assert config.load_settings(tmp_path).border_router_url == "http://127.0.0.1:8081"


async def test_setting_up_without_a_network(tmp_path):
    docker = FakeDocker(container=False, volume_dataset="")
    service = service_with(tmp_path, docker)
    service.setup(RCP, "eth0")
    job = await finished(service)
    assert job["state"] == "done" and "import your network's settings" in job["message"]
    # Pinned to the build it started with
    assert service.config.image == OLD


async def test_network_settings(tmp_path):
    docker = FakeDocker()
    service = service_with(tmp_path, docker)
    hidden = service.network_settings()
    assert hidden["source"] == "border router" and hidden["values"]["network_key"] is None and "dataset" not in hidden
    shown = service.network_settings(reveal=True)
    assert shown["values"]["network_key"] == FAKE_KEY and shown["dataset"] == DATASET

    with pytest.raises(BorderRouterSetupError):
        service.import_dataset("not a dataset")
    other = make_dataset(name="other-net", channel=20)
    service.import_dataset(other)
    job = await finished(service)
    assert job["state"] == "done" and "other-net" in job["message"]
    assert docker.volume_dataset == other and service.config.dataset == other

    # Not answering: as saved
    def down(args, timeout=60):
        raise BorderRouterSetupError("docker exec: not running")
    service._run = down
    saved = service.network_settings()
    assert saved["source"] == "saved" and saved["values"]["network_name"] == "other-net"


async def test_boards_join_over_the_air(tmp_path):
    docker = FakeDocker()
    docker.joins_after = 2
    service = service_with(tmp_path, docker)
    joined = []

    async def discover():
        joined.append("discovered")
    service.on_board_joined = discover
    for wrong in ("J01NU", "j01nuO", "ABC DEF", "X" * 33):
        with pytest.raises(BorderRouterSetupError, match="PSKd"):
            service.commission(wrong)
    with pytest.raises(BorderRouterSetupError, match="EUI-64"):
        service.commission("J01NU5", eui64="12:34")
    with pytest.raises(BorderRouterSetupError, match="minutes"):
        service.commission("J01NU5", minutes=60)

    service.commission("j01nu5", minutes=5)  # capitals or not
    for _ in range(200):
        await asyncio.sleep(0.01)
        if "ha-coap-feedbeef" in docker.hosts and joined:
            break
    assert docker.joiners == [("*", "J01NU5", "300")]
    assert docker.commissioner == "active"
    service.stop_commissioning()
    job = await finished(service)
    assert job["state"] == "done" and "1 board joined (ha-coap-feedbeef)" in job["message"]
    assert joined == ["discovered"]                  # added to the app
    assert docker.commissioner == "disabled"         # stopped at the end
    assert "J01NU5" not in json.dumps(job)           # the PSKd isn't kept anywhere
    assert "J01NU5" not in (tmp_path / "border-router.json").read_text() if (tmp_path / "border-router.json").exists() else True
    with pytest.raises(BorderRouterSetupError):
        service.stop_commissioning()


async def test_only_one_board(tmp_path):
    docker = FakeDocker()
    service = service_with(tmp_path, docker)
    service.commission("J01NU5", minutes=5, eui64="F4CE365FBC183EFA")
    await asyncio.sleep(0.05)
    service.stop_commissioning()
    job = await finished(service)
    assert docker.joiners == [("f4ce365fbc183efa", "J01NU5", "300")] and "no board joined" in job["message"]


def test_the_pending_dataset():
    pending = pending_dataset(DATASET, 20, 300, now=1794282000)
    before, after = dict(dataset_tlvs(DATASET)), dict(dataset_tlvs(pending))
    assert int.from_bytes(after[0][1:], "big") == 20                        # the new channel
    assert int.from_bytes(after[14][:6], "big") == int.from_bytes(before[14][:6], "big") + 1  # newer
    assert int.from_bytes(after[51][:6], "big") == 1794282000              # pending timestamp
    assert int.from_bytes(after[52], "big") == 300000                      # the delay, in ms
    for kind in (1, 2, 3, 5, 7, 12, 53):                                    # the rest as it is
        assert after[kind] == before[kind]
    # Asked again: still one pending timestamp and one delay
    again = dict(dataset_tlvs(pending_dataset(pending, 21, 120, now=1794282100)))
    assert int.from_bytes(again[52], "big") == 120000 and len(dataset_tlvs(pending_dataset(pending, 21, 120))) == len(after)


@pytest.mark.parametrize("strict", [False, True])
async def test_moving_to_another_channel(tmp_path, strict):
    docker = FakeDocker(strict_leader=strict)
    service = service_with(tmp_path, docker)
    with pytest.raises(BorderRouterSetupError, match="11 to 26"):
        service.change_channel(27)
    with pytest.raises(BorderRouterSetupError, match="delay"):
        service.change_channel(20, delay_s=30)
    service.change_channel(20, delay_s=120)
    job = await finished(service)
    assert job["state"] == "done", job
    assert docker.channel == 20 and "on channel 20" in job["message"]
    steps = " ".join(step["message"] for step in job["steps"])
    assert "from channel 15 to 20 in 2 minutes" in steps
    assert ("asking again as the network's commissioner" in steps) == strict
    assert docker.commissioner == "disabled"


async def test_a_change_the_leader_refuses(tmp_path):
    docker = FakeDocker(strict_leader=True)
    service = service_with(tmp_path, docker)
    docker._ot_ctl = (lambda original: lambda args: "Error 13: InvalidState\n"
                      if args == ["commissioner", "sessionid"] else original(args))(docker._ot_ctl)
    service.change_channel(20, delay_s=120)
    job = await finished(service)
    assert job["state"] == "failed" and "stays on channel 15" in job["message"]
    assert docker.channel == 15


async def test_already_on_that_channel(tmp_path):
    service = service_with(tmp_path, FakeDocker())
    service.change_channel(15, delay_s=120)
    assert "already on channel 15" in (await finished(service))["message"]


def test_logs(tmp_path):
    service = service_with(tmp_path, FakeDocker())
    assert len(service.logs()) == 2
    assert service.logs(warnings_only=True) == ["00:00:02.000 [W] Mle-----------: no parent"]


def test_the_backup_carries_the_border_router(tmp_path):
    source, target = tmp_path / "old", tmp_path / "new"
    services = create_services(source, discover=None)
    services.border_router._run = FakeDocker()
    services.border_router.status()  # adopts it, and keeps the dataset
    data = backup.create_backup(source, services.db, services.settings)
    assert "border-router.json" in zipfile.ZipFile(io.BytesIO(data)).namelist()
    services.db.close()

    fresh = create_services(target, discover=None)
    assert not fresh.border_router.config.dataset
    backup.restore_backup(data, target, fresh.db, fresh.settings)
    fresh.border_router.reload()
    assert fresh.border_router.config.dataset == DATASET and fresh.border_router.config.rcp_device == RCP
    fresh.db.close()


async def test_api(tmp_path):
    services = create_services(tmp_path, discover=None)
    services.border_router._run = FakeDocker()
    services.border_router.ready_timeout, services.border_router.poll_s = 0.3, 0.01
    app = create_app(services, background_tasks=False)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8710") as client:
        status = (await client.get("/api/border-router")).json()
        assert status["thread"]["state"] == "router"
        network = (await client.get("/api/border-router/network")).json()
        assert network["values"]["network_key"] is None
        assert (await client.post("/api/border-router/network/reveal")).status_code == 403  # the app's header
        revealed = (await client.post("/api/border-router/network/reveal", headers=CHANGE)).json()
        assert revealed["dataset"] == DATASET
        assert (await client.get("/api/border-router/logs?warnings=true")).json()["lines"][0].endswith("no parent")
        assert (await client.post("/api/border-router/reboot", headers=CHANGE)).status_code == 404
        assert (await client.post("/api/border-router/setup", json={"rcp_device": "/dev/sda", "infra_if": "eth0"},
                                  headers=CHANGE)).status_code == 400
        job = (await client.post("/api/border-router/update", headers=CHANGE)).json()
        assert job["state"] == "running"
        assert (await client.post("/api/border-router/restart", headers=CHANGE)).status_code == 409
        await services.border_router._task
        assert (await client.get("/api/border-router")).json()["config"]["image"] == NEW
        candidates = (await client.get("/api/border-router/candidates")).json()
        assert set(candidates) == {"radios", "interfaces", "config"}
    services.db.close()


async def test_api_joining_and_channel(tmp_path):
    services = create_services(tmp_path, discover=None)
    docker = FakeDocker()
    services.border_router._run = docker
    br = services.border_router
    br.ready_timeout, br.poll_s, br.leader_wait_s = 0.3, 0.01, 0.2
    app = create_app(services, background_tasks=False)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8710") as client:
        assert (await client.post("/api/border-router/commission", json={"pskd": "bad"}, headers=CHANGE)).status_code == 400
        assert (await client.post("/api/border-router/commission/stop", headers=CHANGE)).status_code == 400
        job = (await client.post("/api/border-router/commission", json={"pskd": "J01NU5", "minutes": 5},
                                 headers=CHANGE)).json()
        assert job["action"] == "commission" and "J01NU5" not in json.dumps(job)
        assert (await client.post("/api/border-router/channel", json={"channel": 20}, headers=CHANGE)).status_code == 409
        await asyncio.sleep(0.05)
        assert (await client.get("/api/border-router")).json()["thread"]["commissioner"] == "active"
        assert (await client.post("/api/border-router/commission/stop", headers=CHANGE)).status_code == 200
        await br._task
        assert (await client.post("/api/border-router/channel", json={"channel": 99}, headers=CHANGE)).status_code == 400
        assert (await client.post("/api/border-router/channel", json={"channel": "x"}, headers=CHANGE)).status_code == 400
        assert (await client.post("/api/border-router/channel", json={"channel": 20, "delay_s": 120},
                                  headers=CHANGE)).status_code == 200
        await asyncio.sleep(0.02)
        pending = (await client.get("/api/border-router")).json()["thread"]["pending"]
        assert pending is None or pending == {"channel": 20, "delay_s": 120}
        await br._task
        assert br.job["state"] == "done" and docker.channel == 20
    services.db.close()
