# Next steps (updated 2026-11-13)

Start here when you come back. To pick up with Claude, say: *"Resume from docs/NEXT-STEPS.md"*.

## Where things stand

| What | State |
|---|---|
| Boards | Five in use (ha-coap-3, -7, -9, -10, -11) on the `fleet-manager` firmware (66a5646, image 3774d590, Production profile). Boards 4 and 5 are off. Their bootloaders still have **MCUboot's development key**: updates must be signed with it (the Builds tab chooses it) |
| Server | The VM `hacoap` (LAN 192.168.50.178, ZeroTier 10.243.120.130) runs the fleet manager (always on, deployed from `fleet-manager`) and the Thread border router (Docker container `otbr`, its radio dongle passed through from the Proxmox host). See `manager/README.md` → Running it on a server, and Reaching the server |
| Home Assistant | The [HA CoAP integration](https://github.com/yanntalhouarne/ha-coap-integration) v2.3.0: the boards, their pushes, the fleet manager's firmware updates, tanks, battery forecasts, care tasks, and the plant card |
| `main` | Everything, merged from `fleet-manager` on 2026-11-13 ([PR #7](https://github.com/yanntalhouarne/ha-coap-server/pull/7)); PR #6 closed |
| `fleet-manager` | Where the work goes on (the server deploys from it), merged into `main` by pull request now and then |

## Next, in order

1. **Update the boards to the newest firmware** (46cb4b3 or later: the push at the end of each pump run). Builds tab → Production, **sign with: the development key** (preselected) → Build, then Updates.
2. In the integration's repository, close [PR #10](https://github.com/yanntalhouarne/ha-coap-integration/pull/10): version 2 reads negative temperatures already.
3. **Set the plants up**: each plant's tank size (its page → Watering) and care tasks, so they show in the fleet manager and in Home Assistant.
4. **At a board visit, with a J-Link**: flash each board's bootloader made with your own key (Builds tab → Flash a board over SWD, a build signed with your key). From then on, its updates are signed with your key, and anyone with MCUboot's public development key can no longer update it.

## Not tried on the real hardware yet

- Flashing over SWD with a J-Link (no J-Link has been attached).
- Adding boards over the air, and moving the network to another channel (Border router tab): tested only against a simulated border router.
- An update over USB.
- The console over the air (a **Log over the air** build).

## Still to decide

- **PSKd:** left as it is for now (your call, 2026-11-11).
- **Rev 2.1 hardware:** remove the power LED and rework SW2/R36 (about 1.3 mA together, about 100 times what the firmware draws: they decide the battery life).
- **Current measurement:** a PPK2 or a µA meter would confirm the power review's estimates (`docs/firmware/ha-coap-node-power-review.pdf`). The dashboard's **Battery drain by firmware** gives the real drain meanwhile.

## Housekeeping left

- Old branches, all merged into `main` (or abandoned): `build-issue`, `mcu-boot-usb-dual-slots`, `mcu-mgr-udp-ota`, `pwm_integration`, `claude`, `updatehub` and `updatehub-2` (never merged). In the integration's repository: `branch`, `hacs-repo`, `main`, `new-setup`, `signed-temperature`, `v2`, `v2.1`, `zeroconf_discovery`.
- The integration's tag `v2.1.2` was pushed by mistake (it's v2.1.1's commit): never publish it; delete it on GitHub (Tags).
- The macOS run of the fleet manager's tests fails now and then (since 2026-11-10, also on commits that change no code): a flaky test, not found yet. Rerunning the job passes. Since 2026-11-13 CI shows a failing test as an annotation (its name and why), readable without the job's log: the next failure names it.

## Where the details are

- The firmware: `README.md` (building, flashing, joining, the CoAP API, pushes, settings, updates).
- The fleet manager: `manager/README.md`, its changes in `manager/CHANGELOG.md`, and how it was planned in `docs/FLEET-MANAGER-PLAN.md`.
- The reviews: `docs/hardware/` and `docs/firmware/` (PDF).
