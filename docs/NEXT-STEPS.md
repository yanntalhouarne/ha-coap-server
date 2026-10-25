# Next steps (paused 2026-10-25)

Start here when you come back. To pick up with Claude, say: *"Resume from docs/NEXT-STEPS.md"*.

## Where things stand

| Branch | What's on it | State |
|---|---|---|
| `main` | The firmware as it was before this work | Unchanged |
| `claude` | Firmware fixes and refactor, reproducible builds, private signing key and PSKd, cross-platform update scripts, working web updater, reviews in `docs/` | [PR #6](https://github.com/yanntalhouarne/ha-coap-server/pull/6), **not merged: no board has run it yet**. CI passes on Linux, macOS and Windows |
| `fleet-manager` | `claude` plus the plan for a fleet management app (`docs/FLEET-MANAGER-PLAN.md`) | Plan only, no app code yet |

The order to go in:
1. Test PR #6 on the boards (steps 1–3 below), then merge it.
2. Answer the open decisions (step 4).
3. Start the fleet manager (step 6).

## 1. Before you start
- `git checkout claude && git pull`
- Check that `application/keys/mcuboot-signing-key.pem` and `application/local.conf` are on this PC. If not, restore them from your backup (they aren't in git).
- Build: `powershell -ExecutionPolicy Bypass -File scripts\build.ps1`. The output should show your signing key and no PSKd warning.

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

If a board doesn't boot, try a build with DC/DC disabled (README → Board notes).

## 4. Decide (no boards needed)
- **Status LEDs:** a short flash instead of solid colors, turned off after a few minutes, or left as they are?
- **Thread poll period:** 1 s (now) or 2–3 s? Longer saves current but slows pump commands.
- **Sensor sampling:** every 5 min (now) or 15 min?
- **Button interrupt and RAM power-down:** both small power fixes, recommended.
- **Integration:** fix negative temperatures in `ha-coap-integration` (they show as 251 °C)?
- **Rev 2.1 hardware:** remove the power LED and rework SW2/R36, about 1.3 mA together?
- **Current measurement:** do you have a PPK2 or a µA meter? It would confirm the power review's estimates.

Details: `docs/firmware/ha-coap-node-power-review.pdf`.

## 5. Finish PR #6
Share the test results and decisions with Claude. It updates the code review's status table and PR #6, then you merge PR #6 into `main`.

## 6. Then: the fleet manager

The plan is in `docs/FLEET-MANAGER-PLAN.md` on the `fleet-manager` branch (`git checkout fleet-manager`, or read it [on GitHub](https://github.com/yanntalhouarne/ha-coap-server/blob/fleet-manager/docs/FLEET-MANAGER-PLAN.md)).

**What it is:** one application for Windows, macOS and Linux to manage the whole fleet. It covers:
- finding devices, and an inventory with their status
- updates over USB or the air, with automatic confirm once the device comes back running the new version
- commissioning new boards, each with its own PSKd
- runtime and build-time settings
- firmware builds

It replaces the web updater and `mcumgr` (it talks to devices directly), and keeps the scripts as a fallback.

**Decided so far:**
- A local web app with a browser interface, one download per OS.
- It runs on your PC when you need it.
- Settings both at build time (Kconfig) and at runtime (needs firmware changes).
- Your border router is a standalone OTBR (ot-br-posix).

### Which machine runs it

The app runs on the PC you start it on. That PC hosts the web page for itself: the app starts a small web server inside itself, listening only on that computer (`http://127.0.0.1:...`), and opens it in your browser. The browser is only the screen. Close the app and the page stops; nothing runs in the background, on the internet, on the border router or in Home Assistant.

That PC does all the talking:

| Talks to | How |
|---|---|
| Boards on USB | its USB serial ports |
| Boards over the air | UDP to their IPv6 addresses, through the border router |
| Device discovery | mDNS on your LAN (the border router answers for the Thread devices) |
| Commissioning | the border router's REST API (port 8081) |
| Builds | the nRF Connect toolchain installed on that PC (only if you build there) |

So it needs to be on the same network as the border router, like the scripts today.

### Using it from another PC (to decide)

As planned, other computers can't open the app: it only listens on its own PC. To use it from another PC's browser, there are three options:

| Option | What it takes | Trade-offs |
|---|---|---|
| **Remote mode in the app** | A setting, off by default. When on, the app listens on the LAN and requires a password. Encryption (HTTPS) is recommended, with a self-signed certificate, so each browser warns once | The host PC must stay on with the app running. USB boards plug into the host, not the PC with the browser. Windows asks once to allow the app through its firewall. Without the password, anyone on your Wi-Fi could flash or wipe every device |
| **Run it on an always-on machine** | The same remote mode, on a Raspberry Pi (possibly the border router's) | Nothing to keep on except the Pi. USB updates need the board plugged into the Pi |
| **Remote Desktop / SSH tunnel** into the PC running it | Nothing to build | Fine for occasional use |

Decide: should the plan include remote mode (off by default, password + HTTPS when on)? It's a modest addition to Phase 0.

### Before starting it
- **Check the border router's API.** Commissioning from the app needs the commissioner endpoints of the OTBR REST API, which are recent additions. On the border router:
  ```
  curl http://<border-router>:8081/node
  curl http://<border-router>:8081/node/commissioner/state
  sudo ot-ctl version
  ```
  If `curl` from another computer fails but works on the border router itself, its REST API only listens locally (`otbr-agent` option `--rest-listen-address`). If the commissioner endpoints are missing, update ot-br-posix; otherwise the app falls back to showing the `ot-ctl` commands.
- **Merge PR #6 first,** so the fleet manager builds on firmware that's been tested.
- **The phases:**
  - 0. Foundations
  - 1. Inventory
  - 2. Updates
  - 3. Runtime settings
  - 4. Commissioning
  - 5. Builds
  - 6. Polish

  Phases 0–2 are tested against a simulated device, so they need no board. The firmware changes (version numbers in Phase 0, settings in Phase 3, commissioning in Phase 4) each need a board test.
