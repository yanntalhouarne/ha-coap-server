# HA-CoAP Fleet Manager: plan

A cross-platform application (Windows, Linux, macOS) to manage, maintain and update the firmware on a fleet of ha-coap devices: find them, commission new ones, configure them, build firmware and update it over USB or over the air.

Status: proposed (2026-10-25). Decisions so far:
- **Form:** a local web app (Python backend, browser UI), packaged as one download per OS.
- **Where it runs:** on your PC when you need it, listening only on that computer (no login needed).
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
                                                          ├─ aiocoap ──── UDP 5683 ───────────── device: CoAP resources
                                                          ├─ zeroconf ─── mDNS/DNS-SD ────────── border router's SRP proxy
                                                          ├─ OTBR REST ── HTTP 8081 ──────────── border router (commissioner)
                                                          └─ build runner ─ scripts/build.* ──── NCS toolchain (optional)
```

- **Backend:** Python with FastAPI and asyncio, because the device libraries (smpclient, aiocoap, zeroconf) are all asynchronous. It replaces the Flask web updater once it covers everything that does.
- **Device management:** [smpclient](https://github.com/intercreate/smpclient) speaks the mcumgr protocol directly over serial and UDP. The Go `mcumgr` tool is no longer needed.
- **Device data:** CoAP, through the same resources Home Assistant uses (`info`, `data`).
- **UI:** plain JavaScript modules and Bootstrap, bundled with the app (no CDN, so it works offline). No Node.js build step.
- **Packaging:** PyInstaller, one executable per OS, built by CI on every release. Starting it opens the browser. The builds aren't code-signed, so Windows SmartScreen and macOS Gatekeeper warn the first time.
- **Building firmware** needs the nRF Connect SDK toolchain, installed by the existing setup scripts. Everything else works without it, using images built elsewhere.
- **Security:** the server only listens on this computer. The signing key and PSKds stay on this computer.

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

Each phase ends with a working, tested app. Tests run in CI on Linux, macOS and Windows against a simulated device: a small Python program that answers mcumgr requests over UDP and serial, and CoAP requests.

| Phase | Delivers |
|---|---|
| **0. Foundations** | New `manager/` app skeleton, simulated device, CI packaging into executables for the 3 OSes, firmware version numbers |
| **1. Inventory** | Discovery, inventory, live status (version, battery, sensors, online), device pages |
| **2. Updates** | USB and over-the-air updates through smpclient, an image library, test, verify, confirm, staged rollout, history. Replaces `firmware-updater/` |
| **3. Runtime settings** | Firmware settings and the `hacoap` mcumgr group. Settings pages for one device or the fleet |
| **4. Commissioning** | Border router integration, a USB provisioning wizard with a PSKd per device, optional first SWD flash, credential reset |
| **5. Builds** | Kconfig editor, profiles, build runner, image library integration, signing-key checks |
| **6. Polish** | Export/import, backups, docs, release downloads |

The command-line scripts stay, for automation and as a fallback.

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
