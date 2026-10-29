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
- **Check my connection:** border router, mDNS, the route to the Thread network, and each board's CoAP and mcumgr speed with an update time estimate; a failed step says what usually fixes it.
- **Battery drain by firmware:** % per day under each image, per device and for the fleet, leaving out charging and the time around updates.
- **Running in the background:** start with the computer (no admin rights), a second start opens the running app, **Stop the app**, and a log file.
- **Home Assistant history:** imports the boards' readings from Home Assistant, matched by device ID; the token stays out of backups and reports.
- **Chart markers:** updates, pump runs and parent changes on a device's charts.
- **Plant presets:** a suggested watering target for about 30 plants.
- **Labels:** printable per device, on A4 or Letter label sheets or a label printer.
- **Data limits:** how long readings, network history and backups are kept, the data folder's size, and compacting the database.
- **Watering forecast:** when each plant will need water at its drying rate, a "soon" list on the dashboard, and what a pump run raises the soil by.
- **Photo timeline:** several dated photos per plant, with a slider and the soil at each date.
- **Wall display:** full screen, every plant big, for a spare monitor.
- **Weekly summary:** what happened over a week, to print.
- **Demo:** a second app with simulated boards and two weeks of history, in a throwaway data folder.
- **Getting started** checklist on the dashboard, and a pulse on the map when a board answers.
- **A new network map:** the border router in the middle and routers on hop rings (a stable layout that fills the view), boards as their plant photo with a soil gauge, icons for routers, curved links coloured and sized by strength with flowing dashes to the parent, hover to trace a board's way to the border router, a details panel sliding over the map, floating controls and legend, and smooth zoom.
- **A new floor plan:** a dimmed picture, boards as photo pins, thin curved links (which can be hidden), a list of nodes to drag onto the plan, and a smoother heatmap in 5 dB bands with a scale.
- **Devices as cards:** a grid of plant cards (photo, soil gauge, battery, when it needs water), and sorting (needs water soonest, driest, lowest battery, last seen).
- **A device's page** opens with its photo, a big soil gauge, its battery, watering, signal and air, and the quick actions.
- **Charts you can read:** point for the values, drag to zoom into a period, compare up to three plants on the same charts.
- **Update progress as steps:** connect, upload (with the time left), test, reboot, back online, confirm; a failure shows where it stopped.
- **Settings in sections**, with a side menu. **Activity feed** on the dashboard. **?** lists the keyboard shortcuts. A **System** theme that follows the computer's light or dark setting.
- **Accessibility:** keyboard focus shown everywhere, the network map usable from the keyboard, and contrast checked in every theme.
- The page's code is now ES modules, one per tab or feature (static/js), instead of one 3,400-line file.
- The page asks for its scripts and styles at an address that changes with every version (/v/<version>/), so a browser never runs a new page with a script it kept from an older one. If the page's scripts fail to start anyway, it says so at the top, instead of showing no data.
- **Icons** (Lucide) on the tabs, the status bar and the map; 7-day charts in the dashboard's tiles; tabs that fade in and placeholders while cards load.
- **Data:** backups (one file; daily automatic ones, and one before every restore), restore, and the device list as CSV.
- A look after [Omarchy](https://omarchy.org/): a terminal feel, JetBrains Mono, 12 colour themes (Tokyo Night by default, **T** cycles them) with Home Assistant's blue as the accent, the ha-coap logo, keys 1 to 8 for the tabs, and a status bar.
- Answers only on this computer (127.0.0.1).
