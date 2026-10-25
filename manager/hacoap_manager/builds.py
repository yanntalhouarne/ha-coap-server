"""Firmware builds from the app: build profiles, checks, and a build runner.

A build runs the repository's own script (scripts/build.ps1 or scripts/build.sh), exactly as
from a terminal, with the profile's settings in a .conf file named by $HACOAP_EXTRA_CONF
(application/CMakeLists.txt merges it after local.conf). The image it makes goes into the
image library. One build at a time.
"""

import asyncio
import collections
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

from . import kconfig, mcuboot

VARIANTS = ("battery", "usb-logging", "uart-console", "debug")
PUBLIC_PSKD = "J01NU5"


class BuildError(Exception):
    pass


def build_dir(repository, variant):
    """Where the build scripts put a variant's build."""
    name = "build" if variant == "battery" else "build_" + variant.replace("-", "_")
    return repository / "application" / name


def script_command(repository, variant):
    """The command that builds 'variant' with the repository's script on this OS."""
    if sys.platform == "win32":
        return ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                str(repository / "scripts" / "build.ps1"), variant]
    return ["bash", str(repository / "scripts" / "build.sh"), variant]


def find_nrfutil():
    found = shutil.which("nrfutil")
    if found:
        return found
    candidates = [Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "nrfutil" / "nrfutil.exe",
                  Path.home() / ".local" / "bin" / "nrfutil"]
    return next((str(c) for c in candidates if c.is_file()), None)


def signing_key(repository):
    """The private signing key the build will use, or None (development key)."""
    if os.environ.get("HACOAP_SIGNING_KEY"):
        path = Path(os.environ["HACOAP_SIGNING_KEY"])
        return path if path.is_file() else None
    path = repository / "application" / "keys" / "mcuboot-signing-key.pem"
    return path if path.is_file() else None


def checks(repository):
    """What a build needs, as a list of {name, ok, detail, required}."""
    if repository is None:
        return [{"name": "Firmware checkout", "ok": False, "required": True,
                 "detail": "Start the app from the ha-coap-server folder (or a folder inside it) to build firmware."}]
    result = [{"name": "Firmware checkout", "ok": True, "required": True, "detail": str(repository)}]
    nrfutil = find_nrfutil()
    result.append({"name": "nRF Connect toolchain", "ok": nrfutil is not None, "required": True,
                   "detail": nrfutil or "nrfutil not found: run scripts/setup once (README → Building)."})
    sdk = (repository / "external" / "zephyr").is_dir()
    result.append({"name": "SDK", "ok": sdk, "required": True,
                   "detail": "external/ is there" if sdk else "external/ is missing: run scripts/setup once."})
    key = signing_key(repository)
    result.append({"name": "Private signing key", "ok": key is not None, "required": False,
                   "detail": str(key) if key else "None: images would be signed with MCUboot's public "
                   "development key, which boards with your bootloader refuse. Restore "
                   "application/keys/mcuboot-signing-key.pem from your backup, or create one with scripts/keygen."})
    local_conf = repository / "application" / "local.conf"
    pskd = kconfig.conf_values(local_conf.read_text(encoding="utf-8")).get("OPENTHREAD_JOINER_PSKD", "") \
        if local_conf.is_file() else ""
    pskd = pskd.strip('"')
    pskd_ok = bool(pskd) and pskd != PUBLIC_PSKD
    result.append({"name": "Private PSKd", "ok": pskd_ok, "required": False,
                   "detail": "set in application/local.conf" if pskd_ok else
                   "Not set: new boards would join with the public default. See application/local.conf.example."})
    return result


class BuildRunner:
    def __init__(self, repository, data_dir, db, images, events, command=script_command):
        self.repository = repository
        self.folder = Path(data_dir) / "builds"
        self.db = db
        self.images = images
        self.events = events
        self._command = command
        self.current = None      # the running build's record
        self.log = collections.deque(maxlen=5000)
        self._process = None
        self._cancelled = False
        self._done = None

    def schema(self):
        if self.repository is None:
            return []
        return kconfig.load_schema(self.repository)

    def checks(self):
        return checks(self.repository)

    def running(self):
        return self.current is not None and self.current["result"] == "running"

    def start(self, profile_name, allow_development_key=False):
        if self.running():
            raise BuildError("A build is already running")
        failed = [c for c in self.checks() if c["required"] and not c["ok"]]
        if failed:
            raise BuildError(f"{failed[0]['name']}: {failed[0]['detail']}")
        if signing_key(self.repository) is None and not allow_development_key:
            raise BuildError("No private signing key: the image would be signed with the public development key. "
                             "Confirm to build anyway (for a board flashed with the development key).")
        profile = self.db.profile(profile_name)
        if profile is None:
            raise BuildError("Unknown profile")
        schema = self.schema()
        settings = kconfig.validate(schema, profile["settings"])

        self.folder.mkdir(parents=True, exist_ok=True)
        build_id = self.db.add_build(profile["name"], profile["variant"], settings)
        conf = self.folder / f"build-{build_id}.conf"
        conf.write_text(kconfig.to_conf(schema, settings, profile["name"]), encoding="utf-8")

        self.log.clear()
        self._cancelled = False
        self.current = self.db.build(build_id)
        self._done = asyncio.get_running_loop().create_future()
        loop = asyncio.get_running_loop()
        command = self._command(self.repository, profile["variant"])
        env = {**os.environ, "HACOAP_EXTRA_CONF": str(conf)}
        threading.Thread(target=self._run, args=(loop, command, env, profile), daemon=True).start()
        self._publish()
        return self.current

    def cancel(self):
        if not self.running() or self._process is None:
            raise BuildError("No build is running")
        self._cancelled = True
        process = self._process
        if sys.platform == "win32":
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(process.pid)], capture_output=True)
        else:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass

    async def wait(self):
        if self._done is not None:
            await self._done
        return self.current

    def _publish(self):
        self.events.publish("build", build=self.current)

    def _line(self, line):
        self.log.append(line)
        self.events.publish("build-log", id=self.current["id"], line=line)

    def _run(self, loop, command, env, profile):
        """In a thread: runs the build, streaming its output to the event loop."""
        try:
            self._process = subprocess.Popen(
                command, cwd=str(self.repository), env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL, encoding="utf-8", errors="replace",
                start_new_session=(sys.platform != "win32"))
            for line in self._process.stdout:
                loop.call_soon_threadsafe(self._line, line.rstrip("\r\n"))
            code = self._process.wait()
        except OSError as exc:
            loop.call_soon_threadsafe(self._line, f"Cannot start the build: {exc}")
            code = -1
        loop.call_soon_threadsafe(self._finish, code, profile)

    def _finish(self, code, profile):
        log = list(self.log)
        signing = "private" if any("MCUboot signing key:" in l for l in log) else \
            "development" if any("No private signing key" in l for l in log) else "unknown"
        fields = {"finished": time.time(), "signing": signing, "log": "\n".join(log)}
        if self._cancelled:
            fields.update(result="cancelled", message="Cancelled")
        elif code != 0:
            fields.update(result="failed", message=f"The build failed (exit code {code}). See the log.")
        else:
            image_path = build_dir(self.repository, profile["variant"]) / "zephyr" / "app_update.bin"
            try:
                when = time.strftime("%Y-%m-%d %H:%M")
                key = "" if signing == "private" else ", DEVELOPMENT KEY"
                image = self.images.add(image_path.read_bytes(), image_path.name,
                                        f"{profile['name']} ({profile['variant']}{key}), built {when}")
                fields.update(result="done", message=f"Image v{image['version']} added to the library",
                              image_hash=image["hash"])
            except (OSError, mcuboot.ImageError) as exc:
                fields.update(result="failed", message=f"Built, but the image can't be read: {exc}")
        self.current = self.db.update_build(self.current["id"], **fields)
        self.current.pop("log", None)
        self._process = None
        self._publish()
        if self._done is not None and not self._done.done():
            self._done.set_result(None)
