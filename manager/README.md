# HA-CoAP Fleet Manager

One application for Windows, macOS and Linux to look after a fleet of ha-coap devices. It finds them on the network, shows their status, builds firmware with the settings you choose, keeps a library of firmware images, and updates devices over the air or over USB.

It runs on your PC when you need it. The app starts a small web server that only this computer can reach (`http://127.0.0.1:8710`), and opens it in your browser. Close the app's window and everything stops.

**Status (2026-10-25):** the plan's phases 0–2 and 5 (foundations, inventory, updates, builds). Tested against a simulated device on Windows, macOS and Linux, and a real firmware build on Windows, **not yet with real boards**. Runtime settings and commissioning come later (see [the plan](../docs/FLEET-MANAGER-PLAN.md)). Until it has updated real boards, keep using the scripts or the web updater for anything important.

## Getting it

**Packaged app** (no Python needed): every push builds it in GitHub Actions.
1. Open the repository's **Actions** tab, then the latest **Build firmware** run on the `fleet-manager` branch.
2. Under **Artifacts**, download `hacoap-manager-Windows-…`, `-macOS-…` or `-Linux-…` and unzip it.
3. Run it:
   - **Windows:** double-click `hacoap-manager.exe`. SmartScreen warns about an unknown publisher the first time: **More info → Run anyway**.
   - **macOS:** in Terminal, `chmod +x hacoap-manager && xattr -d com.apple.quarantine hacoap-manager && ./hacoap-manager`. Gatekeeper otherwise blocks an unsigned download.
   - **Linux:** `chmod +x hacoap-manager && ./hacoap-manager`.

The app isn't code-signed, which is why each OS warns once.

**From the source** (Python 3.10 or newer), from this folder:

| | Set up once | Start |
|---|---|---|
| Windows (PowerShell) | `py -m venv .venv` then `.venv\Scripts\pip install -r requirements.txt` | `.venv\Scripts\python -m hacoap_manager` |
| macOS, Linux | `python3 -m venv .venv` then `.venv/bin/pip install -r requirements.txt` | `.venv/bin/python -m hacoap_manager` |

Options: `--port 8710` (the next free port is used if it's taken), `--data-dir <folder>`, `--no-browser`.

## Before you use it
- **Same network as the border router.** The PC reaches the devices through the border router, exactly like the scripts: CoAP on UDP 5683 for status, mcumgr on UDP 1337 for updates, and mDNS to find them. If `ping` to a device's address fails from this PC, the app can't reach it either.
- **Images signed with your key.** Build on the PC that has `application/keys/mcuboot-signing-key.pem` (see the main README). An image signed with another key uploads fine, but the board refuses to boot it, and the app reports that MCUboot reverted the update.

## Using it

**Devices.** **Find devices** asks the network for every `ha-coap-*` device (the border router answers for them). You can also add one by its IPv6 address. Each device shows:
- its firmware (the git commit, from `info`)
- the running image's version and hash, once read over mcumgr
- its battery, soil and air readings
- when it last answered

The status refreshes every 15 minutes while the app runs, or with **Refresh all**. Each device's **Actions** menu has:
- Refresh
- Firmware slots (what mcumgr reports)
- Beep
- Rename
- Notes
- Remove

Tick devices to update them.

**Images.** The library of firmware images. You can add an `app_update.bin` file, or add a build from this computer: when the app runs from the ha-coap-server folder, it lists `application/build*/zephyr/app_update.bin`. Images are identified by their SHA-256 hash, the same one `mcumgr image list` shows. Use the notes to say what each one is, because the firmware doesn't have version numbers yet (every image is `0.0.0`).

**Updates.** Choose an image and either the devices ticked on the Devices tab (over the air) or one board on a USB serial port. Each device goes through these steps:
1. **Connect and read its slots.** A device already running this image is left alone.
2. **Upload** to slot 1, with progress. A lost packet is sent again; the upload doesn't start over.
3. **Test and reset.** MCUboot boots the new image on trial.
4. **Wait for the device to come back** (up to 3 minutes). If it comes back running the old image, MCUboot reverted the update: it's reported as failed, and the device keeps working as before.
5. **Confirm**, so the new image stays.

Devices are updated one at a time. By default the update stops at the first failure, so a bad image reaches one device, not all of them. **Cancel the rest** skips the devices not started yet; the device in progress finishes, so it's never left half-way. Every result goes into the history.

While a device is being updated, it polls its parent every 100 ms instead of every 3 s (firmware on the `claude` branch and later), so uploads aren't slowed by its sleep schedule. Firmware older than that is about three times slower to update.

**Builds.** Builds firmware on this computer, with settings you choose. It needs the app to run from the ha-coap-server folder, which has been set up for building (scripts/setup, see the main README); the packaged app works too if you start it from inside that folder.
- **Build profiles** are named sets of firmware settings: a variant (battery, usb-logging, uart-console or debug) and the values you want to change. The form comes from `application/Kconfig` (the "ha-coap application" options: pump, sensors, LEDs, watchdog, SRP names) plus the Thread poll period. An empty field keeps the firmware's default; only the settings you change are saved, so a profile keeps following the repository's defaults for the rest. The app checks ranges and the rules the firmware enforces (dry soil voltage above wet, and so on) when you save.
- **Build with this profile** runs the repository's own `scripts/build.ps1` or `scripts/build.sh`, exactly as from a terminal, into the variant's usual build folder (`application/build` for battery). The profile's settings go in through a small `.conf` file (`HACOAP_EXTRA_CONF`, which `application/CMakeLists.txt` merges after `local.conf`; a variant's own overlay still wins on the few options it sets). The log streams live, and the finished image goes into the library, named after its profile.
- **Checks** first: the toolchain, the SDK, your signing key and your PSKd. Without your private signing key, the app asks before building with the public development key, and marks such images *DEVELOPMENT KEY*: boards flashed with your bootloader refuse them.
- The PSKd and the signing key never go into profiles: they stay in `application/local.conf` and `application/keys/`.

**Settings.** Ports, timeouts, the mcumgr packet size (1280 bytes over the air, which fits Thread without IP fragmentation; 512 over USB), how long a device counts as online, and the automatic refresh.

## Where things are kept
Everything is in one folder: the SQLite database (devices, images, history), the images themselves, and `settings.json`.

| OS | Folder |
|---|---|
| Windows | `%LOCALAPPDATA%\hacoap-manager` |
| macOS | `~/Library/Application Support/hacoap-manager` |
| Linux | `~/.local/share/hacoap-manager` |

Copy that folder to back up or move your inventory. `--data-dir` or the `HACOAP_MANAGER_DATA` environment variable use another one.

## Security
- The server listens on 127.0.0.1 only: other computers on the network can't open it. Using it from another PC is a possible later addition (see the plan).
- Other websites open in the same browser can't use it either. The server only answers requests addressed to 127.0.0.1 or localhost, which blocks DNS rebinding. Every change must carry an `X-HACoap` header, which a page from another site can't add.
- There is no login: anyone using this PC's account can use it.
- The devices' mcumgr has no authentication (see the main README's Security section). What protects the boards is the signing key: they only boot images signed with it.

## Trying it without a board
The simulated device answers like a real one: mcumgr over UDP, CoAP, and MCUboot's slots, including reverting an image that isn't confirmed.
```
python -m hacoap_manager.simdevice          # mcumgr on 127.0.0.1:1337, CoAP on 127.0.0.1:5683
```
Then, in the app, add a device at address `127.0.0.1`. To try an update, add any `app_update.bin`: the simulator accepts unsigned images too.

## Development

| Path | What |
|---|---|
| `hacoap_manager/app.py` | The web server: API, live events (WebSocket), the page |
| `hacoap_manager/inventory.py` | Discovery, adding devices, refreshing their status |
| `hacoap_manager/updates.py` | Update jobs: upload, test, reset, check, confirm |
| `hacoap_manager/mcumgr.py` | mcumgr over UDP or USB serial, through [smpclient](https://github.com/intercreate/smpclient) |
| `hacoap_manager/coap.py` | A small CoAP client for `info`, `data` and `ping` |
| `hacoap_manager/discovery.py` | mDNS/DNS-SD (zeroconf) |
| `hacoap_manager/mcuboot.py` | Reads an image's version and hash |
| `hacoap_manager/builds.py`, `kconfig.py` | Build profiles (from `application/Kconfig`), checks, the build runner |
| `hacoap_manager/db.py` | The SQLite database |
| `hacoap_manager/simdevice.py` | The simulated device |
| `hacoap_manager/static/` | The page: plain JavaScript and Bootstrap, no build step, nothing loaded from the internet |
| `tests/` | Tests against the simulated device |

```
pip install -r requirements-dev.txt
python -m pytest            # the tests
python build_app.py         # the packaged app, in dist/
dist/hacoap-manager --self-test
```
CI runs the tests and builds the packaged app on Windows, macOS and Linux (job `fleet-manager`).

**Not covered by the tests yet:** USB serial (there's no simulated serial port), and real Thread timing. Both need a board. Builds are tested with a stand-in for the build script (CI has no nRF toolchain for the app's tests); a real build through the app was checked on Windows.
