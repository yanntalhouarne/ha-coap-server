# Fleet manager changes

## 0.1.0

First version: the plan's phases 0, 1, 2, 5 and 6. Tested against a simulated device; not yet used with real boards.

- **Devices:** finds devices on the network (mDNS) or by address, and shows their firmware, battery, readings and when they were last seen. Rename, notes, update history, firmware slots, beep.
- **Updates** over the air or USB: upload (resumes after lost packets), trial boot, check that the device came back running the new image, confirm. One device at a time, stopping at the first failure. History of every result.
- **Images:** a library of firmware images, from files or from the builds on this computer.
- **Builds:** build profiles (variant and settings, from the firmware's Kconfig), checks for the toolchain and signing key, builds with a live log.
- **Network:** a map of the Thread mesh from the border router's REST API: routers, children, your boards by name, link strength as line colour and length, and a log of parent changes. Click a board for its plant photo and readings.
- **Dashboard:** devices online, behind the release, never read, low batteries and weak links. Firmware per image, with one click to update the devices behind the release.
- **Device pages:** readings with a battery forecast, firmware compared with the release, pump and buzzer controls, and charts of readings and link strength over up to 90 days.
- **Groups:** location and tags per device, with a filter.
- **Staged updates:** update one device, check it, then continue with the rest.
- **What's new:** the commits between two images built here. **Release:** mark the image the fleet should run.
- **Floor plan:** place the mesh on a picture of your home. **Channel scan:** radio noise on every Thread channel.
- **Console:** a board's serial output, live.
- **Set up this computer:** buttons on the Builds tab install the toolchain and SDK, create the signing key and set the PSKd, and (optional) install the SWD flashing tools.
- **Flash a board over SWD** with a J-Link: a build's MCUboot and application, keeping the board's network or erasing everything. Not yet tried with a real J-Link.
- **Signature check:** each image shows who signed it (your key, MCUboot's development key, another key, unsigned), and an update with an image your boards would refuse needs a confirmation.
- **Battery check:** over the air, devices under 20 % battery are skipped unless included on purpose.
- **Plants:** a photo per device, a watering target per plant (30 % by default), and a "needs water" list with a button to run the pump.
- **Alerts:** a device that stops answering, a low battery, a plant that needs water, a failed update. On the dashboard, in the status bar, and as browser notifications if wanted.
- **Network history:** every reading is kept, with a slider to look back. The app also reads the network at each automatic refresh. **Signal heatmap** on the floor plan and the mesh.
- **Ctrl+K search** for tabs, devices and actions. **With selected:** actions for all the ticked devices.
- **Exports:** readings as CSV, and a problem report (no keys, PSKd blanked out).
- **App update check:** optional, asks GitHub once a day.
- **Phones:** a narrower layout, and pinch to zoom the map.
- **Data:** backups (one file; daily automatic ones, and one before every restore), restore, and the device list as CSV.
- A look after [Omarchy](https://omarchy.org/): a terminal feel, JetBrains Mono, 12 colour themes (Tokyo Night by default, **T** cycles them) with Home Assistant's blue as the accent, the ha-coap logo, keys 1 to 8 for the tabs, and a status bar.
- Answers only on this computer (127.0.0.1).
