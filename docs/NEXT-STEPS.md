# Next steps (paused 2026-10-25)

All work is on the `claude` branch, open as [PR #6](https://github.com/yanntalhouarne/ha-coap-server/pull/6). It isn't merged yet because no board has run it.

## 1. Before you start
- `git checkout claude && git pull`
- Check that `application/keys/mcuboot-signing-key.pem` and `application/local.conf` are on this PC. If not, restore them from your backup (they aren't in git).
- Build: `powershell -ExecutionPolicy Bypass -File scripts\build.ps1`. The output should show your signing key and no PSKd warning.

## 2. Test on the boards
- [ ] Each board boots and rejoins the network on its own after the SWD reflash
- [ ] Charging: with USB plugged in and a partly discharged battery, the orange LED is on
- [ ] No random resets over a day (no three-beep jingle out of nowhere)
- [ ] One over-the-air update: upload, `image test`, reset, `image confirm` (README → Firmware updates)
- [ ] Home Assistant shows data, and the pump and ping work

If a board doesn't boot, try a build with DC/DC disabled (README → Board notes).

## 3. Decide (no boards needed)
- **Status LEDs:** a short flash instead of solid colors, turned off after a few minutes, or left as they are?
- **Thread poll period:** 1 s (now) or 2–3 s? Longer saves current but slows pump commands.
- **Sensor sampling:** every 5 min (now) or 15 min?
- **Button interrupt and RAM power-down:** both small power fixes, recommended.
- **Integration:** fix negative temperatures in `ha-coap-integration` (they show as 251 °C)?
- **Rev 2.1 hardware:** remove the power LED and rework SW2/R36, about 1.3 mA together?
- **Current measurement:** do you have a PPK2 or a µA meter? It would confirm the power review's estimates.

Details: `docs/firmware/ha-coap-node-power-review.pdf`.

## 4. Finish
Share the test results and decisions with Claude. It updates the code review's status table and PR #6, then you merge PR #6 into `main`.
