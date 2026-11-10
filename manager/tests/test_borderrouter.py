"""The Border router tab's service: a fake `docker` (containers, images, ot-ctl inside) stands in
for the real one. The network's settings here are made up (never a real network key)."""

import io
import json
import zipfile

import httpx
import pytest

from hacoap_manager import backup, config
from hacoap_manager.app import create_app, create_services
from hacoap_manager.borderrouter import LATEST, BorderRouterService, BorderRouterSetupError, decode_dataset
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

    def __init__(self, container=True, latest=NEW, volume_dataset=DATASET):
        self.latest_pulled = OLD
        self.latest_remote = latest
        self.volume_dataset = volume_dataset  # what the border router's own data holds
        self.container = self._container(OLD, "eth0", RCP) if container else None
        self.calls = []

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
        answers = {("networkname",): "test-net", ("channel",): "15", ("panid",): "0x1234", ("extpanid",): "dead00beef00cafe",
                   ("version",): "OPENTHREAD/333f6d9; POSIX", ("rcp", "version"): "OPENTHREAD/d9abe3071; Zephyr",
                   ("br", "omrprefix"): "Local: fd2a:83c:28ba:1::/64\nFavored: fd2a:83c:28ba:1::/64 prf:low",
                   ("leaderdata",): "Partition ID: 825447412\nLeader Router ID: 62",
                   ("router", "table"): "| ID | RLOC16 |\n+----+--------+\n| 16 | 0x4000 |\n| 62 | 0xf800 |",
                   ("child", "table"): "| ID | RLOC16 |\n+----+--------+\n| 1 | 0x4001 |"}
        return answers.get(tuple(args), "Error 35: InvalidCommand") + "\nDone\n"


def service_with(tmp_path, docker):
    service = BorderRouterService(tmp_path, config.Settings(), EventBus(), run=docker)
    service.ready_timeout, service.poll_s = 0.3, 0.01
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
