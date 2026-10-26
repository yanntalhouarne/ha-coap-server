# Next steps (paused 2026-10-26)

Start here when you come back. To pick up with Claude, say: *"Resume from docs/NEXT-STEPS.md"*.

## Where things stand

| Branch | What's on it | State |
|---|---|---|
| `main` | The firmware as it was before this work | Unchanged |
| `claude` | Firmware fixes and refactor, the power changes from step 4, reproducible builds, private signing key and PSKd, cross-platform update scripts, working web updater, firmware unit tests, reviews in `docs/` | [PR #6](https://github.com/yanntalhouarne/ha-coap-server/pull/6), **not merged: no board has run it yet**. CI passes on Linux, macOS and Windows |
| `fleet-manager` | `claude` plus the fleet manager app (`manager/`): inventory, updates, firmware builds, backups and release downloads (plan phases 0–2, 5 and 6; version 0.1.0), and many additions (see step 6) | Tested against simulated devices and a simulated border router on all three OSes, CI passes, **not on a board or your border router yet**. No release published yet (no `manager-v*` tag pushed) |

The order to go in:
1. Test PR #6 on the boards (steps 1–3 below), then merge it.
2. Answer the decisions still open (step 4).
3. Try the fleet manager on the boards (step 6), then go on with its next phases.

## 1. Before you start
- `git checkout claude && git pull`
- Check that `application/keys/mcuboot-signing-key.pem` and `application/local.conf` are on this PC. If not, restore them from your backup (they aren't in git).
- Build: `powershell -ExecutionPolicy Bypass -File scripts\build.ps1`. The output should show your signing key and no PSKd warning.
- Optional, no board needed: `python application/tests/unit/run.py` runs the firmware's unit tests (README → Unit tests). The first time, `python -m pip install ziglang` gives it a C compiler.

## 2. Flash a board
Build first (step 1). The images are in `application/build/zephyr/`.

**Over SWD** (J-Link on the Tag-Connect pads, with SEGGER J-Link Software and Nordic's nRF Command Line Tools installed), from the repository root in PowerShell:
```
& "$env:LOCALAPPDATA\Programs\nrfutil\nrfutil.exe" toolchain-manager launch --ncs-version v2.4.3 --chdir . -- west flash -d application/build
```
This writes MCUboot and the application, and keeps the board on your network. Add `--erase` at the end for a new board or a full reset; the board then has to join the network again (README → Joining a Thread network).

**Over USB** (board already flashed over SWD with your key; `mcumgr` installed). Replace `COM7` with the board's port:
```
mcumgr conn add serial type="serial" connstring="COM7,baud=115200,mtu=512"
mcumgr -c serial image upload application/build/zephyr/app_update.bin
mcumgr -c serial image list                # copy the hash of the new image (slot 1)
mcumgr -c serial image test <hash>
mcumgr -c serial reset
mcumgr -c serial image confirm             # once the board is back and working
```
**Over the air:** the same commands with a UDP connection instead, `mcumgr conn add udp type="udp" connstring="[<device IPv6>]:1337"`, and `-c udp`. Find the address with `avahi-browse -r _ot._udp`, or use `scripts/mcumgr-update-all.sh`.

**With the scripts instead** (Linux, macOS, or Git Bash on Windows; they use `application/build`):
- `scripts/mcumgr-dfu.sh`: guided update of one device, over USB or the air.
- `scripts/mcumgr-update-all.sh`: the same for several devices at once, with upload retries.

They need `mcumgr` and Python 3.7+. To find devices on the network automatically, they also need `zeroconf` (Windows: `py -m pip install zeroconf`; macOS: `python3 -m pip install --user zeroconf`) or, on Linux, `avahi-utils`. Without it, they ask for the device addresses. See README → Firmware updates → Scripts.

**With the web updater instead** (over the air, from a browser; Linux, macOS or Windows): see `firmware-updater/README.md`. Set it up once with `python -m venv .venv` and `pip install -r requirements.txt`, run `python app.py`, open http://127.0.0.1:5000, and check the Dashboard first.

After a `test` update, check the device, then make it permanent with `mcumgr -c <connection> image confirm` (or update with `HACOAP_UPDATE_MODE=confirm` to skip the trial boot).

If an update uploads but the board keeps its old firmware, the image was signed with a different key. Build on a PC that has your key.

## 3. Test on the boards
- [ ] Each board boots and rejoins the network on its own after the SWD reflash
- [ ] Charging: with USB plugged in and a partly discharged battery, the orange LED is on
- [ ] No random resets over a day (no three-beep jingle out of nowhere)
- [ ] One over-the-air update: upload, `image test`, reset, `image confirm` (README → Firmware updates)
- [ ] Home Assistant shows data, and the pump and ping work

Then the power changes from step 4:
- [ ] The RGB LED flashes (every 5 s) instead of staying on, and stops flashing 5 minutes after the last state change. A board that can't reach the network shows red + green flashes.
- [ ] A pump command from Home Assistant still works. It can take up to 3 s now.
- [ ] Pressing S1 still starts the pump (its interrupt changed).
- [ ] A second over-the-air update, from a board already running this firmware, is about as fast as before. The first update, from older firmware, is slower: the old image doesn't speed up its polling.
- [ ] No resets or odd behavior over a day (the C library changed to save RAM power).
- [ ] Below 0 °C, Home Assistant shows a negative temperature, once [ha-coap-integration PR #10](https://github.com/yanntalhouarne/ha-coap-integration/pull/10) is merged and HA reloaded.

If a board doesn't boot, try a build with DC/DC disabled (README → Board notes).

## 4. Decisions
Decided on 2026-10-25, and done on `claude` (not on a board yet):
- **Status LEDs:** a 20 ms flash every 5 s instead of solid colors, stopping 5 minutes after the last change (`CONFIG_HACOAP_STATUS_LED_TIMEOUT_S`).
- **Thread poll period:** 3 s (was 1 s). The device now polls every 100 ms while mcumgr is in use, so over-the-air updates aren't three times slower.
- **Sensor sampling:** every 15 min (was 5 min), matching how often Home Assistant asks.
- **Button interrupt and RAM power-down:** both done. RAM power-down needs the full C library, which adds 13 KB of flash (now 82% full).
- **Integration:** negative temperatures fixed in [ha-coap-integration PR #10](https://github.com/yanntalhouarne/ha-coap-integration/pull/10). Merge it when you're ready.

Still to decide:
- **Rev 2.1 hardware:** remove the power LED and rework SW2/R36, about 1.3 mA together? These loads are about 100 times what the firmware draws, so they decide the battery life.
- **Current measurement:** do you have a PPK2 or a µA meter? It would confirm the power review's estimates.

Details: `docs/firmware/ha-coap-node-power-review.pdf`.

## 5. Finish PR #6
Share the test results and decisions with Claude. It updates the status tables in the code and power reviews and PR #6, then you merge PR #6 into `main`.

## 6. Then: the fleet manager

**What's built** (on the `fleet-manager` branch, in `manager/`): the plan's phases 0–2, 5 and 6, as version 0.1.0. It's a local web app for Windows, macOS and Linux that:
- finds devices (or adds them by address) and shows their firmware, battery, readings and when they were last seen
- builds firmware from named profiles (variant plus the settings you change, in a form made from `application/Kconfig`), with a live log, checking your signing key first
- keeps a library of firmware images, from files or from those builds, and shows who signed each one (your key, the development key, another key, unsigned)
- backs up its data (daily, and on demand) and restores it, and exports or imports the device list as CSV
- draws the Thread mesh (the **Network** page): routers, children, your boards, and link strength as line colour and length, from the border router's REST API
- updates devices over the air or over USB: upload, trial boot, check the device comes back running it, confirm. One device at a time, stopping at the first failure, with a history. It asks before using an image your boards would refuse, and skips devices under 20 % battery over the air

Added since (2026-10-25 and 26), all described in `manager/README.md`:
- a **dashboard**, and a **page per device** with charts, pump and buzzer controls, and a **photo of its plant**
- **watering targets** and a **needs water** list, **alerts** (offline, low battery, needs water, failed update), also as browser notifications
- **groups** (location and tags), a **release** image, **staged updates**, **what's new** between two images, actions for **all ticked devices**
- on the Network page: **click a board** for its plant photo and readings, a **floor plan** of your home, a **signal heatmap** (floor plan and mesh), **network history** with a slider, zoom and pan, and a **channel scan**
- a **serial console**, **Set up this computer** buttons (toolchain, signing key, PSKd), **Ctrl+K search**, a **readings CSV**, a **problem report**, an optional **app update check** (off by default), and a **phone layout**
- a **simulated fleet**: `python -m hacoap_manager.simdevice --count 9 --border-router api` runs 9 devices and a border router on this PC, to try everything without boards

It talks to the devices directly (no `mcumgr` tool needed). Details and instructions: `manager/README.md`. Every change: `manager/CHANGELOG.md`. The plan, with what's next: `docs/FLEET-MANAGER-PLAN.md`.

**Where it was left (2026-10-26):** the last commits are pushed to `fleet-manager` and CI passed. To run your copy from the source again after pulling, re-run `.venv\Scripts\pip install -r requirements.txt` in `manager/` first: it now also needs `cryptography`, for the signature check. Then start it, and the simulator too if you want the 9 simulated devices back (they don't keep running between sessions). The app's data (devices, photos, floor plan, history) stays between runs, in `%LOCALAPPDATA%\hacoap-manager` unless you started it with `--data-dir`. If you tried things against the simulator, the simulated devices are in that list: remove them (**With selected → Remove from the list**) before using it with your boards.

**Decided:**
- A local web app, one download per OS, run on your PC when you need it.
- Only that PC can open it (no remote access for now; Remote Desktop works if needed).
- Settings both at build time and at runtime (runtime needs firmware changes, phase 3).
- Your border router is a standalone OTBR (ot-br-posix).

### Try it on the boards
After PR #6's board tests (the fast polling during updates is in that firmware):
1. Get it, either way:
   - `git checkout fleet-manager && git pull`, then from `manager/`: `py -m venv .venv` (once), `.venv\Scripts\pip install -r requirements.txt`, `.venv\Scripts\python -m hacoap_manager`
   - or the packaged `hacoap-manager.exe` from the latest CI run on `fleet-manager` (GitHub → Actions → Artifacts). There's no release yet: making one is a tag away (`manager/README.md` → Making a release), best done once it has updated real boards.
2. In the browser page it opens:
   - [ ] **Find devices** lists every board, and their status fills in (battery, readings)
   - [ ] **Actions → Firmware slots** answers for a board
   - [ ] **Builds → Build with this profile** (Production) makes an image signed with your key (already checked on this PC), or **Images → Builds on this computer → Add** your latest build. Its **Signed** column says *your key*
   - [ ] **Update** one board over the air: it goes through uploading, rebooting, waiting, confirming, and ends as *updated*. Note how long the upload takes.
   - [ ] **Update** one board on USB (choose its serial port). This path has no simulated test, so it's the most likely to need a fix.
   - [ ] **Network:** set the border router's address (or **Find it**), then **Read the network**. It works without the boards too. Note what the page says it got: "with signal strength" (a 2025+ border router) or "link quality only" (an older one, where boards can't be named on the map). Then click one of your boards on the map: its card should show its readings.
   - [ ] **Run the pump** and **Beep** from a device's page reach the board (within 3 s)
3. Tell Claude what happened. Once it works, `fleet-manager` can become a pull request, and the web updater can go.

### Which machine runs it
The app runs on the PC you start it on. That PC hosts the page for itself: the app starts a small web server listening only on that computer (`http://127.0.0.1:8710`) and opens it in your browser. Close the app and everything stops; nothing runs on the internet, on the border router or in Home Assistant.

That PC does all the talking:

| Talks to | How |
|---|---|
| Boards on USB | its USB serial ports |
| Boards over the air | UDP to their IPv6 addresses, through the border router |
| Device discovery | mDNS on your LAN (the border router answers for the Thread devices) |
| Commissioning (later) | the border router's REST API (port 8081) |
| Builds | the nRF Connect toolchain installed on that PC (`scripts/setup`) |

So it needs to be on the same network as the border router, like the scripts.

### Next phases
- **3. Runtime settings, 4. Commissioning** need firmware changes (a settings store and a custom mcumgr group), so each needs a board test. Merge PR #6 first, so they build on tested firmware.
- **Before phase 4, check the border router's API.** Commissioning from the app needs the commissioner endpoints of the OTBR REST API, which are recent additions. On the border router:
  ```
  curl http://<border-router>:8081/node
  curl http://<border-router>:8081/node/commissioner/state
  sudo ot-ctl version
  ```
  If `curl` from another computer fails but works on the border router itself, its REST API only listens locally (`otbr-agent` option `--rest-listen-address`). If the commissioner endpoints are missing, update ot-br-posix; otherwise the app falls back to showing the `ot-ctl` commands.
- Phases 5 (builds) and 6 (backups, export/import, release downloads) are done.
