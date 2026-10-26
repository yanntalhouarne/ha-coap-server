"""Flashing a board over SWD with a J-Link: MCUboot and the application together (a build's
merged.hex), through nrfutil's 'device' command. A new board needs this once; after it, updates
go over USB or the air. It's also the way back for a board that no longer boots.

nrfutil 'device' needs SEGGER's J-Link software, which has its own licence and installs a USB
driver (admin rights on Windows): the app finds it, but leaves installing it to you.
"""

import glob
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

from .builds import VARIANTS, build_dir

# Keep: rewrite only what the firmware covers (MCUboot and the application), so the board keeps
# its Thread network (the settings partition). Everything: a new board, or a full reset; the
# board then has to join the network again.
ERASE_MODES = {"keep": "ERASE_RANGES_TOUCHED_BY_FIRMWARE", "all": "ERASE_ALL"}
SERIAL_NUMBER = re.compile(r"^[0-9A-Za-z]{1,32}$")
JLINK_DOWNLOAD = "https://www.segger.com/downloads/jlink/"


class SwdError(Exception):
    pass


def nrfutil_device_installed():
    """Whether nrfutil's 'device' command is installed (in nrfutil's own folder)."""
    home = Path(os.environ.get("NRFUTIL_HOME") or Path.home() / ".nrfutil")
    return (home / "bin" / ("nrfutil-device.exe" if sys.platform == "win32" else "nrfutil-device")).is_file()


def find_jlink():
    """The J-Link software's command-line tool, or None."""
    name = "JLink.exe" if sys.platform == "win32" else "JLinkExe"
    found = shutil.which(name)
    if found:
        return found
    if sys.platform == "win32":
        roots = [os.environ.get("ProgramFiles", r"C:\Program Files"), os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")]
        patterns = [os.path.join(root, "SEGGER", "JLink*", name) for root in roots]
    elif sys.platform == "darwin":
        patterns = [f"/Applications/SEGGER/JLink*/{name}"]
    else:
        patterns = [f"/opt/SEGGER/JLink*/{name}"]
    matches = sorted(m for pattern in patterns for m in glob.glob(pattern))
    return matches[-1] if matches else None


def hex_files(repository):
    """The builds that can be flashed: [{variant, path, modified, app}] (app: its update image,
    whose signature tells which key its bootloader takes)."""
    if repository is None:
        return []
    found = []
    for variant in VARIANTS:
        folder = build_dir(repository, variant) / "zephyr"
        merged = folder / "merged.hex"
        if merged.is_file():
            app = folder / "app_update.bin"
            found.append({"variant": variant, "path": merged, "modified": merged.stat().st_mtime,
                          "app": app if app.is_file() else None})
    return found


def parse_probes(output):
    """The J-Links in 'nrfutil --json device list' output: one JSON object per line, the
    devices in the last one ('task_end')."""
    devices = []
    for line in output.splitlines():
        try:
            message = json.loads(line)
        except ValueError:
            continue
        if isinstance(message, dict) and message.get("type") == "task_end":
            devices = ((message.get("data") or {}).get("data") or {}).get("devices") or []
    probes = []
    for device in devices:
        traits = device.get("traits") or {}
        serial = str(device.get("serialNumber") or "")
        if traits.get("jlink") and SERIAL_NUMBER.match(serial):
            probes.append({"serial": serial, "devkit": bool(traits.get("devkit"))})
    return probes


def probes(nrfutil, run=subprocess.run):
    """The J-Link probes connected to this computer."""
    try:
        result = run([nrfutil, "--json", "device", "list"], capture_output=True, text=True, timeout=60,
                     creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise SwdError(f"nrfutil didn't answer: {exc}")
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip().splitlines()
        raise SwdError("nrfutil couldn't list the probes" + (f": {detail[-1]}" if detail else ""))
    return parse_probes(result.stdout)


def flash_commands(nrfutil, hexfile, serial, erase):
    """The commands that flash 'hexfile' to the board on J-Link 'serial', then restart it.
    Erasing everything starts with a recover, which also unlocks a board whose debug port is
    locked (access port protection), as a new nRF52840 can be."""
    if not SERIAL_NUMBER.match(serial or ""):
        raise SwdError("Choose a J-Link")
    if erase not in ERASE_MODES:
        raise SwdError(f"Unknown erase mode {erase!r}")
    program = [nrfutil, "device", "program", "--firmware", str(hexfile), "--serial-number", serial,
               "--options", f"chip_erase_mode={ERASE_MODES[erase]},reset=RESET_SYSTEM"]
    if erase == "all":
        return [[nrfutil, "device", "recover", "--serial-number", serial], program]
    return [program]
