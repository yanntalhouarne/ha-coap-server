"""Setting up a PC to build the firmware, from the app: install the build tools (the
repository's scripts/setup), create the signing key (scripts/keygen), and set the PSKd
(application/local.conf). The scripts run exactly as from a terminal, with a live log.
"""

import asyncio
import collections
import os
import re
import secrets
import sys
import threading
import time

from .builds import kill_tree, run_streaming

PSKD_ALPHABET = "0123456789ABCDEFGHJKLMNPRSTUVWXY"  # Thread's: A-Z and 0-9 without I, O, Q, Z
PSKD_LINE = re.compile(r"^\s*CONFIG_OPENTHREAD_JOINER_PSKD\s*=.*$", re.MULTILINE)
TASKS = {
    "install": {"name": "build tools installation", "script": "setup"},
    "keygen": {"name": "signing key creation", "script": "keygen"},
}


class SetupError(Exception):
    pass


def generate_pskd(length=12):
    return "".join(secrets.choice(PSKD_ALPHABET) for _ in range(length))


def valid_pskd(pskd):
    return 6 <= len(pskd) <= 32 and all(c in PSKD_ALPHABET for c in pskd)


def script_command(repository, script):
    if sys.platform == "win32":
        return ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                str(repository / "scripts" / f"{script}.ps1")]
    return ["bash", str(repository / "scripts" / f"{script}.sh")]


class SetupRunner:
    def __init__(self, repository, events, command=script_command):
        self.repository = repository
        self.events = events
        self._command = command
        self.current = None   # {"task", "name", "state", "started", "finished", "message"}
        self.log = collections.deque(maxlen=5000)
        self._process = None
        self._cancelled = False
        self._done = None
        self.other_busy = lambda: None   # the build runner's: "what's running", or None

    def running(self):
        return self.current is not None and self.current["state"] == "running"

    def busy(self):
        return self.current["name"] if self.running() else None

    def start(self, task):
        if self.repository is None:
            raise SetupError("Start the app from the ha-coap-server folder to set up building")
        if task not in TASKS:
            raise SetupError(f"Unknown task {task!r}")
        if self.running():
            raise SetupError(f"The {self.current['name']} is still running")
        if self.other_busy():
            raise SetupError(f"Wait for the {self.other_busy()} to finish")
        if task == "keygen" and (self.repository / "application" / "keys" / "mcuboot-signing-key.pem").exists():
            raise SetupError("A signing key already exists. Replacing it would lock out the boards that use it, "
                             "so the app never does; delete it yourself if you really mean to.")
        loop = asyncio.get_running_loop()
        self.log.clear()
        self._cancelled = False
        self._done = loop.create_future()
        self.current = {"task": task, "name": TASKS[task]["name"], "state": "running", "started": time.time(),
                        "finished": None, "message": ""}
        command = self._command(self.repository, TASKS[task]["script"])
        threading.Thread(target=self._run, args=(loop, command), daemon=True).start()
        self._publish()
        return self.current

    def cancel(self):
        if not self.running() or self._process is None:
            raise SetupError("Nothing is running")
        self._cancelled = True
        kill_tree(self._process)

    async def wait(self):
        if self._done is not None:
            await self._done
        return self.current

    def state(self):
        return {"current": self.current, "log": list(self.log)}

    def _publish(self):
        self.events.publish("setup", setup=self.current)

    def _line(self, line):
        self.log.append(line)
        self.events.publish("setup-log", line=line)

    def _run(self, loop, command):
        try:
            code = run_streaming(command, self.repository, dict(os.environ), lambda p: setattr(self, "_process", p),
                                 lambda line: loop.call_soon_threadsafe(self._line, line))
        except OSError as exc:
            loop.call_soon_threadsafe(self._line, f"Cannot start it: {exc}")
            code = -1
        loop.call_soon_threadsafe(self._finish, code)

    def _finish(self, code):
        if self._cancelled:
            state, message = "cancelled", "Cancelled"
        elif code == 0:
            state, message = "done", "Done"
        else:
            state, message = "failed", f"Failed (exit code {code}). See the log."
        self.current.update(state=state, message=message, finished=time.time())
        self._process = None
        self._publish()
        if self._done is not None and not self._done.done():
            self._done.set_result(None)

    # ------------------------------------------------------------ the PSKd

    def set_pskd(self, pskd=None):
        """Writes the joiner PSKd into application/local.conf (created from local.conf.example
        if missing). A random one if 'pskd' is empty. Returns it."""
        if self.repository is None:
            raise SetupError("Start the app from the ha-coap-server folder")
        pskd = (pskd or generate_pskd()).strip().upper()
        if not valid_pskd(pskd):
            raise SetupError("A PSKd has 6 to 32 characters: A-Z and 0-9, without I, O, Q or Z")
        application = self.repository / "application"
        local = application / "local.conf"
        if local.exists():
            text = local.read_text(encoding="utf-8")
        else:
            example = application / "local.conf.example"
            text = example.read_text(encoding="utf-8") if example.exists() else ""
        line = f'CONFIG_OPENTHREAD_JOINER_PSKD="{pskd}"'
        text = PSKD_LINE.sub(line, text, count=1) if PSKD_LINE.search(text) else text.rstrip("\n") + "\n" + line + "\n"
        local.write_text(text, encoding="utf-8")
        return pskd
