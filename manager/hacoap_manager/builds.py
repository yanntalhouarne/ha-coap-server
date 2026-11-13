"""Firmware builds from the app: build profiles, checks, and a build runner.

A build runs the repository's own script (scripts/build.ps1 or scripts/build.sh), exactly as
from a terminal, with the profile's settings in a .conf file named by $HACOAP_EXTRA_CONF
(application/CMakeLists.txt merges it after local.conf). The image it makes goes into the
image library. One build at a time.
"""

import asyncio
import collections
import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

from . import kconfig, mcuboot
from .images import build_commit

VARIANTS = ("battery", "usb-logging", "uart-console", "debug")
PUBLIC_PSKD = "J01NU5"


def recipe(repository, variant, settings, sign_with, key_file):
    """What a build is made from, as a hash: the commit, any change not committed (the tracked
    files' diff, the new files), local.conf, the variant and settings, and the key it's signed
    with. None outside a git checkout: then it's always built."""
    def git(*args):
        return subprocess.run(["git", "-C", str(repository), *args], capture_output=True, timeout=60, check=True).stdout

    try:
        head = git("rev-parse", "HEAD")
        diff = git("diff", "HEAD", "--binary")
        new_files = sorted(name for name in git("ls-files", "--others", "--exclude-standard", "-z").split(b"\0") if name)
    except (OSError, subprocess.SubprocessError):
        return None
    digest = hashlib.sha256(head + diff)
    for name in new_files:
        digest.update(name)
        try:
            digest.update(hashlib.sha256((Path(repository) / name.decode("utf-8", "replace")).read_bytes()).digest())
        except OSError:
            pass
    for path in (Path(repository) / "application" / "local.conf", key_file):
        try:
            digest.update(hashlib.sha256(Path(path).read_bytes()).digest() if path else b"-")
        except OSError:
            digest.update(b"-")
    digest.update(json.dumps({"variant": variant, "settings": settings, "sign_with": sign_with}, sort_keys=True).encode())
    return digest.hexdigest()


class BuildError(Exception):
    pass


class AlreadyBuilt(BuildError):
    """Nothing changed since this build (the same commit, changes, settings and key), and its
    image is in the library: building again would make the same image."""

    def __init__(self, build):
        self.build = build
        when = time.strftime("%d %b %H:%M", time.localtime(build["started"]))
        super().__init__(f"Already built: build {build['id']} ({build['profile']}, {when}) made image "
                         f"{build['image_hash'][:8]}, and nothing changed since (the same commit, settings and key). "
                         "It's in the library (Images).")


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


# What a build is signed with: your private key, or MCUboot's public development key (in the SDK),
# for boards whose bootloader still has the development key
SIGN_WITH = ("yours", "development")


def development_key(repository):
    return repository / "external" / "bootloader" / "mcuboot" / "root-ec-p256.pem"


def signing_key(repository):
    """The private signing key the build will use, or None (development key)."""
    if os.environ.get("HACOAP_SIGNING_KEY"):
        path = Path(os.environ["HACOAP_SIGNING_KEY"])
        return path if path.is_file() else None
    path = repository / "application" / "keys" / "mcuboot-signing-key.pem"
    return path if path.is_file() else None


def checks(repository):
    """What a build needs, as a list of {name, ok, detail, required, optional, fix, link}."""
    if repository is None:
        return [{"name": "Firmware checkout", "ok": False, "required": True,
                 "detail": "Start the app from the ha-coap-server folder (or a folder inside it) to build firmware."}]
    result = [{"name": "Firmware checkout", "ok": True, "required": True, "detail": str(repository)}]
    nrfutil = find_nrfutil()
    result.append({"name": "nRF Connect toolchain", "ok": nrfutil is not None, "required": True, "fix": "install",
                   "detail": nrfutil or "nrfutil not found: run scripts/setup once (README → Building)."})
    sdk = (repository / "external" / "zephyr").is_dir()
    result.append({"name": "SDK", "ok": sdk, "required": True, "fix": "install",
                   "detail": "external/ is there" if sdk else "external/ is missing: run scripts/setup once."})
    key = signing_key(repository)
    result.append({"name": "Private signing key", "ok": key is not None, "required": False, "fix": "keygen",
                   "detail": str(key) if key else "None: images would be signed with MCUboot's public "
                   "development key, which boards with your bootloader refuse. Restore "
                   "application/keys/mcuboot-signing-key.pem from your backup, or create one with scripts/keygen."})
    local_conf = repository / "application" / "local.conf"
    pskd = kconfig.conf_values(local_conf.read_text(encoding="utf-8")).get("OPENTHREAD_JOINER_PSKD", "") \
        if local_conf.is_file() else ""
    pskd = pskd.strip('"')
    pskd_ok = bool(pskd) and pskd != PUBLIC_PSKD
    result.append({"name": "Private PSKd", "ok": pskd_ok, "required": False, "fix": "pskd",
                   "detail": "set in application/local.conf" if pskd_ok else
                   "Not set: new boards would join with the public default. See application/local.conf.example."})
    # Only for flashing new boards over SWD: optional, so a computer that only builds stays green.
    from . import swd
    device = swd.nrfutil_device_installed()
    result.append({"name": "SWD flashing tools", "ok": device, "required": False, "optional": True,
                   "fix": "device" if nrfutil else None,
                   "detail": "nrfutil device is installed" if device else
                   "For new boards only: nrfutil's 'device' command flashes a board over SWD (a J-Link)."
                   + ("" if nrfutil else " Install the build tools first.")})
    jlink = swd.find_jlink()
    result.append({"name": "J-Link software", "ok": jlink is not None, "required": False, "optional": True,
                   "detail": jlink or "For new boards only: SEGGER's J-Link Software and Documentation Pack, "
                   "which the SWD flashing tools use. Install it from SEGGER (it asks to accept their licence, "
                   "and installs a USB driver).", "link": None if jlink else swd.JLINK_DOWNLOAD})
    return result


def run_streaming(command, cwd, env, on_start, on_line):
    """Runs a command, calling on_line(text) for each line it prints. Returns its exit code.
    Its own process group, so kill_tree() can stop it with everything it started."""
    process = subprocess.Popen(
        command, cwd=str(cwd), env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL, encoding="utf-8", errors="replace", start_new_session=(sys.platform != "win32"))
    on_start(process)
    for line in process.stdout:
        on_line(line.rstrip("\r\n"))
    return process.wait()


def kill_tree(process):
    """Stops a process started by run_streaming(), and its children (toolchain, west, ninja)."""
    if sys.platform == "win32":
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(process.pid)], capture_output=True)
    else:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass


class BuildRunner:
    def __init__(self, repository, data_dir, db, images, events, command=script_command):
        self.repository = repository
        self.folder = Path(data_dir) / "builds"
        self.db = db
        self.images = images
        self.events = events
        self._command = command
        self.current = None      # the running build's record
        self._sign_with = "yours"  # what the running build was asked to sign with
        self.log = collections.deque(maxlen=5000)
        self._process = None
        self._cancelled = False
        self._done = None
        self.other_busy = lambda: None   # the setup runner's: "what's running", or None

    def schema(self):
        if self.repository is None:
            return []
        return kconfig.load_schema(self.repository)

    def checks(self):
        return checks(self.repository)

    def running(self):
        return self.current is not None and self.current["result"] == "running"

    def start(self, profile_name, allow_development_key=False, sign_with="yours", force=False):
        """sign_with: "yours" (the private key; without one, the development key if allowed), or
        "development" (MCUboot's development key, for boards whose bootloader still has it).
        Raises AlreadyBuilt when nothing changed since a build whose image is in the library,
        unless 'force'."""
        if sign_with not in SIGN_WITH:
            raise BuildError(f"Sign with {' or '.join(SIGN_WITH)}")
        if self.running():
            raise BuildError("A build is already running")
        if self.other_busy():
            raise BuildError(f"Wait for the {self.other_busy()} to finish")
        failed = [c for c in self.checks() if c["required"] and not c["ok"]]
        if failed:
            raise BuildError(f"{failed[0]['name']}: {failed[0]['detail']}")
        if sign_with == "development" and not development_key(self.repository).is_file():
            raise BuildError(f"MCUboot's development key isn't in the SDK ({development_key(self.repository)})")
        if sign_with == "yours" and signing_key(self.repository) is None and not allow_development_key:
            raise BuildError("No private signing key: the image would be signed with the public development key. "
                             "Confirm to build anyway (for a board flashed with the development key).")
        profile = self.db.profile(profile_name)
        if profile is None:
            raise BuildError("Unknown profile")
        schema = self.schema()
        settings = kconfig.validate(schema, profile["settings"])
        key_file = development_key(self.repository) if sign_with == "development" else \
            (signing_key(self.repository) or development_key(self.repository))
        made_from = recipe(self.repository, profile["variant"], settings, sign_with, key_file)
        if made_from and not force:
            before = self.db.build_made_from(made_from)
            if before and self.db.image(before["image_hash"]) is not None:
                raise AlreadyBuilt(before)

        self.folder.mkdir(parents=True, exist_ok=True)
        build_id = self.db.add_build(profile["name"], profile["variant"], settings, made_from)
        conf = self.folder / f"build-{build_id}.conf"
        conf.write_text(kconfig.to_conf(schema, settings, profile["name"]), encoding="utf-8")

        self.log.clear()
        self._cancelled = False
        self.current = self.db.build(build_id)
        self._done = asyncio.get_running_loop().create_future()
        loop = asyncio.get_running_loop()
        command = self._command(self.repository, profile["variant"])
        env = {**os.environ, "HACOAP_EXTRA_CONF": str(conf)}
        self._sign_with = sign_with
        if sign_with == "development":
            env["HACOAP_SIGNING_KEY"] = str(development_key(self.repository))
        threading.Thread(target=self._run, args=(loop, command, env, profile), daemon=True).start()
        self._publish()
        return self.current

    def cancel(self):
        if not self.running() or self._process is None:
            raise BuildError("No build is running")
        self._cancelled = True
        kill_tree(self._process)

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
            code = run_streaming(command, self.repository, env, lambda p: setattr(self, "_process", p),
                                 lambda line: loop.call_soon_threadsafe(self._line, line))
        except OSError as exc:
            loop.call_soon_threadsafe(self._line, f"Cannot start the build: {exc}")
            code = -1
        loop.call_soon_threadsafe(self._finish, code, profile)

    def _finish(self, code, profile):
        log = list(self.log)
        if self._sign_with == "development":
            signing = "development"  # asked for: the log names a key file either way
        else:
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
                                        f"{profile['name']} ({profile['variant']}{key}), built {when}",
                                        build_commit(build_dir(self.repository, profile["variant"])))
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
