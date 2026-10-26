# HA-CoAP Firmware Updater

A local web interface for updating ha-coap devices over the air (Thread, mcumgr over UDP). It works on Linux, macOS and Windows.

It does the update with the same tool as the command line: it runs `../scripts/mcumgr-update-all.sh` in its non-interactive mode and shows the progress live. For USB updates, use the scripts (see the main README).

The fleet manager (`../manager/`, on the `fleet-manager` branch) does all of this and more. It is meant to replace this updater once it has updated real boards; until then, this one stays.

## Features

- **Dashboard**: checks that everything it needs is installed, counts past updates, and shows each run's log.
- **Devices**: finds devices on the network (DNS-SD, the `_ot._udp` service the border router advertises), or add them by IPv6 address. The list is kept in the browser.
- **Update**: checks the build directory (image size, build time, hash), then updates the selected devices in test or confirm mode, with live per-device progress, results and log. Uploads that stall are stopped and retried.

## Requirements

| | Linux | macOS | Windows |
|---|---|---|---|
| Python 3.9+ | usually installed | `xcode-select --install` | `winget install Python.Python.3.12` |
| bash | built in | built in | [Git for Windows](https://git-scm.com/) (Git Bash) |
| mcumgr | Go, then `go install github.com/apache/mynewt-mcumgr-cli/mcumgr@latest` | `brew install go`, then the same | `winget install GoLang.Go`, then the same |

Add Go's `bin` folder (`~/go/bin`, or `%USERPROFILE%\go\bin` on Windows) to your PATH so `mcumgr` is found. The Dashboard shows what's missing.

The firmware must be built (see the main README), with the same signing key as the devices' bootloader.

## Setup

From this folder, once:

```
python -m venv .venv
.venv/bin/pip install -r requirements.txt          # Windows: .venv\Scripts\pip install -r requirements.txt
```

This installs Flask, Flask-SocketIO and `zeroconf` (device discovery on every OS).

## Running

```
.venv/bin/python app.py                              # Windows: .venv\Scripts\python app.py
```

Then open http://127.0.0.1:5000:

1. **Dashboard**: check that the update script, bash and mcumgr are all found.
2. **Devices**: click **Discover Devices**, or add devices by address. Select the ones to update, then **Update Selected**.
3. **Update**: check the build directory (`../application/build` by default), pick test or confirm mode, then **Start Update Process**.

After a test-mode update, check each device, then make the image permanent (`mcumgr ... image confirm`, or update again in confirm mode). A device that resets before that goes back to its previous firmware.

The computer needs to reach the Thread network: a Home Assistant border router normally makes it reachable from your LAN. Discovery also needs the computer to be on the same network as the border router; if it finds nothing, add the devices by address (`avahi-browse -r _ot._udp` on Linux, or the device's page in Home Assistant, shows them).

### Server settings

The updater can flash firmware onto every device it can reach, so by default it only listens on this computer. Environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `HACOAP_UPDATER_HOST` | `127.0.0.1` | Address to listen on (`0.0.0.0` exposes it to your network: anyone who can reach it can update your devices) |
| `HACOAP_UPDATER_PORT` | `5000` | Port to listen on |
| `HACOAP_UPDATER_DEBUG` | off | `true` enables Flask debug mode (never on a shared network) |
| `HACOAP_UPDATER_SECRET_KEY` | random per run | Flask secret key |
| `HACOAP_UPDATER_LOG_DIR` | `logs/` | Where each run's log is kept |
| `HACOAP_BASH` | found automatically | bash to run the update script with (on Windows, Git Bash; WSL's bash won't work) |

### How updates run

The server runs `../scripts/mcumgr-update-all.sh` with bash and passes the settings as `HACOAP_*` environment variables (see the top of the script). The same mode works from a terminal:

```
HACOAP_NON_INTERACTIVE=true \
HACOAP_DEVICES="ha-coap-88a24c28=fd49:969:3c3c:1:88a2:4c28:69ec:34f7" \
HACOAP_UPDATE_MODE=test \
../scripts/mcumgr-update-all.sh
```

Each run's output is saved in `logs/update_YYYYmmdd_HHMMSS.log`, which the Dashboard lists and counts.

## Project structure

```
firmware-updater/
├── app.py               Flask app: pages and API
├── update_manager.py    Runs discovery and the update script, tracks progress
├── requirements.txt
├── static/              CSS and shared JavaScript (Bootstrap and Socket.IO load from a CDN, pinned)
├── templates/           Dashboard, Devices and Update pages
└── tests/               test_web_updater.py: runs an update through the app with a fake mcumgr
```

## Tests

```
.venv/bin/python tests/test_web_updater.py           # Windows: .venv\Scripts\python tests\test_web_updater.py
```

The test starts the app, discovers a fake device, rejects bad requests and runs a full update through the real script with a fake `mcumgr` (`../scripts/tests/fake-mcumgr`). With Node.js installed, it also checks that each page's JavaScript parses. CI runs it on Linux, macOS and Windows.
