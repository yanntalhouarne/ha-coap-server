# Next steps (paused 2026-10-25)

All work is on the `claude` branch, open as [PR #6](https://github.com/yanntalhouarne/ha-coap-server/pull/6). It isn't merged yet because no board has run it.

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

**With the scripts instead** (from the `scripts` folder, in bash; they use `application/build`):
- On Linux, with `avahi-utils` and `mcumgr` installed (for example the Home Assistant host or a Raspberry Pi):
  - `./mcumgr-dfu.sh`: guided update of one device, found automatically, over USB or the air.
  - `./mcumgr-update-all.sh`: the same for several devices at once, with upload retries.
- On Windows, the guided modes don't work, because they need `avahi-browse` and Linux serial ports. Over the air, `mcumgr-update-all.sh` works from Git Bash in non-interactive mode, with the device addresses given by hand:
  ```
  cd scripts
  HACOAP_NON_INTERACTIVE=true HACOAP_UPDATE_MODE=test HACOAP_DEVICES="plant1=<device IPv6> plant2=<device IPv6>" ./mcumgr-update-all.sh
  ```
  Each device ends with a `RESULT <name> success|skipped|failed` line.

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

## 5. Finish
Share the test results and decisions with Claude. It updates the code review's status table and PR #6, then you merge PR #6 into `main`.
