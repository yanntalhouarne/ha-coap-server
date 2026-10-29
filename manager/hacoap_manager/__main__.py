"""Starts the fleet manager: the local web server, then the browser.

    python -m hacoap_manager [--port 8710] [--data-dir DIR] [--no-browser] [--background]

If the app already runs (same data folder, on that port), this opens it in the browser instead
of starting a second one. --background starts it without a browser or console window, logging
to hacoap-manager.log in the data folder (that's how it starts with the computer).

--self-test starts the server on a free port, checks that it answers, and exits (used to
check the packaged app in CI).
"""

import argparse
import asyncio
import json
import logging
import os
import socket
import sys
import tempfile
import threading
import urllib.request
import webbrowser

from pathlib import Path

import uvicorn

from . import __version__
from .app import create_app, create_services
from .config import default_data_dir

DEFAULT_PORT = 8710
LOG_NAME = "hacoap-manager.log"
LOG_MAX = 2 * 1024 * 1024


def _free_port(preferred):
    """'preferred' if it's free, else the next free one, else any."""
    for port in list(range(preferred, preferred + 10)) + [0]:
        with socket.socket() as sock:
            try:
                sock.bind(("127.0.0.1", port))
                return sock.getsockname()[1]
            except OSError:
                continue
    raise OSError("no free port")


def _running_instance(port, data_dir):
    """The address of this app already running on 'port' with the same data folder, or None."""
    url = f"http://127.0.0.1:{port}/"
    try:
        with urllib.request.urlopen(url + "api/status", timeout=2) as response:
            status = json.loads(response.read())
    except (OSError, ValueError):
        return None
    try:
        same = os.path.samefile(status.get("data_dir", ""), data_dir)
    except OSError:
        same = False
    return url if same else None


def _log_to_file(folder, name=LOG_NAME):
    """In the background there's no console: print and log into the data folder (the previous
    file kept as .old once it's over 2 MB)."""
    path = Path(folder) / name
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.stat().st_size > LOG_MAX:
        path.replace(path.with_suffix(".log.old"))
    handle = open(path, "a", encoding="utf-8", buffering=1)  # noqa: SIM115 - open for the app's lifetime
    sys.stdout = sys.stderr = handle
    if sys.platform == "win32":
        import ctypes
        ctypes.windll.kernel32.FreeConsole()  # the packaged app is a console program: hide its window
    return path


def main(argv=None):
    parser = argparse.ArgumentParser(prog="hacoap-manager", description="HA-CoAP Fleet Manager")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"port on 127.0.0.1 (default {DEFAULT_PORT})")
    parser.add_argument("--data-dir", default=None, help=f"data folder (default {default_data_dir()})")
    parser.add_argument("--no-browser", action="store_true", help="don't open the browser")
    parser.add_argument("--background", action="store_true",
                        help="no browser and no console window; log to the data folder (for starting with the computer)")
    parser.add_argument("--workdir", default=None, help="work from this folder (a ha-coap-server checkout, for builds)")
    parser.add_argument("--demo", action="store_true",
                        help="the demo: simulated boards and border router, in a throwaway data folder")
    parser.add_argument("--self-test", action="store_true", help="start, check that the server answers, and exit")
    parser.add_argument("--version", action="version", version=__version__)
    args = parser.parse_args(argv)
    if args.workdir:
        os.chdir(args.workdir)
    data_dir = args.data_dir or default_data_dir()
    if args.demo:
        data_dir = tempfile.mkdtemp(prefix="hacoap-manager-demo-")
    if args.background:
        if args.demo:  # outside its data folder, which goes when it stops (an open file couldn't)
            _log_to_file(tempfile.gettempdir(), "hacoap-manager-demo.log")
        else:
            _log_to_file(data_dir)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    # smpclient warns about every answer from Zephyr 3.3's older SMP version: expected, not useful
    for name in ("smp", "smpclient"):
        logging.getLogger(name).setLevel(logging.ERROR)
    if args.self_test:
        import importlib
        data_dir = tempfile.mkdtemp(prefix="hacoap-manager-selftest-")
        # Modules loaded only when used: a packaged app must still contain them.
        for module in ("zeroconf.asyncio", "serial.tools.list_ports", "smpclient.transport.udp",
                       "smpclient.transport.serial", "cryptography.hazmat.primitives.asymmetric.ec"):
            importlib.import_module(module)

    if not args.self_test and not args.demo:
        running = _running_instance(args.port, data_dir)
        if running:
            print(f"The fleet manager already runs at {running}")
            if not (args.no_browser or args.background):
                webbrowser.open(running)
            return 0

    demo_port = 8790 if args.demo and args.port == DEFAULT_PORT else args.port  # where Start the demo looks
    port = _free_port(0 if args.self_test else demo_port)
    services = create_services(data_dir, **({"discover": None} if args.demo else {}))
    services.demo = args.demo
    if not args.demo:  # the demo never starts with the computer
        services.launch = {"workdir": os.getcwd(), "data_dir": args.data_dir,
                           "port": args.port if args.port != DEFAULT_PORT else None}
    app = create_app(services, background_tasks=not args.self_test, on_quit=lambda: setattr(server, "should_exit", True))
    url = f"http://127.0.0.1:{port}/"
    # Stopping waits at most 5 s for open connections (a page's live events) to close
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning",
                                           timeout_graceful_shutdown=5))

    if args.self_test:
        def check():
            while not server.started:
                threading.Event().wait(0.1)
            try:
                with urllib.request.urlopen(url + "api/status", timeout=10) as response:
                    ok = response.status == 200 and b'"version"' in response.read()
                with urllib.request.urlopen(url, timeout=10) as response:
                    ok = ok and b"Fleet Manager" in response.read()
            except OSError as exc:
                print(f"Self-test failed: {exc}")
                ok = False
            print("Self-test " + ("passed" if ok else "failed"))
            check.ok = ok
            server.should_exit = True

        check.ok = False
        threading.Thread(target=check, daemon=True).start()
        asyncio.run(server.serve())
        return 0 if check.ok else 1

    print(f"HA-CoAP Fleet Manager {__version__}")
    print(f"Open {url} (only from this computer). Data: {data_dir}")
    print("Close this window or press Ctrl+C to stop." if not args.background else "Running in the background.")
    if not (args.no_browser or args.background):
        def open_browser():
            while not server.started:
                threading.Event().wait(0.1)
            webbrowser.open(url)

        threading.Thread(target=open_browser, daemon=True).start()
    async def run():
        demo = None
        if args.demo:
            from .demo import Demo
            demo = Demo(services)
            await demo.start()  # before serving: the page opens on a ready demo
        try:
            await server.serve()
        finally:
            if demo is not None:
                await demo.stop()

    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass
    if args.demo:
        import shutil
        services.db.close()
        shutil.rmtree(data_dir, ignore_errors=True)  # the demo keeps nothing
    return 0


if __name__ == "__main__":
    sys.exit(main())
