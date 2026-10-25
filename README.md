# 📡 OpenThread CoAP Server

![Build](https://github.com/yanntalhouarne/ha-coap-server/actions/workflows/build.yml/badge.svg)
![Version](https://img.shields.io/badge/nRF%20SDK-v2.4.3-blue)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

*Firmware for the ha-coap plant node: a battery-powered Thread device that reports soil moisture, air temperature, humidity and battery level, and runs a water pump, over CoAP.*

## 📋 Overview

The firmware runs on the [ha-coap-pcb](https://github.com/yanntalhouarne/ha-coap-pcb) custom board (Rev 2.0, ACN52840 / nRF52840 module) and talks to Home Assistant through the [ha-coap](https://github.com/yanntalhouarne/ha-coap-integration) custom integration:

- It joins a Thread network as a **sleepy end device** (battery operation).
- It registers itself with the border router's **SRP** server as `ha-coap-<device id>._ot._udp`, so Home Assistant discovers it.
- It serves a small **CoAP API** on port 5683: sensor data, device info, pump control and a ping.
- It can be updated over **USB** or **over the air** (mcumgr over Thread), through the MCUboot bootloader.

Contents:
[Building](#️-building) ·
[First flash](#-first-flash-swd) ·
[Joining a network](#-joining-a-thread-network) ·
[CoAP API](#-coap-api) ·
[LEDs and sounds](#-leds-and-sounds) ·
[Configuration](#️-configuration) ·
[Firmware updates](#-firmware-updates) ·
[Development](#-development) ·
[Troubleshooting](#-troubleshooting)

## 🛠️ Building

Everything the build needs is pinned in this repository: the board definition, the SDK revisions (`application/west.yml`) and the toolchain version (nRF Connect SDK v2.4.3). A fresh clone on any PC builds the same firmware.

### On a new PC
The only prerequisite is [Git](https://git-scm.com/). Everything else is installed by the setup script.

1. **Clone** the repository. On Windows, keep the path short (for example `C:\dev\ha-coap-server`) to stay clear of path-length limits:
   ```
   git clone https://github.com/yanntalhouarne/ha-coap-server.git
   cd ha-coap-server
   ```
2. **Set up**, once per PC. The script downloads `nrfutil` if it isn't installed, installs the nRF Connect SDK v2.4.3 toolchain (about 1 GB), and fetches the pinned SDK into `external/`. Allow 5–15 minutes on a first run:
   - Windows (PowerShell): `powershell -ExecutionPolicy Bypass -File scripts\setup.ps1`
   - Linux: `scripts/setup.sh`
   - macOS: install [nRF Util](https://www.nordicsemi.com/Products/Development-tools/nRF-Util) first, then `scripts/setup.sh`
3. **Build** the production firmware (about 1–2 minutes):
   - Windows (PowerShell): `powershell -ExecutionPolicy Bypass -File scripts\build.ps1`
   - Linux/macOS: `scripts/build.sh`

   Or build from VS Code instead: see [In VS Code](#in-vs-code) below.

The result is in `application/build/zephyr/`:
- `app_update.bin`: the signed update image, for USB or over-the-air updates with mcumgr (the update scripts look here).
- `merged.hex`: MCUboot plus the application, for a first flash over SWD.

Run the setup script again after pulling a change to `application/west.yml` (a new SDK pin). It skips whatever is already installed.

### Variants
`prj.conf` is the production firmware: Thread sleepy end device, with firmware updates over USB and over Thread (mcumgr on UDP port 1337). The other variants add to it:

| Variant | Build directory | Adds |
|---|---|---|
| `battery` (default) | `application/build` | — |
| `usb-logging` | `application/build_usb_logging` | Console and logs on a second USB serial port (`overlay-logging.conf`, `overlay-usb.conf`, `boards/usb-console.overlay`) |
| `uart-console` | `application/build_uart_console` | Console and logs on the J4 UART (`overlay-uart.conf`, `overlay-logging.conf`, `boards/uart.overlay`) |
| `debug` | `application/build_debug` | Asserts, `-Og` and thread info (`overlay-debug.conf`) |

For example `scripts\build.ps1 usb-logging` or `scripts/build.sh usb-logging`. Extra arguments go to CMake (see [Configuration](#️-configuration)). The scripts always build from a clean build directory, so settings from an earlier build never carry over.

All variants keep both update paths (USB and over the air), so any of them can be flashed and later replaced without SWD.

### In VS Code
1. Open the repository folder and install the recommended **nRF Connect for VS Code Extension Pack** when prompted.
2. In the nRF Connect panel, check that the toolchain is v2.4.3 and the SDK is the one in `external/`. Run the setup script first if either is missing.
3. Add a build configuration for `application`: board `hacoap`, build directory `build`, nothing else. For a variant, add its `.conf` files under **Kconfig fragments** and its overlay under **extra** devicetree overlays (not the base overlays, which would replace the board's defaults).

If a build configuration was created before the build files changed, delete it (and its build directory) and add it again: CMake caches the old file list.

### From a terminal
In a toolchain shell (`nrfutil toolchain-manager launch --ncs-version v2.4.3 --shell`, or the nRF Connect terminal in VS Code), from the repository root:
```
west build -p -d application/build application
```
The board defaults to `hacoap`, and `CMakeLists.txt` adds `application/` to the board roots, so no other arguments are needed.

### Continuous integration
`.github/workflows/build.yml` runs `scripts/setup.sh` and builds every variant on each push and pull request, so a change that breaks a clean build is caught right away. The production `app_update.bin` and `merged.hex` are attached to each run as artifacts (Actions tab → the run → Artifacts).

## 🔌 First flash (SWD)

A new board, or one whose bootloader needs replacing, is flashed over SWD through the Tag-Connect footprint on the ACN52840 module. You need a J-Link (or an nRF52/nRF53 DK used as a programmer), plus SEGGER J-Link Software and Nordic's [nRF Command Line Tools](https://www.nordicsemi.com/Products/Development-tools/nRF-Command-Line-Tools) (`nrfjprog`).

From a toolchain shell, after building:
```
west flash -d application/build --erase
```
or directly: `nrfjprog --program application/build/zephyr/merged.hex --chiperase --verify --reset`.

`--erase` / `--chiperase` wipes the whole chip, including the stored Thread network credentials, so the board has to [join a network](#-joining-a-thread-network) again afterwards. After the first flash, use [firmware updates](#-firmware-updates) instead: they keep the credentials.

## 🧵 Joining a Thread network

The device joins with Thread commissioning: at boot, if it has no network credentials, it starts the **Joiner** with the pre-shared key `J01NU5` (`CONFIG_OPENTHREAD_JOINER_PSKD` in `prj.conf`).

1. On the border router, start a commissioner and allow joiners:
   ```
   ot-ctl commissioner start
   ot-ctl commissioner joiner add * J01NU5
   ```
   On a standalone OTBR, run these as they are. With the Home Assistant OpenThread Border Router add-on, `ot-ctl` runs inside the add-on's container. From a shell on the Home Assistant host (on Home Assistant OS, the *Advanced SSH & Web Terminal* add-on with protection mode off), find the container's name, then prefix each command with `docker exec <name>`:
   ```
   docker ps --format '{{.Names}}' | grep -i openthread    # usually addon_core_openthread_border_router
   docker exec addon_core_openthread_border_router ot-ctl commissioner start
   docker exec addon_core_openthread_border_router ot-ctl commissioner joiner add * J01NU5
   ```
2. Reset or power-cycle the board. The joiner only runs at boot, so start the commissioner first. Joining can take a minute or two.
3. Once attached, the device registers with SRP (blue LED, then three beeps) and the ha-coap integration discovers it.

The credentials are stored in flash and survive resets and firmware updates. A board only forgets them with a full chip erase.

## 📨 CoAP API

All resources are on UDP port 5683 at the device's IPv6 address. Payloads are raw bytes.

| Resource | Requests | Request payload | Response payload |
|---|---|---|---|
| `data` | GET | — | 4 bytes: soil moisture %, battery %, air humidity %, temperature °C (signed int8). A missing sensor reads 0. |
| `info` | GET | — | ASCII `"<firmware>,<hardware>,<device id>"` plus a NUL, for example `f83f898,v2.0,1a2b3c4d`. The firmware version is the git commit it was built from. |
| `pump` | GET, confirmable PUT | `'1'` start, `'0'` stop | 1 byte: 1 while the pump runs, else 0 |
| `pumpdc` | GET, confirmable PUT | One ASCII digit: the pump run time in seconds (1 to `CONFIG_HACOAP_PUMP_MAX_DURATION`) | 1 byte: the run time in use. Out-of-range values keep the current one. Not kept across resets. |
| `ping` | PUT | `'1'` beep, `'0'` quiet | none (2.04 Changed) |

`data` returns the latest readings without waiting on the sensors. They are sampled at boot and then every `CONFIG_HACOAP_SENSOR_SAMPLE_PERIOD_S` (300 s by default), so a reading can be up to one period old.

Examples with libcoap's `coap-client`:
```bash
avahi-browse -r _ot._udp                                   # find devices and their addresses
coap-client -m get coap://[fd49:969:3c3c:1:88a2:4c28:69ec:34f7]/data
coap-client -m put -e 1 coap://[fd49:969:3c3c:1:88a2:4c28:69ec:34f7]/pump
coap-client -m put -e 5 coap://[fd49:969:3c3c:1:88a2:4c28:69ec:34f7]/pumpdc
coap-client -m put -e 1 coap://[fd49:969:3c3c:1:88a2:4c28:69ec:34f7]/ping
```

As a sleepy end device, the board picks up messages from its parent once per poll period (`CONFIG_OPENTHREAD_POLL_PERIOD`, 1 s), so responses can take up to a second.

### SRP registration
- The SRP host name and service instance are `ha-coap-<suffix>`, and the service is `_ot._udp`. The integration uses the part after the `-` as the device's unique ID.
- The suffix is the factory device ID by default (`CONFIG_HACOAP_SRP_SUFFIX_DEVICE_ID`). It can instead be a random number (`_SUFFIX_RANDOM`), a fixed ID (`_SUFFIX_MANUAL` with `CONFIG_HACOAP_SRP_MANUAL_ID`) or nothing (`_SUFFIX_NONE`, one device per network only). The prefixes are `CONFIG_HACOAP_SRP_HOSTNAME` and `CONFIG_HACOAP_SRP_SERVICE_INSTANCE`.
- The SRP server rejects duplicate host names, so every device needs a unique suffix.
- OpenThread stores the SRP key in flash. If a board is fully erased, its new key no longer matches the server's record of that host name, and registration fails until the old entry expires or is removed on the server.

## 💡 LEDs and sounds

| Indication | Meaning |
|---|---|
| Green blinks with three rising beeps | Initialization done, starting Thread |
| Red + green on | Not on a Thread network: not commissioned yet, or detached |
| Blue on | Attached, waiting for the first SRP registration |
| All off, three beeps | Registered with SRP: normal operation |
| 2 red blinks at boot, then red on | HDC1080 (air sensor) not found |
| 3 red blinks at boot, then red on | Fuel gauge not found |
| Red on | Another initialization error (soil sensor, USB, pump, CoAP or Thread). The log says which. |
| User LED (blue, LED2) on, one beep | Pump running |
| Six beeps | `ping` with `'1'` |

A missing sensor doesn't stop the boot: the device still joins the network, so it stays reachable for updates. The red LED clears once it attaches.

## ⚙️ Configuration

The application's settings are Kconfig options, declared in `application/Kconfig` (menu "ha-coap application"). The build turns the chosen values into macros, such as `#define CONFIG_HACOAP_SENSOR_SAMPLE_PERIOD_S 300`, in a generated header that every source file includes. The code uses them like any other macro, so a setting can change without editing code. It's all compile time: a new value takes effect after a rebuild and a firmware update.

| Option | Default | |
|---|---|---|
| `CONFIG_HACOAP_HW_VERSION` | `"v2.0"` | Board revision reported in `info` |
| `CONFIG_HACOAP_BOOT_DELAY_MS` | 2150 | Delay at the start of `main()` |
| `CONFIG_HACOAP_PUMP_DEFAULT_DURATION` | 1 | Pump run time after boot (s) |
| `CONFIG_HACOAP_PUMP_MAX_DURATION` | 9 | Longest run time `pumpdc` can set (s, at most 9) |
| `CONFIG_HACOAP_SENSOR_SAMPLE_PERIOD_S` | 300 | Sensor sampling period (s). Shorter means fresher data and more power. |
| `CONFIG_HACOAP_SOIL_POWER_UP_MS` | 200 | Soil sensor settling time before sampling |
| `CONFIG_HACOAP_SOIL_DRY_MV` / `CONFIG_HACOAP_SOIL_WET_MV` | 2200 / 980 | Soil sensor calibration: output at 0% and 100% |
| `CONFIG_HACOAP_WDT_TIMEOUT_MS` / `CONFIG_HACOAP_WDT_FEED_PERIOD_MS` | 30000 / 10000 | Watchdog timeout and feed period |
| `CONFIG_HACOAP_SRP_*` | see [SRP registration](#srp-registration) | SRP names |

Standard Zephyr and OpenThread options work the same way, for example `CONFIG_OPENTHREAD_POLL_PERIOD` or `CONFIG_BOARD_ENABLE_DCDC`.

### Setting a value
If an option is set in several places, the later one wins: the default in `Kconfig`, then `prj.conf`, then a variant's `.conf` files, then the command line.

| To change it… | Do this |
|---|---|
| For every build | Add a line to `application/prj.conf`: `CONFIG_HACOAP_SENSOR_SAMPLE_PERIOD_S=900` |
| For one build | `scripts\build.ps1 battery "-DCONFIG_HACOAP_SENSOR_SAMPLE_PERIOD_S=900"` or `scripts/build.sh battery -DCONFIG_HACOAP_SENSOR_SAMPLE_PERIOD_S=900`. In PowerShell, quote arguments that contain a dot or a semicolon. |
| In VS Code | In the build configuration, add it under extra CMake arguments, or put it in a `.conf` file and add that under Kconfig fragments |
| For a group of boards | Put your lines in a file such as `application/greenhouse.conf` and pass `-DEXTRA_CONF_FILE=greenhouse.conf` |

- String options need quotes: `CONFIG_HACOAP_HW_VERSION="v2.1"`.
- Out-of-range values stop the build (`Aborting due to Kconfig warnings`, naming the option), and so do inconsistent ones (a dry soil voltage not above the wet one, or a watchdog feed period not shorter than its timeout).
- `west build -t menuconfig` (or the Kconfig view in VS Code) browses every option, but its changes live only in that build directory and are lost at the next clean build. Use it to explore, then put what you keep in a `.conf` file.
- To see what a build used, open `application/build/zephyr/.config` and search for the option.

Values that aren't meant to change between builds, like the buzzer tones or which LED is which, are plain `#define`s in their `.c` files.

## 📲 Firmware updates

Updates go through MCUboot with [mcumgr](https://github.com/apache/mynewt-mcumgr-cli), over USB or over Thread. Install the mcumgr CLI with `go install github.com/apache/mynewt-mcumgr-cli/mcumgr@latest`, or with `scripts/install-dependencies.sh` on Linux.

### Connections
- **USB**: the board's first USB serial port (the `usb-logging` variant adds a second one for the console).
  ```bash
  mcumgr conn add serial type="serial" connstring="COM7,baud=115200,mtu=512"    # or /dev/ttyACM0
  ```
- **Over the air**: UDP port 1337 at the device's IPv6 address (from `avahi-browse -r _ot._udp`). The PC needs a route to the Thread network, which a Home Assistant OTBR normally provides on the LAN.
  ```bash
  mcumgr conn add udp type="udp" connstring="[fd49:969:3c3c:1:8c6a:5db:a6ef:178f]:1337"
  ```

### Updating one device
Replace `serial` with `udp` for an over-the-air update.
```bash
mcumgr -c serial image list                                   # slot 0 is the running image
mcumgr -c serial image upload application/build/zephyr/app_update.bin
mcumgr -c serial image list                                   # note the new image's hash in slot 1
mcumgr -c serial image test <new hash>                        # boot it once, as a trial
mcumgr -c serial reset
# after the device is back and working:
mcumgr -c serial image confirm                                # keep it
```
If the new image doesn't work and the device resets (including through the watchdog) before it's confirmed, MCUboot goes back to the previous image. `scripts/get-image-hash.sh` prints the hash of a built image.

### Scripts
- `scripts/mcumgr-dfu.sh`: guided update of one device.
- `scripts/mcumgr-update-all.sh`: updates several devices, discovered with `avahi-browse`. It also runs non-interactively from environment variables (`HACOAP_NON_INTERACTIVE`, `HACOAP_DEVICES`, `HACOAP_UPDATE_MODE`, …; see the top of the script).
- `firmware-updater/`: a web interface that drives `mcumgr-update-all.sh`. See [firmware-updater/README.md](firmware-updater/README.md).

### Keeping updates compatible
- MCUboot itself can't be updated with mcumgr. A new application image must fit the bootloader already on the boards: keep the same signing key and partition layout, and don't change MCUboot's size or the partition settings.
- Images are signed with MCUboot's **default development key**, which anyone with the SDK has. Anyone who can reach UDP port 1337 on the Thread network, or the USB port, could install firmware. Moving to a private key needs a bootloader reflash over SWD on every board.
- An update only works over the air if the image running on the device includes mcumgr over UDP. All variants of this firmware do.

## 🧑‍💻 Development

### Repository layout
| Path | Contents |
|---|---|
| `application/` | The Zephyr application, and the west manifest (`west.yml`) |
| `application/boards/arm/hacoap/` | The `hacoap` board definition (devicetree, pin control, defconfig) |
| `application/boards/*.overlay`, `application/overlay-*.conf` | Add-ons for the [variants](#variants) |
| `scripts/` | Setup, build and firmware update scripts |
| `firmware-updater/` | Web interface for batch updates |
| `docs/` | Schematic, code and power reviews (PDF) |
| `external/` | The SDK, fetched by the setup script (not in git) |

### Source layout
| File | Purpose |
|---|---|
| `src/main.c` | Startup order, Thread state handling, and the glue between the CoAP API and the modules |
| `src/coap_resources.c` | The CoAP API: one table entry per resource, and a shared dispatcher that checks request types |
| `src/pump.c` | Timed pump runs, from CoAP or the S1 button |
| `src/sensors.c` | Soil, battery and air readings, sampled periodically and cached |
| `src/buzzer.c` | Beep patterns |
| `src/status_led.c` | Network and error states on the module's RGB LED, and the user LED |
| `src/srp.c` | SRP service registration |
| `src/watchdog.c` | Hardware watchdog |

CoAP handlers run in the OpenThread thread and must not block: anything slow (like sampling the sensors) runs elsewhere and the handler returns cached data.

To add a CoAP resource, add a row to the `resources` table in `coap_resources.c` with its URI, the requests it accepts and a handler, then a callback in `struct coap_resources_handlers` if it needs application data.

### Logs
Build the `usb-logging` variant and open the second USB serial port, or `uart-console` and use the J4 UART (115200 baud). Log levels are set in `overlay-logging.conf` (`CONFIG_COAP_SERVER_LOG_LEVEL_*` for the application, `CONFIG_COAP_RESOURCES_LOG_LEVEL_*` for the CoAP layer).

### Updating the SDK
The SDK comes from forks of `sdk-nrf` and `sdk-zephyr`, pinned to exact commits in `application/west.yml`. To move to newer commits, update both `revision:` lines, run the setup script, build every variant, and push: CI checks the result on a clean machine. Every other PC picks up the change by running the setup script again.

### Board notes
- **DC/DC regulator**: the board enables the nRF52840's DC/DC regulator (`CONFIG_BOARD_ENABLE_DCDC`, default `y`), since the ACN52840 module includes the converter components. If a board doesn't boot with it, turn it off for both the app and MCUboot (`-DCONFIG_BOARD_ENABLE_DCDC=n -Dmcuboot_CONFIG_BOARD_ENABLE_DCDC=n`) and reflash over SWD.
- **Watchdog**: the application starts a 30 s hardware watchdog, fed every 10 s from the system work queue. A watchdog reset during an MCUboot test boot reverts to the previous image.
- **UART0** is disabled unless the `uart-console` variant enables it, since its receiver draws current in sleep.
- **Time-of-flight sensor**: the VL53L0X node is disabled in the board DTS while it's unused. To use it, set its `status` to `"okay"` and add `CONFIG_VL53L0X=y`.

### Documentation
- [Schematic review, Rev 2.0](docs/hardware/ha-coap-node-rev2.0-schematic-review.pdf)
- [Code review](docs/firmware/ha-coap-server-code-review.pdf)
- [Power review](docs/firmware/ha-coap-node-power-review.pdf): where the battery current goes, and what to change

## 🩺 Troubleshooting

| Problem | Fix |
|---|---|
| `No board named 'hacoap' found`, or a missing `.overlay`/`.conf` file | A build configuration or build directory from before the build files changed. Delete it and build again (the scripts always do a clean build). |
| PowerShell says running scripts is disabled | Run the scripts as `powershell -ExecutionPolicy Bypass -File scripts\setup.ps1` |
| Errors about paths or files that don't exist, on Windows | The clone path is too long: clone to a short path like `C:\dev\ha-coap-server` |
| `Aborting due to Kconfig warnings` | A configuration value is out of range or unknown; the lines above it name the option |
| `region 'FLASH' overflowed` | The image doesn't fit the 483 KB application slot. `-Og` (`overlay-debug.conf`) and logging don't fit together. |
| The device doesn't join (red + green stay on) | Start the commissioner on the border router, then reset the board: the joiner only runs at boot |
| Blue LED stays on | SRP registration isn't succeeding: check that the border router is running, and look for a duplicate host name |
| A new board doesn't boot after the first flash | Try with DC/DC disabled (see [Board notes](#board-notes)) |
| mcumgr over UDP times out | Check the route to the Thread network from the PC (`ping -6 <device address>`), and that the device is attached |

## 📝 Roadmap

- [ ] Implement dynamic SRP client hostname reassignment when duplicates are detected
- [x] Refactor SRP functionality out of `coap_server.c` (now `src/srp.c`)

## 📚 References

- [OpenThread Documentation](https://openthread.io/guides)
- [nRF Connect SDK v2.4.3 Documentation](https://developer.nordicsemi.com/nRF_Connect_SDK/doc/2.4.3/nrf/index.html)
- [CoAP Protocol RFC 7252](https://tools.ietf.org/html/rfc7252)
- [mcumgr CLI](https://github.com/apache/mynewt-mcumgr-cli)

## ⚖️ License

This project is licensed under the [MIT License](LICENSE). Files that come from Nordic Semiconductor or Zephyr (marked with their own `SPDX-License-Identifier` headers) keep their original licenses.
