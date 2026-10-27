"""Starting the app with the computer, in the background, so it keeps collecting readings,
network history and alerts. Per user, no admin rights:

- Windows: a value under HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run
- macOS: a LaunchAgent in ~/Library/LaunchAgents
- Linux: an XDG autostart entry in ~/.config/autostart (desktop sessions)
"""

import os
import plistlib
import re
import subprocess
import sys
from pathlib import Path

NAME = "HACoapFleetManager"
LABEL = "io.github.yanntalhouarne.hacoap-manager"
MANAGER_DIR = Path(__file__).resolve().parent.parent


def command(workdir, data_dir=None, port=None):
    """The command that starts this app in the background, as it runs now: the packaged app,
    or Python with the source (pythonw on Windows, so no console window opens)."""
    if getattr(sys, "frozen", False):
        args = [sys.executable]
    else:
        python = Path(sys.executable)
        windowless = python.with_name("pythonw.exe")
        if sys.platform == "win32" and windowless.exists():
            python = windowless
        args = [str(python), str(MANAGER_DIR / "run_manager.py")]
    args += ["--background", "--workdir", str(workdir)]
    if data_dir:
        args += ["--data-dir", str(data_dir)]
    if port:
        args += ["--port", str(port)]
    return args


def _desktop_exec(args):
    """An Exec= line: arguments with spaces or specials in double quotes, with ", `, $ and \\
    escaped (the desktop entry spec)."""
    def quote(arg):
        if re.fullmatch(r"[A-Za-z0-9_./:=+-]+", arg):
            return arg
        return '"' + re.sub(r'(["`$\\])', r"\\\1", arg) + '"'
    return " ".join(quote(a) for a in args)


def _macos_plist():
    return Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"


def _linux_desktop():
    config = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
    return config / "autostart" / "hacoap-manager.desktop"


def supported():
    return sys.platform in ("win32", "darwin") or sys.platform.startswith("linux")


def enabled():
    if sys.platform == "win32":
        import winreg
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run") as key:
                winreg.QueryValueEx(key, NAME)
                return True
        except OSError:
            return False
    if sys.platform == "darwin":
        return _macos_plist().exists()
    return _linux_desktop().exists()


def enable(args):
    if sys.platform == "win32":
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run", 0,
                            winreg.KEY_SET_VALUE) as key:
            winreg.SetValueEx(key, NAME, 0, winreg.REG_SZ, subprocess.list2cmdline(args))
    elif sys.platform == "darwin":
        path = _macos_plist()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(plistlib.dumps({"Label": LABEL, "ProgramArguments": args, "RunAtLoad": True,
                                         "ProcessType": "Background"}))
    else:
        path = _linux_desktop()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("[Desktop Entry]\nType=Application\nName=HA-CoAP Fleet Manager\n"
                        f"Exec={_desktop_exec(args)}\nX-GNOME-Autostart-enabled=true\nNoDisplay=true\n", encoding="utf-8")


def disable():
    if sys.platform == "win32":
        import winreg
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run", 0,
                                winreg.KEY_SET_VALUE) as key:
                winreg.DeleteValue(key, NAME)
        except FileNotFoundError:
            pass
    elif sys.platform == "darwin":
        _macos_plist().unlink(missing_ok=True)
    else:
        _linux_desktop().unlink(missing_ok=True)
