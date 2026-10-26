"""Starts the fleet manager: the local web server, then the browser.

    python -m hacoap_manager [--port 8710] [--data-dir DIR] [--no-browser]

--self-test starts the server on a free port, checks that it answers, and exits (used to
check the packaged app in CI).
"""

import argparse
import asyncio
import logging
import socket
import sys
import threading
import urllib.request
import webbrowser

import uvicorn

from . import __version__
from .app import create_app, create_services
from .config import default_data_dir

DEFAULT_PORT = 8710


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


def main(argv=None):
    parser = argparse.ArgumentParser(prog="hacoap-manager", description="HA-CoAP Fleet Manager")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"port on 127.0.0.1 (default {DEFAULT_PORT})")
    parser.add_argument("--data-dir", default=None, help=f"data folder (default {default_data_dir()})")
    parser.add_argument("--no-browser", action="store_true", help="don't open the browser")
    parser.add_argument("--self-test", action="store_true", help="start, check that the server answers, and exit")
    parser.add_argument("--version", action="version", version=__version__)
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    # smpclient warns about every answer from Zephyr 3.3's older SMP version: expected, not useful
    for name in ("smp", "smpclient"):
        logging.getLogger(name).setLevel(logging.ERROR)
    data_dir = args.data_dir or default_data_dir()
    if args.self_test:
        import importlib
        import tempfile
        data_dir = tempfile.mkdtemp(prefix="hacoap-manager-selftest-")
        # Modules loaded only when used: a packaged app must still contain them.
        for module in ("zeroconf.asyncio", "serial.tools.list_ports", "smpclient.transport.udp",
                       "smpclient.transport.serial", "cryptography.hazmat.primitives.asymmetric.ec"):
            importlib.import_module(module)

    port = _free_port(0 if args.self_test else args.port)
    services = create_services(data_dir)
    app = create_app(services, background_tasks=not args.self_test)
    url = f"http://127.0.0.1:{port}/"
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))

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
    print("Close this window or press Ctrl+C to stop.")
    if not args.no_browser:
        def open_browser():
            while not server.started:
                threading.Event().wait(0.1)
            webbrowser.open(url)

        threading.Thread(target=open_browser, daemon=True).start()
    try:
        asyncio.run(server.serve())
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
