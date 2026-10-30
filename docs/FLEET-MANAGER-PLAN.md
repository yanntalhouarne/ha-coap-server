# HA-CoAP Fleet Manager: plan

A cross-platform application (Windows, Linux, macOS) to manage, maintain and update the firmware on a fleet of ha-coap devices: find them, commission new ones, configure them, build firmware and update it over USB or over the air.

Status (2026-10-26): **phases 0–2, 5 and 6 are built** in `manager/` (version 0.1.0) (see `manager/README.md`), with many additions (below), tested against simulated devices and a simulated border router on Windows, macOS and Linux, **not yet with boards**. Phases 3 and 4 wait for PR #6 to be tested on boards and merged. Where things stand overall, and what to do first: `docs/NEXT-STEPS.md`. Decisions so far:
- **Form:** a local web app (Python backend, browser UI), packaged as one download per OS.
- **Where it runs:** on your PC when you need it, listening only on that computer (no login needed). Remote access: not for now (decided 2026-10-25), maybe later.
- **Settings:** build-time (Kconfig) and runtime (changed on a running device, no reflash).
- **Border router:** a standalone OpenThread Border Router (ot-br-posix).

## What it does

| Area | Features |
|---|---|
| **Fleet inventory** | Finds devices (DNS-SD, and the border router's device list). Keeps an inventory with name, device ID, address, firmware and hardware version, battery, sensor readings, last seen and update history. Flags devices that are offline or behind the latest firmware. |
| **Firmware updates** | Over USB or over the air. Upload, trial boot, check that the device comes back running the new version, then confirm. Can roll out to one device first, then the rest, and stop on the first failure. Shows live progress and keeps every result. |
| **Commissioning** | A wizard for new boards: optional first flash over SWD, then over USB read the device's ID and give it its own PSKd. Then ask the border router to accept it, wait for it to join, and add it to the inventory. Can also reset a device's network credentials. |
| **Settings** | Runtime: view and change a device's settings (sampling period, pump run time, poll period, ...), one device or the whole fleet. Build-time: a Kconfig editor for the `HACOAP_*` options and a short list of others, with saved profiles. |
| **Builds** | Runs the existing build scripts with the chosen profile, and keeps every image with its version, settings and hash. Checks that the private signing key is present before building images for the fleet. |
| **Housekeeping** | Update and commissioning logs, inventory export/import, system checks (toolchain, signing key, border router reachable). |

## Architecture

```
 Browser UI (served locally)   ── HTTP / WebSocket ──   Python backend (FastAPI)
                                                          ├─ inventory (SQLite, per-user data folder)
                                                          ├─ smpclient ── USB serial / UDP 1337 ── device: mcumgr (MCUboot)
                                                          ├─ CoAP client ─ UDP 5683 ──────────── device: CoAP resources
                                                          ├─ zeroconf ─── mDNS/DNS-SD ────────── border router's SRP proxy
                                                          ├─ OTBR REST ── HTTP 8081 ──────────── border router (commissioner)
                                                          └─ build runner ─ scripts/build.* ──── NCS toolchain (optional)
```

- **Backend:** Python with FastAPI and asyncio, because the device libraries (smpclient, zeroconf) are asynchronous. CoAP uses a small built-in client (GET and PUT are all the devices need), which behaves the same on every OS. It replaces the Flask web updater once it covers everything that does.
- **Device management:** [smpclient](https://github.com/intercreate/smpclient) speaks the mcumgr protocol directly over serial and UDP. The Go `mcumgr` tool is no longer needed.
- **Device data:** CoAP, through the same resources Home Assistant uses (`info`, `data`).
- **UI:** plain JavaScript modules and Bootstrap, bundled with the app (no CDN, so it works offline). No Node.js build step.
- **Packaging:** PyInstaller, one executable per OS, built by CI on every release. Starting it opens the browser. The builds aren't code-signed, so Windows SmartScreen and macOS Gatekeeper warn the first time.
- **Building firmware** needs the nRF Connect SDK toolchain, installed by the existing setup scripts. Everything else works without it, using images built elsewhere.
- **Security:** the server only listens on this computer (see [Where it runs](#where-it-runs) for remote access). The signing key and PSKds stay on this computer.

## Where it runs

The app runs on the PC you start it on, which hosts the page for itself: the app contains a small web server, listening only on that computer (`http://127.0.0.1:<port>`), and opens it in the browser. The browser is only the screen. Closing the app stops everything; nothing runs on the internet, on the border router or in Home Assistant.

That PC talks to the boards (USB serial, or UDP through the border router), to the border router (mDNS for discovery, REST on port 8081 for commissioning) and to the local toolchain for builds. So it must be on the same network as the border router.

### Remote access (decided: not for now)

The app stays local-only for now (2026-10-25); Remote Desktop to the PC running it covers occasional use. If that changes, the options are below. Other computers can't open the app as it is. To use it from another PC's browser, the options are:

| Option | What it takes | Trade-offs |
|---|---|---|
| **Remote mode** (proposed: off by default) | When turned on, the app listens on the LAN, requires a password, and serves HTTPS with a self-signed certificate (each browser warns once) | The host must stay on with the app running. USB boards plug into the host. A firewall prompt on Windows. Without the password, anyone on the network could flash or wipe every device |
| **Always-on host** | The same remote mode, on a Raspberry Pi (for example the border router's) | Linux packaging is already planned. USB updates need the board plugged into the Pi |
| **Remote Desktop / SSH tunnel** | Nothing | For occasional use |

Remote mode would need a login, HTTPS and a listen-address setting in front of every API route.

## Firmware changes

1. **Version numbers.** A semantic version (for example `1.4.0`) in the MCUboot image header and in `info`, next to the git hash, so the app can tell whether a device is out of date.
2. **Runtime settings.** Zephyr's settings subsystem, stored in the existing `settings_storage` partition next to OpenThread's data. Applies to the tunables: sampling period, pump run times, soil calibration, poll period and so on. The Kconfig values become the defaults.
3. **A custom mcumgr group** (`hacoap`, group 64). This Zephyr version has no settings group, so this one carries:
   - device info: device ID, EUI-64, firmware and hardware version, network role
   - settings: read and write
   - the joiner PSKd: write
   - network credentials: erase

   It works over USB and over the air, so a board can be configured over USB before it ever joins.
4. **Joiner with a stored PSKd.** At boot, join with the PSKd written at commissioning, falling back to the build's. This replaces OpenThread's automatic joiner start.

All of it keeps the current partition layout and signing, so it ships as a normal update.

## Phases

Each phase ends with a working, tested app. Tests run in CI on Linux, macOS and Windows against a simulated device: a small Python program that answers mcumgr requests over UDP, and CoAP requests.

| Phase | Delivers | State |
|---|---|---|
| **0. Foundations** | New `manager/` app skeleton, simulated device, CI packaging into executables for the 3 OSes, firmware version numbers | Done. Firmware version numbers: in the image header from `application/VERSION` (build only); in `info`, a firmware change, still to do |
| **1. Inventory** | Discovery, inventory, live status (version, battery, sensors, online), device pages | Done |
| **2. Updates** | USB and over-the-air updates through smpclient, an image library, test, verify, confirm, staged rollout, history. Replaces `firmware-updater/` | Done; replaces the web updater once it has updated real boards |
| **3. Runtime settings** | Firmware settings and the `hacoap` mcumgr group. Settings pages for one device or the fleet | Done (2026-10-29): sampling period, pump run time, poll period and soil calibration, in the group's commands 0 (settings) and 1 (sample now); a device's page, and several boards at once. Not yet tried on a board. The group's device info, PSKd and credentials commands come with phase 4 |
| **4. Commissioning** | Border router integration, a USB provisioning wizard with a PSKd per device, optional first SWD flash, credential reset | The SWD flash is built ahead (Builds tab, through `nrfutil device`), not yet tried with a J-Link; the wizard will use it |
| **5. Builds** | Kconfig editor, profiles, build runner, image library integration, signing-key checks | Done (build-time settings: the `HACOAP_*` options and the poll period) |
| **6. Polish** | Export/import, backups, docs, release downloads | Done: backups (daily, and before a restore), restore, device list CSV, per-device history, release workflow (`manager-v*` tags) |

The command-line scripts stay, for automation and as a fallback.

**Added along the way:** a **Network** page (2026-10-25): a map of the Thread mesh from the border router's REST API, with link strength drawn as line colour and length, boards named by address, and a parent-change log. It supports both REST API generations: `/api/devices` + `/api/actions` (2025+, with RSSI and link margin) and `/diagnostics` (older, link quality only). The first real check is reading your border router.

Also added (2026-10-25 and 26):
- a **dashboard**
- **device pages** with history charts (readings and link strength) and pump/buzzer controls
- **groups** (location and tags)
- a **release** image, with the devices behind it flagged
- **staged updates** that pause after the first device
- **what's new** between two images
- a **floor plan** view of the mesh
- a **channel scan**
- a **serial console**
- **Set up this computer**: buttons on the Builds tab that install the toolchain and SDK, create the signing key and set the PSKd
- a **signature check** before updates, and a **battery check** that skips devices under 20 % over the air
- **plant photos**, watering targets and a **needs water** list
- **alerts**, also as browser notifications
- **network history** with a slider, and a **signal heatmap** on the floor plan and the mesh
- a **board's card** on the network map: click a board for its plant photo, battery, soil, humidity and temperature
- **Ctrl+K search**, actions for **all ticked devices**, a **readings CSV**, a **problem report**, an optional **app update check**, and a **phone layout**
- **flashing a board over SWD** with a J-Link, and an optional install of the SWD tools (`nrfutil device`; Nordic's replacement for the nRF Command Line Tools)
- **Check my connection**, **battery drain per firmware**, **running in the background** (start with the computer), **Home Assistant history import**, chart markers, plant presets, printable labels, and data limits
- **watering forecasts**, a **photo timeline**, a **wall display**, a **weekly summary**, a **Getting started** list, map pulses, and a built-in **demo** (a second app with simulated boards and history, in a throwaway data folder)
- a redesigned **network map** (hop rings, photo avatars with soil gauges, hover tracing, a sliding details panel) and **floor plan** (photo pins, drag-on list, banded heatmap), icons throughout, and 7-day charts in the dashboard's tiles; then (2026-10-29) the Network page redesigned: figures, a node list, the backbone-only map, a tree view, and a floor plan tinted to the theme
- a **simulated fleet** (`simdevice --count N`) with a simulated border router, to try all of it without boards

**What the first hardware test should check** (phases 1–2): Find devices lists every board; status refreshes; Firmware slots answers; an over-the-air update of one board goes through upload, reset, return and confirm; a USB update of one board does too (the USB path has no simulated test); flashing a board over SWD with **Keep its network** brings it back on the network (no real J-Link test yet either). Also note how long an over-the-air upload takes.

## Open questions

- **Border router API.** Commissioning needs the REST API's commissioner endpoints (`/node/commissioner/state`, `/node/commissioner/joiner`), which are recent additions to ot-br-posix. On the border router, these show what it supports:
  ```
  curl http://<border-router>:8081/node
  curl http://<border-router>:8081/node/commissioner/state
  sudo ot-ctl version
  ```
  If the REST API only listens on the border router itself, it needs `--rest-listen-address` (`otbr-agent` option) set to its LAN address. If the endpoints are missing, the fallbacks are updating ot-br-posix, or the app showing the `ot-ctl` commands to run.
- **EUI-64 or wildcard joiner.** Adding each board's own EUI-64 to the border router, rather than `*`, means only that board can join with its PSKd. That needs the EUI-64 from the board over USB (firmware change 3), which is the plan.
- **Hardware testing.** Every phase that changes firmware needs a board to confirm it. The current pull request (#6) should be tested and merged first, so the fleet manager starts from firmware known to work.
