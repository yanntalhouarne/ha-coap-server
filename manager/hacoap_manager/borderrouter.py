"""The Thread border router: OpenThread's border router in Docker on this machine, which the app
sets up, watches and updates.

- Its status: the container, the image it runs (pinned to an exact build), and its Thread network.
- Restart, and safe updates: the newest build is pulled and started on the same data, and if the
  border router isn't back as a router within READY_TIMEOUT_S, the previous build runs again.
- Its network's settings (the active dataset): kept in border-router.json, which is in the app's
  backups, so that a restore on another machine brings the border router back on the same
  network (and the boards with it). They can also be shown, and imported.
- Setting it up: the radio (a USB dongle with OpenThread's RCP firmware) and the network
  interface to choose from, then the container started with them.

It works through the `docker` command (the app's user must be in the docker group), and ot-ctl
inside the container. A container made by hand is adopted: its settings are read from it.
"""

import asyncio
import ipaddress
import json
import logging
import re
import subprocess
import time
from dataclasses import asdict, dataclass, fields
from pathlib import Path

from . import config as app_config
from .otbr import BorderRouterError
from .otctl import CliBorderRouter, parse_table

log = logging.getLogger(__name__)

CONFIG_FILE = "border-router.json"
IMAGE_REPO = "openthread/border-router"
LATEST = f"{IMAGE_REPO}:latest"
IMAGE_REF = re.compile(rf"^{re.escape(IMAGE_REPO)}(:[A-Za-z0-9_.-]{{1,128}})?(@sha256:[0-9a-f]{{64}})?$")
RCP_DEVICE = re.compile(r"^/dev/(serial/by-id/[A-Za-z0-9_.:+@-]{1,200}|tty(ACM|USB)[0-9]{1,3})$")
INTERFACE = re.compile(r"^[A-Za-z0-9_.-]{1,15}$")
DATASET_HEX = re.compile(r"^(?:[0-9a-fA-F]{2}){10,254}$")
DATA_VOLUME = "otbr-data"  # the border router's own state (/data/thread): kept across updates
READY_ROLES = ("router", "leader")
READY_TIMEOUT_S = 240
NOT_INTERFACES = ("lo", "docker", "veth", "br-", "wpan", "zt", "virbr", "tun", "tap")
WARNING_LINE = re.compile(r"\[(W|E|C)\]|\bWARN|\bERROR|\bCRIT|\bfail", re.IGNORECASE)

# The dataset's TLVs (Thread specification, MeshCoP)
DATASET_FIELDS = {0: "channel", 1: "pan_id", 2: "ext_pan_id", 3: "network_name", 4: "pskc", 5: "network_key",
                  7: "mesh_local_prefix", 12: "security_policy", 14: "active_timestamp", 53: "channel_mask"}
SECRET_FIELDS = ("network_key", "pskc")


class BorderRouterSetupError(Exception):
    pass


@dataclass
class BorderRouterConfig:
    container: str = "otbr"
    image: str = LATEST           # pinned to a build (repo@sha256:...) once known
    previous_image: str = ""      # the build before the last update, to go back to
    rcp_device: str = ""          # such as /dev/serial/by-id/usb-Nordic_..._Thread_Co-Processor_...-if00
    infra_if: str = ""            # the network interface towards the home network, such as eth0
    rest_listen: str = "127.0.0.1"
    dataset: str = ""             # the network's active dataset (hex): its settings, network key included
    dataset_saved: float = 0.0

    def public(self):
        """Without the network's settings (they're shown on their own, the key only on request)."""
        values = asdict(self)
        values.pop("dataset")
        values["has_dataset"] = bool(self.dataset)
        return values


def decode_dataset(hex_text):
    """The settings in an active dataset (hex): {network_name, channel, pan_id, ...}."""
    if not DATASET_HEX.match(hex_text or ""):
        raise BorderRouterSetupError("Not a Thread dataset (hex, as `ot-ctl dataset active -x` prints it)")
    data = bytes.fromhex(hex_text)
    values = {}
    i = 0
    while i + 2 <= len(data):
        kind, length = data[i], data[i + 1]
        value = data[i + 2:i + 2 + length]
        if len(value) != length:
            raise BorderRouterSetupError("The dataset is cut short")
        i += 2 + length
        name = DATASET_FIELDS.get(kind)
        if name == "channel" and length == 3:
            values[name] = int.from_bytes(value[1:], "big")
        elif name == "pan_id" and length == 2:
            values[name] = f"0x{int.from_bytes(value, 'big'):04x}"
        elif name == "network_name":
            values[name] = value.decode("utf-8", errors="replace")
        elif name == "mesh_local_prefix" and length == 8:
            values[name] = str(ipaddress.IPv6Network((value + bytes(8), 64)))
        elif name == "active_timestamp" and length == 8:
            values[name] = int.from_bytes(value[:6], "big")
        elif name:
            values[name] = value.hex()
    missing = [n for n in ("network_name", "channel", "pan_id", "ext_pan_id", "network_key") if n not in values]
    if missing:
        raise BorderRouterSetupError(f"The dataset has no {', '.join(missing)}")
    return values


class BorderRouterService:
    def __init__(self, data_dir, settings, events, run=None):
        self.data_dir = Path(data_dir)
        self.path = self.data_dir / CONFIG_FILE
        self.settings = settings
        self.events = events
        self._run = run or self._subprocess
        self.config = self._load()
        self.job = None
        self._task = None
        self.ready_timeout = READY_TIMEOUT_S  # how long a new or restarted border router has to be a router
        self.poll_s = 3.0

    # ------------------------------------------------------------ config

    def _load(self):
        config = BorderRouterConfig()
        try:
            values = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return config
        for f in fields(config):
            if f.name in values:
                setattr(config, f.name, type(getattr(config, f.name))(values[f.name]))
        return config

    def reload(self):
        """After a backup is restored: its border router settings."""
        self.config = self._load()

    def _save(self):
        self.path.write_text(json.dumps(asdict(self.config), indent=2), encoding="utf-8")
        try:
            self.path.chmod(0o600)  # the network key
        except OSError:
            pass

    # ------------------------------------------------------------ docker

    @staticmethod
    def _subprocess(args, timeout=60):
        try:
            done = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=timeout)
        except FileNotFoundError as exc:
            raise BorderRouterSetupError("Docker isn't installed here: run scripts/install-server.sh") from exc
        except subprocess.TimeoutExpired as exc:
            raise BorderRouterSetupError(f"docker {args[0]}: no answer in {timeout} s") from exc
        if done.returncode != 0:
            lines = (done.stderr or done.stdout).strip().splitlines()
            reason = lines[-1] if lines else f"exit code {done.returncode}"
            if "permission denied" in reason.lower():
                reason += " (this app's user must be in the docker group, then the app restarted)"
            raise BorderRouterSetupError(f"docker {args[0]}: {reason}")
        return done.stdout

    def docker(self, *args, timeout=60):
        return self._run(list(args), timeout=timeout)

    def _inspect(self, *args):
        try:
            return json.loads(self.docker(*args))[0]
        except BorderRouterSetupError:
            return None

    def cli(self):
        container = self.config.container
        return CliBorderRouter(container, run=lambda args: self.docker("exec", container, "ot-ctl", *args, timeout=30))

    # ------------------------------------------------------------ status

    def status(self):
        """Everything the tab shows. Never raises: what can't be read says why."""
        result = {"config": self.config.public(), "job": self.job, "docker": {"ok": False}, "container": None,
                  "thread": None, "image": None}
        try:
            version = self.docker("version", "--format", "{{.Server.Version}}", timeout=15).strip()
            result["docker"] = {"ok": True, "version": version}
        except BorderRouterSetupError as exc:
            result["docker"] = {"ok": False, "error": str(exc)}
            return result
        container = self._inspect("inspect", self.config.container)
        if container is None:
            return result
        if not self.path.exists():
            self._adopt(container)
        state = container.get("State", {})
        result["container"] = {"name": self.config.container, "running": bool(state.get("Running")),
                               "status": state.get("Status", ""), "started": state.get("StartedAt", ""),
                               "image": container.get("Config", {}).get("Image", "")}
        image = self._inspect("image", "inspect", container.get("Image", ""))
        if image:
            labels = (image.get("Config") or {}).get("Labels") or {}
            digests = [d for d in image.get("RepoDigests") or [] if d.startswith(IMAGE_REPO + "@")]
            result["image"] = {"digest": digests[0].split("@", 1)[1] if digests else "",
                               "created": image.get("Created", ""),
                               "revision": labels.get("org.opencontainers.image.revision", ""),
                               "version": labels.get("org.opencontainers.image.version", "")}
        if result["container"]["running"]:
            try:
                result["thread"] = self._thread_status()
            except BorderRouterError as exc:
                result["thread"] = {"error": str(exc)}
        result["config"] = self.config.public()  # with the network's settings just kept
        return result

    def _thread_status(self):
        cli = self.cli()
        thread = {"state": cli._value("state")}  # raises if ot-ctl doesn't answer at all

        def lines(*args):  # what a border router not on a network yet can't answer stays empty
            try:
                return cli.run(*args)
            except BorderRouterError:
                return []

        def value(*args):
            found = lines(*args)
            return found[0].strip() if found else ""

        leader = {}
        for line in lines("leaderdata"):
            key, _, number = line.partition(":")
            leader[key.strip()] = number.strip()
        omr = [line.split(":", 1)[1].split()[0] for line in lines("br", "omrprefix") if line.startswith("Local:")]
        thread.update(network_name=value("networkname"), channel=value("channel"), pan_id=value("panid"),
                      ext_pan_id=value("extpanid"), omr_prefix=omr[0] if omr else "",
                      border_routing=value("br", "state"), partition_id=leader.get("Partition ID", ""),
                      leader_router_id=leader.get("Leader Router ID", ""),
                      routers=len(parse_table(lines("router", "table"))),
                      children=len(parse_table(lines("child", "table"))),
                      rcp_version=value("rcp", "version"), version=value("version"))
        if thread["state"] in READY_ROLES + ("child",):
            self._keep_dataset(cli)
        return thread

    def _keep_dataset(self, cli):
        """Keeps the network's settings up to date in border-router.json (so in the backups)."""
        try:
            dataset = cli._value("dataset", "active", "-x")
        except BorderRouterError:
            return
        if DATASET_HEX.match(dataset) and dataset != self.config.dataset:
            self.config.dataset, self.config.dataset_saved = dataset, time.time()
            self._save()

    def _adopt(self, container):
        """A border router container made by hand: its settings, from the container."""
        env = dict(item.split("=", 1) for item in container.get("Config", {}).get("Env") or [] if "=" in item)
        devices = container.get("HostConfig", {}).get("Devices") or []
        image = self._inspect("image", "inspect", container.get("Image", "")) or {}
        digests = [d for d in image.get("RepoDigests") or [] if d.startswith(IMAGE_REPO + "@")]
        self.config.image = digests[0] if digests else container.get("Config", {}).get("Image", LATEST)
        self.config.rcp_device = devices[0].get("PathOnHost", "") if devices else ""
        self.config.infra_if = env.get("OT_INFRA_IF", "")
        self.config.rest_listen = env.get("OT_REST_LISTEN_ADDR", self.config.rest_listen)
        self._save()

    def logs(self, lines=300, warnings_only=False):
        text = self.docker("logs", "--tail", str(max(1, min(lines, 5000))), self.config.container, timeout=30)
        result = [line for line in text.splitlines() if line.strip()]
        if warnings_only:
            result = [line for line in result if WARNING_LINE.search(line)]
        return result

    # ------------------------------------------------------------ setting up

    def candidates(self):
        """The radios (serial devices) and network interfaces to choose from."""
        radios = []
        by_id = Path("/dev/serial/by-id")
        if by_id.is_dir():
            for path in sorted(by_id.iterdir()):
                radios.append({"path": str(path), "name": path.name, "target": str(path.resolve()),
                               "rcp": "Co-Processor" in path.name or "RCP" in path.name.upper()})
        known = {r["target"] for r in radios}
        for path in sorted(Path("/dev").glob("ttyACM*")) + sorted(Path("/dev").glob("ttyUSB*")):
            if str(path) not in known:
                radios.append({"path": str(path), "name": path.name, "target": str(path), "rcp": False})
        default = ""
        try:
            for line in Path("/proc/net/route").read_text().splitlines()[1:]:
                parts = line.split()
                if len(parts) > 2 and parts[1] == "00000000":
                    default = parts[0]
                    break
        except OSError:
            pass
        interfaces = []
        net = Path("/sys/class/net")
        if net.is_dir():
            for path in sorted(net.iterdir()):
                if path.name.startswith(NOT_INTERFACES):
                    continue
                try:
                    up = (path / "operstate").read_text().strip() == "up"
                except OSError:
                    up = False
                interfaces.append({"name": path.name, "up": up, "default": path.name == default})
        return {"radios": radios, "interfaces": interfaces, "config": self.config.public()}

    def _run_args(self, image):
        c = self.config
        return ["run", "-d", "--name", c.container, "--restart", "unless-stopped", "--network", "host", "--privileged",
                "-v", f"{DATA_VOLUME}:/data", "--device", f"{c.rcp_device}:/dev/ttyACM0",
                "-e", "OT_RCP_DEVICE=spinel+hdlc+uart:///dev/ttyACM0", "-e", f"OT_INFRA_IF={c.infra_if}",
                "-e", "OT_THREAD_IF=wpan0", "-e", "OT_LOG_LEVEL=6", "-e", f"OT_REST_LISTEN_ADDR={c.rest_listen}", image]

    def _recreate(self, image):
        if not IMAGE_REF.match(image):
            raise BorderRouterSetupError(f"'{image}' isn't an OpenThread border router image")
        if not RCP_DEVICE.match(self.config.rcp_device) or not INTERFACE.match(self.config.infra_if):
            raise BorderRouterSetupError("Choose the radio and the network interface first")
        try:
            self.docker("rm", "-f", self.config.container, timeout=60)
        except BorderRouterSetupError:
            pass  # there was none
        self.docker(*self._run_args(image), timeout=600)  # pulls the image if it isn't here

    def _wait_ready(self, roles=READY_ROLES):
        """Waits for the border router to be a router (or leader) with border routing running."""
        deadline = time.monotonic() + self.ready_timeout
        last = "not answering yet"
        while time.monotonic() < deadline:
            try:
                cli = self.cli()
                role = cli._value("state")
                last = f"Thread role: {role}"
                if role in roles and cli._value("br", "state") == "running":
                    return True, last
            except BorderRouterError as exc:
                last = str(exc)
            time.sleep(self.poll_s)
        return False, last

    def _wait_answering(self, timeout=90):
        """Waits for ot-ctl to answer in a new container. Returns its Thread role."""
        deadline = time.monotonic() + min(timeout, self.ready_timeout)
        last = "no answer"
        while time.monotonic() < deadline:
            try:
                return self.cli()._value("state")
            except BorderRouterError as exc:
                last = str(exc)
            time.sleep(self.poll_s)
        raise BorderRouterSetupError(f"The border router didn't start ({last}): see its log")

    def _digest_of(self, reference):
        image = self._inspect("image", "inspect", reference) or {}
        digests = [d for d in image.get("RepoDigests") or [] if d.startswith(IMAGE_REPO + "@")]
        return digests[0] if digests else ""

    def _apply_dataset(self, dataset):
        cli = self.cli()
        cli.run("thread", "stop")
        cli.run("dataset", "set", "active", dataset)
        cli.run("ifconfig", "up")
        cli.run("thread", "start")

    # ------------------------------------------------------------ jobs (one at a time, in the background)

    def _step(self, message):
        self.job["steps"].append({"time": time.time(), "message": message})
        self.job["message"] = message
        self.events.publish("border-router")

    def start_job(self, action, work):
        if self.job and self.job["state"] == "running":
            raise BorderRouterSetupError(f"Busy: {self.job['action']}")
        self.job = {"action": action, "state": "running", "message": "", "steps": [], "started": time.time()}
        self.events.publish("border-router")

        async def run():
            try:
                message = await asyncio.to_thread(work)
                self.job.update(state="done", message=message)
            except BorderRouterSetupError as exc:
                self.job.update(state="failed", message=str(exc))
            except Exception as exc:  # noqa: BLE001 - shown on the page
                log.exception("border router: %s", action)
                self.job.update(state="failed", message=f"{type(exc).__name__}: {exc}")
            self.job["ended"] = time.time()
            self.events.publish("border-router")

        self._task = asyncio.get_running_loop().create_task(run())
        return self.job

    def restart(self):
        def work():
            self._step("Restarting the container")
            self.docker("restart", self.config.container, timeout=120)
            self._step("Waiting for it to be a router again")
            ready, last = self._wait_ready()
            if not ready:
                raise BorderRouterSetupError(f"Restarted, but not back as a router yet ({last})")
            return f"Restarted: back on the network ({last})"
        return self.start_job("restart", work)

    def update(self):
        def work():
            current = self.config.image
            self._step(f"Downloading the newest build of {IMAGE_REPO}")
            self.docker("pull", LATEST, timeout=900)
            newest = self._digest_of(LATEST)
            if not newest:
                raise BorderRouterSetupError("Downloaded, but the image has no digest to pin")
            if newest == current:
                return "Already running the newest build"
            return self._switch(newest, current, "Updated")
        return self.start_job("update", work)

    def rollback(self):
        def work():
            if not self.config.previous_image:
                raise BorderRouterSetupError("No earlier build to go back to")
            return self._switch(self.config.previous_image, self.config.image, "Back on the earlier build")
        return self.start_job("rollback", work)

    def _switch(self, image, current, done):
        """Runs 'image' on the same data. If it isn't back as a router in time, 'current' again."""
        self._step(f"Starting {_short(image)}")
        self._recreate(image)
        self._step("Waiting for it to be a router again (up to 4 minutes)")
        ready, last = self._wait_ready()
        if ready:
            self.config.previous_image, self.config.image = current, image
            self._save()
            return f"{done}: {_short(image)} is on the network ({last})"
        self._step(f"Not back as a router ({last}): going back to {_short(current)}")
        self._recreate(current)
        ready_again, last_again = self._wait_ready()
        raise BorderRouterSetupError(
            f"{_short(image)} didn't come back as a router ({last}), so {_short(current)} runs again"
            + ("" if ready_again else f", but isn't back yet either ({last_again})"))

    def setup(self, rcp_device, infra_if):
        if not RCP_DEVICE.match(rcp_device or ""):
            raise BorderRouterSetupError("Choose the radio (a serial device)")
        if not INTERFACE.match(infra_if or ""):
            raise BorderRouterSetupError("Choose the network interface")

        def work():
            self.config.rcp_device, self.config.infra_if = rcp_device, infra_if
            self._save()
            self._step(f"Starting the border router ({_short(self.config.image)}) with {Path(rcp_device).name} on {infra_if}")
            self._recreate(self.config.image)
            if self.config.image == LATEST:
                pinned = self._digest_of(LATEST)
                if pinned:
                    self.config.image = pinned
                    self._save()
            # The app reads the network through this container from now on
            self.settings.border_router_container = self.config.container
            if self.config.rest_listen == "127.0.0.1":
                self.settings.border_router_url = "http://127.0.0.1:8081"
            app_config.save_settings(self.data_dir, self.settings)
            role = self._wait_answering()
            if role == "disabled":
                if not self.config.dataset:
                    return ("Running, but not on a network yet: import your network's settings "
                            "(from a backup, or another border router)")
                self._step("Joining your network with the saved settings")
                self._apply_dataset(self.config.dataset)
            self._step("Waiting for it to be a router (up to 4 minutes)")
            ready, last = self._wait_ready()
            if not ready:
                raise BorderRouterSetupError(f"Started, but not a router yet ({last})")
            return f"Running and on the network ({last})"
        return self.start_job("setup", work)

    # ------------------------------------------------------------ the network's settings

    def network_settings(self, reveal=False):
        """The network's settings, from the border router if it answers, else as last saved."""
        dataset, source = "", "saved"
        try:
            candidate = self.cli()._value("dataset", "active", "-x")
            if DATASET_HEX.match(candidate):
                dataset, source = candidate, "border router"
        except (BorderRouterError, BorderRouterSetupError):
            pass
        dataset = dataset or self.config.dataset
        if not dataset:
            return {"source": None, "saved": self.config.dataset_saved}
        values = decode_dataset(dataset)
        if not reveal:
            for name in SECRET_FIELDS:
                if name in values:
                    values[name] = None
        result = {"source": source, "saved": self.config.dataset_saved, "values": values}
        if reveal:
            result["dataset"] = dataset
        return result

    def import_dataset(self, dataset):
        dataset = (dataset or "").strip().replace(" ", "").replace("\n", "")
        values = decode_dataset(dataset)  # refuses what isn't one

        def work():
            self._step(f"Joining the network '{values['network_name']}' (channel {values['channel']})")
            self._apply_dataset(dataset)
            self.config.dataset, self.config.dataset_saved = dataset, time.time()
            self._save()
            self._step("Waiting for it to be a router (up to 4 minutes)")
            ready, last = self._wait_ready()
            if not ready:
                raise BorderRouterSetupError(f"Settings applied, but not a router yet ({last})")
            return f"On the network '{values['network_name']}' ({last})"
        return self.start_job("import", work)


def _short(image):
    """openthread/border-router@sha256:b8015f69... -> b8015f69 (or the tag)."""
    if "@sha256:" in image:
        return image.split("@sha256:", 1)[1][:8]
    return image.rsplit(":", 1)[-1] if ":" in image else image
