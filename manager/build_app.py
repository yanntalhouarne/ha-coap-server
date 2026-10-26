"""Packages the fleet manager into one executable for this OS, in manager/dist/.

    python build_app.py

Needs the packages in requirements-dev.txt. Then check it with: dist/hacoap-manager --self-test
"""

import os
import sys
from pathlib import Path

import PyInstaller.__main__

HERE = Path(__file__).resolve().parent

PyInstaller.__main__.run([
    str(HERE / "run_manager.py"),
    "--name", "hacoap-manager",
    "--onefile",
    "--console",  # the window shows the address, and closing it stops the app
    "--noconfirm",
    "--clean",
    "--distpath", str(HERE / "dist"),
    "--workpath", str(HERE / "build"),
    "--specpath", str(HERE / "build"),
    "--add-data", f"{HERE / 'hacoap_manager' / 'static'}{os.pathsep}hacoap_manager/static",
    # The ha-coap logo; PyInstaller turns the PNG into Windows' .ico and macOS' .icns (with Pillow)
    "--icon", str(HERE / "packaging" / "app-icon.png"),
    "--collect-submodules", "uvicorn",
    "--collect-submodules", "websockets",
    "--collect-submodules", "smpclient",
    "--collect-submodules", "smp",
])
print(f"Built {HERE / 'dist' / ('hacoap-manager.exe' if sys.platform == 'win32' else 'hacoap-manager')}")
