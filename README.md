# 📡 OpenThread CoAP Server

![Build](https://github.com/yanntalhouarne/ha-coap-server/actions/workflows/build.yml/badge.svg)
![Version](https://img.shields.io/badge/nRF%20SDK-v2.4.3-blue)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

*Firmware for the ha-coap plant node: a battery-powered Thread device that reports soil moisture, air temperature, humidity and battery level, and runs a water pump, over CoAP.*

## 📋 Overview

The firmware runs on the [ha-coap-pcb](https://github.com/yanntalhouarne/ha-coap-pcb) custom board (Rev 2.0, ACN52840 / nRF52840 module) and talks to Home Assistant through the [ha-coap](https://github.com/yanntalhouarne/ha-coap-integration) custom integration:

- It joins a Thread network as a **sleepy end device** (battery operation).
- It registers itself with the border router's **SRP** server as `ha-coap-<device id>._ot._udp`, so Home Assistant discovers it.
- It serves a small **CoAP API** on port 5683: sensor data, device info, pump control and a ping, and (optionally) its log.
- It can be updated over **USB** or **over the air** (mcumgr over Thread), through the MCUboot bootloader.

Contents:
[Building](#️-building) ·
[Flashing](#-flashing-over-swd) ·
[Joining a network](#-joining-a-thread-network) ·
[CoAP API](#-coap-api) ·
[LEDs and sounds](#-leds-and-sounds) ·
[Configuration](#️-configuration) ·
[Firmware updates](#-firmware-updates) ·
[Security](#-security) ·
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
3. **Add your private settings**: a signing key and a joiner key, which stay out of git. See [Private settings](#private-settings-signing-key-and-pskd) below. This is optional for a test build, but needed for boards you deploy.
4. **Build** the production firmware (about 1–2 minutes):
   - Windows (PowerShell): `powershell -ExecutionPolicy Bypass -File scripts\build.ps1`
   - Linux/macOS: `scripts/build.sh`

   Or build from VS Code instead: see [In VS Code](#in-vs-code) below.

The result is in `application/build/zephyr/`:
- `app_update.bin`: the signed update image, for USB or over-the-air updates with mcumgr (the update scripts look here).
- `merged.hex`: MCUboot plus the application, for flashing over SWD.

Then [flash the board](#-flashing-over-swd) once over SWD, [join it to your Thread network](#-joining-a-thread-network), and use [firmware updates](#-firmware-updates) from then on.

Run the setup script again after pulling a change to `application/west.yml` (a new SDK pin). It skips whatever is already installed.

### Private settings: signing key and PSKd
Two values must not be public, so they live in files that git ignores. Every build (scripts, VS Code or `west`) picks them up automatically:

| File | What it is | Without it |
|---|---|---|
| `application/keys/mcuboot-signing-key.pem` | Your private MCUboot signing key. MCUboot is built with its public half and only boots images signed with it. | The build uses MCUboot's public development key (with a warning). Anyone can sign images for such a board. |
| `application/local.conf` | Private Kconfig settings, merged after `prj.conf`. Mainly your joiner PSKd (`CONFIG_OPENTHREAD_JOINER_PSKD`). | The build uses the public PSKd `J01NU5` (with a warning). |

To create them:
1. **Signing key**, once for all your boards:
   - Windows: `powershell -ExecutionPolicy Bypass -File scripts\keygen.ps1`
   - Linux/macOS: `scripts/keygen.sh`

   The script creates an ECDSA P-256 key and refuses to overwrite an existing one. **Back the key up** (password manager, encrypted drive). Your boards only accept updates signed with it: if it's lost, every board needs a reflash over SWD. To keep the key somewhere else, set the environment variable `HACOAP_SIGNING_KEY` to its path.
2. **PSKd**: copy `application/local.conf.example` to `application/local.conf` and set your own `CONFIG_OPENTHREAD_JOINER_PSKD`: 6 to 32 characters, A–Z and 0–9, without I, O, Q and Z. The build stops if it's invalid.

On another PC, copy both files into the same places in the clone.

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
`.github/workflows/build.yml` runs `scripts/setup.sh` and builds every variant on each push and pull request, so a change that breaks a clean build is caught right away. The production `app_update.bin` and `merged.hex` are attached to each run as artifacts (Actions tab → the run → Artifacts). CI has no private key, so these are signed with the public development key: boards flashed with your key reject them. Build the images you deploy yourself.

## 🔌 Flashing over SWD

Flash over SWD to put a bootloader on a new board, or to replace one (for example, the first time you use your own signing key). Use the Tag-Connect footprint on the ACN52840 module. You need a J-Link (or an nRF52/nRF53 DK used as a programmer), plus SEGGER J-Link Software and Nordic's [nRF Command Line Tools](https://www.nordicsemi.com/Products/Development-tools/nRF-Command-Line-Tools) (`nrfjprog`).

From a toolchain shell, after building:

| Board | Command | Thread credentials |
|---|---|---|
| New board, or a full reset | `west flash -d application/build --erase` | Erased: [join the network](#-joining-a-thread-network) afterwards |
| Already on your network, getting a new bootloader or key | `west flash -d application/build` | Kept: only the flash pages in the image are erased |

Without `west`: `nrfjprog --program application/build/zephyr/merged.hex --chiperase --verify --reset` (or `--sectorerase` instead of `--chiperase` to keep the credentials).

Both write MCUboot and the application together, so the bootloader and the image always match. After that, use [firmware updates](#-firmware-updates).

**From the fleet manager** (`manager/`): its **Builds** tab has **Flash a board over SWD**, which does the same from a page: pick a build and the J-Link, then keep the credentials or erase everything. It uses `nrfutil device` (Nordic's replacement for the nRF Command Line Tools, installed by a button on the same tab) and still needs the J-Link software. It hasn't flashed a real board yet, so the commands above stay the reference until it has.

**Moving existing boards to your own key.** Boards flashed before you created a key run a bootloader that only trusts the public development key, and boards with your key's bootloader only trust your key. A key change can't go through mcumgr. Flash each board once over SWD with a build signed with your key (second row above). From then on, USB and over-the-air updates work as long as you sign with the same key.

## 🧵 Joining a Thread network

The device joins with Thread commissioning: when it has no network credentials, it runs the **Joiner** with its pre-shared key (PSKd), at boot and then again every 30 s for 10 minutes, then every 2 minutes, until it joins (`CONFIG_HACOAP_JOIN_RETRY_*`, `src/joining.c`). So the board can be powered on before or after the commissioner is started. That's the value of `CONFIG_OPENTHREAD_JOINER_PSKD` in your `application/local.conf`, or the public `J01NU5` without it. The Thread network key itself comes from the border router when the device joins; no network credentials are built into the firmware.

1. On the border router, start a commissioner and allow joiners with your PSKd for 5 minutes (300 s; without it, 120 s):
   ```
   ot-ctl commissioner start
   ot-ctl commissioner joiner add * <your PSKd> 300
   ```
   On a standalone OTBR, run these as they are. With the Home Assistant OpenThread Border Router add-on, `ot-ctl` runs inside the add-on's container. From a shell on the Home Assistant host (on Home Assistant OS, the *Advanced SSH & Web Terminal* add-on with protection mode off), find the container's name, then prefix each command with `docker exec <name>`:
   ```
   docker ps --format '{{.Names}}' | grep -i openthread    # usually addon_core_openthread_border_router
   docker exec addon_core_openthread_border_router ot-ctl commissioner start
   docker exec addon_core_openthread_border_router ot-ctl commissioner joiner add * <your PSKd> 300
   ```
2. Power the board on (or leave it on: a board without a network tries again by itself). It joins at its next try: within 30 s in its first 10 minutes, then within 2 minutes. Joining itself can take a minute.
3. Once attached, the device registers with SRP (blue flashes, then three beeps) and the ha-coap integration discovers it.
4. **Stop the commissioner** as soon as the device has joined, so nothing else can join with the PSKd: `ot-ctl commissioner stop` (with the `docker exec` prefix on Home Assistant). The joiner entry also expires on its own after its timeout.

The credentials are stored in flash and survive resets and firmware updates. A board that already joined never runs the joiner again: if its border router goes away, it keeps its network and waits for it.

**To move a board to another network** (for example after making a new network in Home Assistant), make it forget its network, then commission it as above:
- **With the button:** hold S1 while you reset or power on the board, and keep holding it until two long, low beeps (about 5 s after power on), then let go. It forgets its network and restarts, and starts joining.
- **From the fleet manager:** a device's page, **Settings on the board**, **Forget its network…** (over the air or USB; the `hacoap` mcumgr group's command 2).
- Or erase the whole chip over SWD.

Only the network is erased (OpenThread's datasets and network, parent and child info): the board's own settings, boot count and SRP key stay, so it takes back its name `ha-coap-<ID>` on the same border router (see [SRP registration](#srp-registration)). When attached, it first removes its SRP registration, so its name vanishes from the LAN at once.

## 📨 CoAP API

All resources are on UDP port 5683 at the device's IPv6 address. Payloads are raw bytes.

| Resource | Requests | Request payload | Response payload |
|---|---|---|---|
| `data` | GET | — | 4 bytes: soil moisture %, battery %, air humidity %, temperature °C (signed int8). A missing sensor reads 0. |
| `info` | GET | — | ASCII `"<firmware>,<hardware>,<device id>"` plus a NUL, for example `f83f898,v2.0,1a2b3c4d`. The firmware version is the git commit it was built from. |
| `pump` | GET, confirmable PUT | `'1'` start, `'0'` stop | 1 byte: 1 while the pump runs, else 0 |
| `pumpdc` | GET, confirmable PUT | One ASCII digit: the pump run time in seconds (1 to `CONFIG_HACOAP_PUMP_MAX_DURATION`) | 1 byte: the run time in use. Out-of-range values keep the current one. Kept across resets (the board's `pump_s` setting). |
| `ping` | PUT | `'1'` beep, `'0'` quiet | none (2.04 Changed) |
| `diag` | GET | — | ASCII `key=value` pairs, comma-separated: `boots` (since its flash was erased), `up` (seconds), `reset` (why it last restarted: `power`, `pin`, `soft`, `watchdog`, `lockup`, `crash` or `other`), `fault` (after a crash: `<reason>@<address>`), `role`, `srp` (its name's registration: `registered`, `pending`, `failed` or `off`), and when attached `rloc` (its short address), `parent`, `rssi` and `last_rssi` (dBm), `lq` (0 to 3), then `soil_mv` (the soil sensor's output, -1 if not read). For example `boots=12,up=3600,reset=power,role=child,srp=registered,rloc=5c01,parent=5c00,rssi=-62,last_rssi=-60,lq=3,soil_mv=1696`. Older firmware doesn't answer it. See [Restarts and crashes](#restarts-and-crashes). |
| `log` | GET, with the query `from=<offset>` | — | ASCII `<boot id> <start>` and a line feed, then the log output from byte `start` (at most 512 bytes in all). Only with `CONFIG_HACOAP_REMOTE_LOG`; otherwise 4.04 Not Found. See [Logs](#logs). |

`data` returns the latest readings without waiting on the sensors. They are sampled at boot and then every `CONFIG_HACOAP_SENSOR_SAMPLE_PERIOD_S` (900 s by default), so a reading can be up to one period old.

Examples with libcoap's `coap-client`:
```bash
avahi-browse -r _ot._udp                                   # find devices and their addresses
coap-client -m get coap://[fd49:969:3c3c:1:88a2:4c28:69ec:34f7]/data
coap-client -m put -e 1 coap://[fd49:969:3c3c:1:88a2:4c28:69ec:34f7]/pump
coap-client -m put -e 5 coap://[fd49:969:3c3c:1:88a2:4c28:69ec:34f7]/pumpdc
coap-client -m put -e 1 coap://[fd49:969:3c3c:1:88a2:4c28:69ec:34f7]/ping
```

As a sleepy end device, the board picks up messages from its parent once per poll period (`CONFIG_OPENTHREAD_POLL_PERIOD`, 3 s), so responses can take up to 3 seconds. The integration waits 10 s for a reply, so this is within its limits. While mcumgr is in use, or someone reads `log`, the device polls every 100 ms instead (see [Keeping updates compatible](#keeping-updates-compatible)).

### SRP registration
How Home Assistant and the fleet manager find a board. A Thread board doesn't answer mDNS itself (multicast is costly on the mesh, and a sleepy board would miss most queries). Instead, once attached, it **registers** its name and service with the SRP server on the border router (Service Registration Protocol), in one unicast message, and the border router answers mDNS on the LAN for it.
- The registration is a **lease**: the border router advertises the board for `CONFIG_HACOAP_SRP_LEASE_S` (30 minutes) after its last registration, and the board renews it before then. A board that's gone (dead battery, moved) disappears from the LAN within that time. (OpenThread's default is 2 hours.)
- The board signs its registrations with its own **key**, kept in flash. The border router keeps the name for that key for 14 days after the last registration (the key lease), so nothing else can take it over.
- Its **TXT records** say what it is: `id` (device ID), `fw` (git commit), `hw` (board revision) and `ver` (image version, such as `1.0.0+0`). The fleet manager's **Find devices** reads them; Home Assistant ignores them.
- `diag` reports the registration's state (`srp=registered`, `pending`, `failed`, or `off` before the board is on a network), and the fleet manager shows it on the board's page (Health, **Its name**).
- The SRP host name and service instance are `ha-coap-<suffix>`, and the service is `_ot._udp`. The integration uses the part after the `-` as the device's unique ID.
- The suffix is the factory device ID by default (`CONFIG_HACOAP_SRP_SUFFIX_DEVICE_ID`). It can instead be a random number (`_SUFFIX_RANDOM`), a fixed ID (`_SUFFIX_MANUAL` with `CONFIG_HACOAP_SRP_MANUAL_ID`) or nothing (`_SUFFIX_NONE`, one device per network only). The prefixes are `CONFIG_HACOAP_SRP_HOSTNAME` and `CONFIG_HACOAP_SRP_SERVICE_INSTANCE`.
- The SRP server rejects duplicate host names, so every device needs a unique suffix.
- OpenThread stores the SRP key in flash. If a board is fully erased (SWD, **Erase everything**), its new key no longer matches the border router's record of that host name, and registration fails (`srp=failed`, blue flashes without the three beeps) until the old entry's key lease ends: up to 14 days after its last registration. **Forgetting the network** (S1 at boot, or the fleet manager) keeps the key: the board removes its registration first (its name vanishes from the LAN at once) and takes its name back when it joins again.

## 💡 LEDs and sounds

To save the battery, the RGB LED never stays on. It shows each state as a short flash every 5 s, and stops 5 minutes after the last change (`CONFIG_HACOAP_STATUS_LED_TIMEOUT_S`). To see the state again, reset the board.

| Indication | Meaning |
|---|---|
| Green blinks with three rising beeps | Initialization done, starting Thread |
| Red + green (yellow) flashes | Not on a Thread network: not commissioned yet (it keeps trying to join), or detached |
| Two long, low beeps (S1 held at boot) | Forgetting its network: let go of S1. It restarts and joins again |
| Blue flashes | Attached, waiting for the first SRP registration |
| No flashes, three beeps | Registered with SRP: normal operation |
| 2 red blinks at boot, then red flashes | HDC1080 (air sensor) not found |
| 3 red blinks at boot, then red flashes | Fuel gauge not found |
| Red flashes | Another initialization error (soil sensor, USB, pump, CoAP or Thread). The log says which. |
| User LED (blue, LED2) on, one beep | Pump running |
| Six beeps | `ping` with `'1'` |

A missing sensor doesn't stop the boot: the device still joins the network, so it stays reachable for updates. Red is added to the flashes until the device attaches.

## ⚙️ Configuration

The application's settings are Kconfig options, declared in `application/Kconfig` (menu "ha-coap application"). The build turns the chosen values into macros, such as `#define CONFIG_HACOAP_SENSOR_SAMPLE_PERIOD_S 900`, in a generated header that every source file includes. The code uses them like any other macro, so a setting can change without editing code. It's all compile time: a new value takes effect after a rebuild and a firmware update.

| Option | Default | |
|---|---|---|
| `CONFIG_HACOAP_HW_VERSION` | `"v2.0"` | Board revision reported in `info` |
| `CONFIG_HACOAP_BOOT_DELAY_MS` | 2150 | Delay at the start of `main()` |
| `CONFIG_HACOAP_STATUS_LED_TIMEOUT_S` | 300 | How long the RGB LED flashes a state (s). 0 flashes for as long as the state lasts. |
| `CONFIG_HACOAP_MCUMGR_POLL_PERIOD_MS` / `CONFIG_HACOAP_MCUMGR_POLL_TIMEOUT_S` | 100 / 30 | Thread poll period while mcumgr is in use (or `log` is read), and how long it lasts after the last request |
| `CONFIG_HACOAP_REMOTE_LOG` / `CONFIG_HACOAP_REMOTE_LOG_BUFFER_SIZE` | n / 4096 | The log over the air (the `log` resource), and how much of it the board keeps (bytes). See [Logs](#logs). |
| `CONFIG_HACOAP_PUMP_DEFAULT_DURATION` | 1 | Pump run time after boot (s) |
| `CONFIG_HACOAP_PUMP_MAX_DURATION` | 9 | Longest run time `pumpdc` can set (s, at most 9) |
| `CONFIG_HACOAP_SENSOR_SAMPLE_PERIOD_S` | 900 | Sensor sampling period (s). Shorter means fresher data and more power. |
| `CONFIG_HACOAP_SOIL_POWER_UP_MS` | 200 | Soil sensor settling time before sampling |
| `CONFIG_HACOAP_SOIL_DRY_MV` / `CONFIG_HACOAP_SOIL_WET_MV` | 2200 / 980 | Soil sensor calibration: output at 0% and 100% |
| `CONFIG_HACOAP_WDT_TIMEOUT_MS` / `CONFIG_HACOAP_WDT_FEED_PERIOD_MS` | 30000 / 10000 | Watchdog timeout and feed period |
| `CONFIG_HACOAP_SRP_*` | see [SRP registration](#srp-registration) | SRP names |

Standard Zephyr and OpenThread options work the same way, for example `CONFIG_OPENTHREAD_POLL_PERIOD` or `CONFIG_BOARD_ENABLE_DCDC`.

### Settings that change without a new firmware
Five of these are only the defaults: a board keeps its own value in flash (Zephyr's settings, under `hacoap/`, next to OpenThread's data), through restarts and updates, and the fleet manager changes it over the air or over USB (a device's page, **Settings on the board**).

| Setting | Default from | Range |
|---|---|---|
| `sample_s`: sampling period (s) | `CONFIG_HACOAP_SENSOR_SAMPLE_PERIOD_S` | 10 to 86400 |
| `pump_s`: pump run time (s) | `CONFIG_HACOAP_PUMP_DEFAULT_DURATION` | 1 to `CONFIG_HACOAP_PUMP_MAX_DURATION` |
| `poll_ms`: Thread poll period (ms) | `CONFIG_OPENTHREAD_POLL_PERIOD` | above `CONFIG_HACOAP_MCUMGR_POLL_PERIOD_MS`, to 600000 |
| `soil_dry_mv` / `soil_wet_mv`: the soil sensor's output when dry (0 %) and wet (100 %) | `CONFIG_HACOAP_SOIL_DRY_MV` / `CONFIG_HACOAP_SOIL_WET_MV` | 1 to 3600 / 0 to 3599, dry above wet |

A `pumpdc` PUT changes `pump_s` too, so the run time Home Assistant sets is now kept across resets. They go through the `hacoap` mcumgr group (64, `src/hacoap_mgmt.c`), which works over USB and over the air like the other mcumgr groups:
- command 0, read: `{"settings": {"<name>": [value, default, min, max], ...}, "soil_mv": <latest soil sensor output>, "samples": <samples since boot>}`
- command 0, write: `{"set": {"<name>": value, ...}}`: all of them or none (`MGMT_ERR_EINVAL` for an unknown name, a value out of range, or dry at or below wet); answers like a read
- command 1, write: `{}`: takes a sensor sample now (for calibrating); answers `{"samples": <the count before it>}`
- command 2, write: `{}`: forgets the Thread network (keeping its SRP key, and removing its registration first) and resets, to join another one (see [Joining a Thread network](#-joining-a-thread-network)); answers `{}` first

A change applies at once, and is written to flash from the system work queue. Erasing the board's flash (SWD, **Erase everything**) brings back the defaults.

### Setting a value
If an option is set in several places, the later one wins: the default in `Kconfig`, then `prj.conf`, then `local.conf` and a variant's `.conf` files, then the command line.

| To change it… | Do this |
|---|---|
| For every build | Add a line to `application/prj.conf`: `CONFIG_HACOAP_SENSOR_SAMPLE_PERIOD_S=1800` |
| For every build, privately | Add it to `application/local.conf` (not in git, see [Private settings](#private-settings-signing-key-and-pskd)) |
| For one build | `scripts\build.ps1 battery "-DCONFIG_HACOAP_SENSOR_SAMPLE_PERIOD_S=1800"` or `scripts/build.sh battery -DCONFIG_HACOAP_SENSOR_SAMPLE_PERIOD_S=1800`. In PowerShell, quote arguments that contain a dot or a semicolon. |
| In VS Code | In the build configuration, add it under extra CMake arguments, or put it in a `.conf` file and add that under Kconfig fragments |
| For a group of boards | Put your lines in a file such as `application/greenhouse.conf` and pass `-DEXTRA_CONF_FILE=greenhouse.conf` |
| From the fleet manager | Make a build profile on its **Builds** tab. It passes the settings to `scripts/build` in a file named by the `HACOAP_EXTRA_CONF` environment variable, which `CMakeLists.txt` merges after `local.conf` |

- String options need quotes: `CONFIG_HACOAP_HW_VERSION="v2.1"`.
- Out-of-range values stop the build (`Aborting due to Kconfig warnings`, naming the option), and so do inconsistent ones (a dry soil voltage not above the wet one, or a watchdog feed period not shorter than its timeout).
- `west build -t menuconfig` (or the Kconfig view in VS Code) browses every option, but its changes live only in that build directory and are lost at the next clean build. Use it to explore, then put what you keep in a `.conf` file.
- To see what a build used, open `application/build/zephyr/.config` and search for the option.

Values that aren't meant to change between builds, like the buzzer tones or which LED is which, are plain `#define`s in their `.c` files.

## 📲 Firmware updates

Updates go through MCUboot with [mcumgr](https://github.com/apache/mynewt-mcumgr-cli), over USB or over Thread. A board only installs images signed with the same key as its bootloader: build updates on a PC that has your [signing key](#private-settings-signing-key-and-pskd). Install the mcumgr CLI with Go (`go install github.com/apache/mynewt-mcumgr-cli/mcumgr@latest`, then add Go's `bin` directory to your PATH), or with `scripts/install-dependencies.sh` on Debian or Ubuntu.

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
The update scripts run on Linux, macOS and Windows (in Git Bash), from any folder, and use `application/build` unless `HACOAP_BUILD_DIR` says otherwise.

- `scripts/mcumgr-dfu.sh`: guided update of one device, over USB or over the air.
- `scripts/mcumgr-update-all.sh`: updates several devices at once, with upload retries and stall detection. It also runs non-interactively from environment variables (`HACOAP_NON_INTERACTIVE`, `HACOAP_DEVICES`, `HACOAP_UPDATE_MODE`, …; see the top of the script).
- `firmware-updater/`: a web interface that drives `mcumgr-update-all.sh`. See [firmware-updater/README.md](firmware-updater/README.md).

What they need:

| | Linux | macOS | Windows |
|---|---|---|---|
| Shell | bash | the built-in bash | [Git Bash](https://git-scm.com/) |
| mcumgr | Go, then `go install …` (above) | `brew install go`, then `go install …` | `winget install GoLang.Go`, then `go install …` |
| Python 3.7+ | usually installed | `xcode-select --install` | `winget install Python.Python.3.12` |
| Device discovery (optional) | `sudo apt install avahi-utils` | `python3 -m pip install --user zeroconf` | `py -m pip install zeroconf` |

- **Without device discovery**, the scripts ask for the devices' IPv6 addresses instead.
- **For USB**, they list the serial ports, with the board's first when they can tell (always on Windows, and with `pip install pyserial` on Linux and macOS). If they list nothing, type the port name: `COM7` on Windows, `/dev/ttyACM0` on Linux, `/dev/cu.usbmodem…` on macOS.
- **Tests:** `scripts/tests/test-scripts.sh` runs them against a fake `mcumgr`. CI runs it on all three systems.

### Versions
Each image carries a version in its MCUboot header, from `application/VERSION` (Zephyr's format: `VERSION_MAJOR`, `VERSION_MINOR`, `PATCHLEVEL`, and `VERSION_TWEAK` as a build number). `mcumgr image list` and the fleet manager show it, and the build prints it (`Image version: 1.0.0+0`). Raise it for each firmware release you send to the boards, so you can tell images apart at a glance. It's informational: MCUboot doesn't refuse older versions here, so a downgrade still works. The git commit stays in `info`, as before.

### Keeping updates compatible
- MCUboot itself can't be updated with mcumgr. A new application image must fit the bootloader already on the boards: sign it with the same key, keep the same partition layout, and don't change MCUboot's size or the partition settings.
- An image signed with a different key uploads without error, but MCUboot refuses to boot it and keeps running the old image. To change keys, reflash over SWD (see [Moving existing boards to your own key](#-flashing-over-swd)).
- An update only works over the air if the image running on the device includes mcumgr over UDP. All variants of this firmware do.
- **Speed over the air:** the first mcumgr command can take up to one poll period (3 s) to reach the device. From then on, the device polls every 100 ms until 30 s after the last command, so the long poll period doesn't slow uploads down. Images built before this change don't do that, so the update that replaces them is slower.

## 🔒 Security

What protects a deployed device, and what's left open:

| Area | Protection | What's still open |
|---|---|---|
| Thread network | Joined by commissioning: the network key comes from the border router and is stored on the device, never in the firmware or this repository | Anyone in radio range who knows the PSKd can join while the commissioner accepts joiners. Use your own PSKd ([Private settings](#private-settings-signing-key-and-pskd)) and stop the commissioner after each join. |
| Firmware updates | MCUboot only boots images signed with your private key | mcumgr itself has no authentication: anyone who can reach UDP port 1337 (any device on your LAN, through the border router) or the USB port can upload or erase the update slot, or reset the device. They can't make it run their firmware. |
| CoAP API | None | Anyone on your LAN can read the sensors and run the pump (9 s at a time). Put IoT devices on a separate network or VLAN if that matters. |
| Physical access | None | Flash read-back protection is off: with a debugger on the SWD pads, someone can read the stored Thread network key. |

Keep `application/keys/` and `application/local.conf` out of git (`.gitignore` already does), and back up the signing key.

Older versions of this repository had a Thread network key and network name in `prj.conf`, and they're still in the git history. If your Thread network uses one of them (network names `Yann-OpenThread` or `ha-coap-ot`), create a new network in Home Assistant and commission your devices again.

## 🧑‍💻 Development

### Repository layout
| Path | Contents |
|---|---|
| `application/` | The Zephyr application, and the west manifest (`west.yml`) |
| `application/boards/arm/hacoap/` | The `hacoap` board definition (devicetree, pin control, defconfig) |
| `application/boards/*.overlay`, `application/overlay-*.conf` | Add-ons for the [variants](#variants) |
| `application/local.conf.example` | Template for `application/local.conf`, your private settings (not in git) |
| `application/keys/` | Your signing key, created by `scripts/keygen` (not in git) |
| `application/tests/unit/` | Unit tests of the firmware's logic, run on a PC |
| `scripts/` | Setup, key generation, build and firmware update scripts |
| `firmware-updater/` | Web interface for batch updates |
| `manager/` | The fleet manager app (inventory, updates, builds, network map, plants; see its README) |
| `docs/` | Schematic, code and power reviews (PDF), the fleet manager plan, and where things stand (`NEXT-STEPS.md`) |
| `external/` | The SDK, fetched by the setup script (not in git) |

### Source layout
| File | Purpose |
|---|---|
| `src/main.c` | Startup order, Thread state handling, and the glue between the CoAP API and the modules |
| `src/coap_resources.c` | The CoAP API: one table entry per resource, and a shared dispatcher that checks request types |
| `src/pump.c` | Timed pump runs, from CoAP or the S1 button |
| `src/joining.c` | Joining the Thread network again until it has one, and forgetting it (S1 at boot, or mcumgr) |
| `src/sensors.c` | Soil, battery and air readings, sampled periodically and cached |
| `src/buzzer.c` | Beep patterns |
| `src/status_led.c` | Network and error states on the module's RGB LED (as short flashes), and the user LED |
| `src/mcumgr_poll.c` | Faster Thread polling while mcumgr is in use, or the log is read |
| `src/device_settings.c` | The settings that change without a new firmware, in flash |
| `src/hacoap_mgmt.c` | The `hacoap` mcumgr group (64): reading and writing those settings, and a sensor sample on demand |
| `src/diag.c` | Restart and crash records, the boot count, the link to the parent: the `diag` resource |
| `src/log_buffer.c`, `src/remote_log.c` | The log over the air (`CONFIG_HACOAP_REMOTE_LOG` only): the latest log output in RAM, and the log backend that fills it |
| `src/srp.c` | SRP service registration |
| `src/watchdog.c` | Hardware watchdog |

CoAP handlers run in the OpenThread thread and must not block: anything slow (like sampling the sensors) runs elsewhere and the handler returns cached data.

To add a CoAP resource, add a row to the `resources` table in `coap_resources.c` with its URI, the requests it accepts and a handler, then a callback in `struct coap_resources_handlers` if it needs application data.

### Unit tests
The firmware's logic is tested on a PC, without a board: the CoAP API, the pump, the sensor conversions, the status LED patterns, the mcumgr polling, SRP names and the startup sequence. Each test compiles one real source file from `src/` against small fake versions of the Zephyr and OpenThread APIs (`application/tests/unit/fakes/`), with the same Kconfig values as the firmware build.

```
python application/tests/unit/run.py              # all tests
python application/tests/unit/run.py test_pump    # one test file
```

They need a C compiler: gcc or clang if you have one, otherwise Zig's, installed with `python -m pip install ziglang` (works on Windows, macOS and Linux). CI runs them on all three systems, with sanitizers on Linux and macOS.

To test a new module, add `application/tests/unit/test_<module>.c`: include the source file (`#include "../../src/<module>.c"`, which also gives access to its `static` functions), fake the other modules it calls, and add fakes to `fakes/fake.h` and `fakes/fakes.c` for any new Zephyr or OpenThread function.

### Logs
Build the `usb-logging` variant and open the second USB serial port, or `uart-console` and use the J4 UART (115200 baud). Log levels are set in `overlay-logging.conf` (`CONFIG_COAP_SERVER_LOG_LEVEL_*` for the application, `CONFIG_COAP_RESOURCES_LOG_LEVEL_*` for the CoAP layer).

**Over the air:** build any variant with `CONFIG_HACOAP_REMOTE_LOG=y` (in the fleet manager, a build profile with **Log over the air**), and open the board in the fleet manager's **Console**, **over the air**. The board keeps its latest log output in RAM (`CONFIG_HACOAP_REMOTE_LOG_BUFFER_SIZE`, 4 KB), and the `log` resource returns it from a byte offset: a reader asks from where its last answer ended, and gets each byte once. Each boot draws a new boot id, so a reader can tell the board restarted. Reading `log` switches the board to fast polling, like mcumgr does, until 30 s after the last read: a console costs battery only while it's open. It turns logging on, which costs about 27 KB of flash and 10 KB of RAM in the battery variant (87.6 % of the slot instead of 82.2 %; the `usb-logging` variant with it: 96.9 %). What happens before the board joins the network, or as it crashes, still needs USB. The code: `src/log_buffer.c` (the buffer), `src/remote_log.c` (the log backend that fills it), `handle_log()` in `src/coap_resources.c`.

### Restarts and crashes
At each boot, the firmware reads why the chip reset (`hwinfo`: power on or brownout, the reset pin, a software reset such as after an update, the watchdog, a CPU lockup), counts the boot (stored with the settings), and reports both in `diag`. A fatal error (a fault, an assert, a stack overflow) goes through the application's own handler (`src/diag.c`, with the SDK's `CONFIG_RESET_ON_FATAL_ERROR` off): it writes the error and the address where it happened into RAM that isn't cleared at boot (it lies above the RAM MCUboot uses), logs it, and resets. The next boot finds it, reports `reset=crash` and `fault=<reason>@<address>` (the reason is Zephyr's `K_ERR_*`; look the address up in `build/zephyr/zephyr.map`, or with `addr2line -e build/zephyr/zephyr.elf <address>`), and clears it. A power loss clears that RAM: the record is only for crashes. The fleet manager reads `diag` at every refresh, keeps each restart in the board's history, and raises an alert for a crash, a watchdog reset or a lockup.

### Updating the SDK
The SDK comes from forks of `sdk-nrf` and `sdk-zephyr`, pinned to exact commits in `application/west.yml`. To move to newer commits, update both `revision:` lines, run the setup script, build every variant, and push: CI checks the result on a clean machine. Every other PC picks up the change by running the setup script again.

### Board notes
- **DC/DC regulator**: the board enables the nRF52840's DC/DC regulator (`CONFIG_BOARD_ENABLE_DCDC`, default `y`), since the ACN52840 module includes the converter components. If a board doesn't boot with it, turn it off for both the app and MCUboot (`-DCONFIG_BOARD_ENABLE_DCDC=n -Dmcuboot_CONFIG_BOARD_ENABLE_DCDC=n`) and reflash over SWD.
- **Watchdog**: the application starts a 30 s hardware watchdog, fed every 10 s from the system work queue. A watchdog reset during an MCUboot test boot reverts to the previous image.
- **UART0** is disabled unless the `uart-console` variant enables it, since its receiver draws current in sleep.
- **User button**: S1 (P1.13) is listed in `sense-edge-mask` in the board DTS, so its interrupt uses the GPIO PORT event rather than a GPIOTE channel, which costs current in sleep.
- **RAM power-down**: RAM sections above the C library's heap are powered off, and powered back on as the heap grows (`CONFIG_RAM_POWER_ADJUST_ON_HEAP_RESIZE`). This needs the full newlib rather than newlib-nano, which adds about 13 KB of flash. The `debug` variant goes back to newlib-nano without it, to fit.
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
| `CONFIG_OPENTHREAD_JOINER_PSKD (...) must be 6 to 32 characters` | Fix the PSKd in `application/local.conf`: A–Z and 0–9 only, without I, O, Q and Z |
| Warning: `No private signing key` | This build is signed with the public development key. Create your key with `scripts/keygen`, or copy it into `application/keys/` from your backup. |
| `region 'FLASH' overflowed` | The image doesn't fit the 483 KB application slot. `-Og` (`overlay-debug.conf`) and logging don't fit together. |
| The device doesn't join (red + green flashes) | Start the commissioner on the border router with the PSKd the firmware was built with, for 300 s; the board tries again within 2 minutes. Still no join: the PSKd differs, or the board already has another network (make it forget it, see [Joining a Thread network](#-joining-a-thread-network)) |
| An update uploads fine, but the board keeps running the old firmware | The image is signed with a different key than the board's bootloader (for example, built on a PC without your key, or taken from CI). Rebuild with your key. |
| Blue flashes, and no three beeps | SRP registration isn't succeeding (the fleet manager shows `failed` under Health, **Its name**): check that the border router is running, and look for a duplicate host name. After a full chip erase, the board has a new SRP key and the border router keeps its name for the old one for up to 14 days (see [SRP registration](#srp-registration)) |
| A new board doesn't boot after the first flash | Try with DC/DC disabled (see [Board notes](#board-notes)) |
| mcumgr over UDP times out | Check the route to the Thread network from the PC (`ping -6 <device address>`), and that the device is attached |

## 📝 Roadmap

- [ ] Implement dynamic SRP client hostname reassignment when duplicates are detected
- [x] Refactor SRP functionality out of `coap_server.c` (now `src/srp.c`)
- [ ] Fleet manager: one app for Windows, macOS and Linux to find, commission, configure, build and update the whole fleet. Inventory, updates, firmware builds, backups, release downloads, a network map, plant tracking, alerts and flashing over SWD are done (`manager/`, see [its README](manager/README.md)), not yet tried on boards; runtime settings and commissioning are next, after the board tests. Plan: `docs/FLEET-MANAGER-PLAN.md`

## 📚 References

- [OpenThread Documentation](https://openthread.io/guides)
- [nRF Connect SDK v2.4.3 Documentation](https://developer.nordicsemi.com/nRF_Connect_SDK/doc/2.4.3/nrf/index.html)
- [CoAP Protocol RFC 7252](https://tools.ietf.org/html/rfc7252)
- [mcumgr CLI](https://github.com/apache/mynewt-mcumgr-cli)

## ⚖️ License

This project is licensed under the [MIT License](LICENSE). Files that come from Nordic Semiconductor or Zephyr (marked with their own `SPDX-License-Identifier` headers) keep their original licenses.
