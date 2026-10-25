# 📡 OpenThread CoAP Server

![Version](https://img.shields.io/badge/nRF%20SDK-v2.4-blue)
![License](https://img.shields.io/badge/license-MIT-green)

*An implementation of CoAP server functionality using OpenThread on nRF hardware*

## 📋 Overview

This project implements a CoAP server using OpenThread on Nordic Semiconductor's nRF hardware. It enables IoT devices to communicate using the CoAP protocol over Thread network.
This project is meant to be run on the [ha-coap-pcb](https://github.com/yanntalhouarne/ha-coap-pcb) custom board, along with the [ha-coap](https://github.com/yanntalhouarne/ha-coap-integration) Home Assistant custom integration .

## 🛠️ Building

Everything the build needs is pinned in this repository: the board definition, the SDK revisions (`application/west.yml`) and the toolchain version (nRF Connect SDK v2.4.3).

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

For example `scripts\build.ps1 usb-logging` or `scripts/build.sh usb-logging`. Extra arguments go to CMake, for example `scripts/build.sh battery -DCONFIG_HACOAP_SENSOR_SAMPLE_PERIOD_S=900`. The scripts always build from a clean build directory.

### In VS Code
1. Open the repository folder and install the recommended **nRF Connect for VS Code Extension Pack** when prompted.
2. In the nRF Connect panel, check that the toolchain is v2.4.3 and the SDK is the one in `external/`.
3. Add a build configuration for `application`: board `hacoap`, build directory `build`, nothing else. For a variant, add its `.conf` files under Kconfig fragments and its overlay under **extra** devicetree overlays.

If a build configuration was created before these files changed, delete it (and its build directory) and add it again: CMake caches the old file list.

### From a terminal
In a toolchain shell (`nrfutil toolchain-manager launch --ncs-version v2.4.3 --shell`, or the nRF Connect terminal in VS Code), from the repository root:
```
west build -d application/build application
```
The board defaults to `hacoap`, and `CMakeLists.txt` adds `application/` to the board roots, so no other arguments are needed.

### Continuous integration
`.github/workflows/build.yml` runs `scripts/setup.sh` and builds every variant on each push and pull request, so a change that breaks a clean build is caught right away. The battery build's `app_update.bin` and `merged.hex` are attached to each run as artifacts.

### Board notes
- **DC/DC regulator**: the board enables the nRF52840's DC/DC regulator (`CONFIG_BOARD_ENABLE_DCDC`, default `y`), since the ACN52840 module includes the converter components. If a board doesn't boot with it, turn it off for both the app and MCUboot (`-DCONFIG_BOARD_ENABLE_DCDC=n -Dmcuboot_CONFIG_BOARD_ENABLE_DCDC=n`) and reflash over SWD.
- **Watchdog**: the application starts a 30 s hardware watchdog, fed every 10 s from the system work queue. A watchdog reset during an MCUboot test boot reverts to the previous image.
- **Startup**: a missing sensor no longer stops the boot. It's logged, shown on the red LED (2 blinks: HDC1080, 3 blinks: fuel gauge) and reported as 0 in `data`, and the device still joins the network so it can be updated.
- **Sensor sampling**: the sensors are sampled at boot and then every `CONFIG_HACOAP_SENSOR_SAMPLE_PERIOD_S` (default 300 s). A `data` request returns the latest samples immediately instead of reading the sensors in the OpenThread thread.
- **Time-of-flight sensor**: the VL53L0X node is disabled in the board DTS while it's unused. To use it, set its `status` to `"okay"` and add `CONFIG_VL53L0X=y`.

### Source layout

| File | Purpose |
|---|---|
| `src/main.c` | Startup order, Thread state handling, and the glue between the CoAP API and the modules |
| `src/coap_resources.c` | The CoAP API: one table entry per resource (`pumpdc`, `pump`, `data`, `info`, `ping`) |
| `src/pump.c` | Timed pump runs, from CoAP or the S1 button |
| `src/sensors.c` | Soil, battery and air readings, sampled periodically and cached |
| `src/buzzer.c` | Beep patterns |
| `src/status_led.c` | Network and error states on the module's RGB LED, and the user LED |
| `src/srp.c` | SRP service registration |
| `src/watchdog.c` | Hardware watchdog |

### Application settings

Tunables are Kconfig options (`application/Kconfig`, menu "ha-coap application"). Set them in a `.conf` fragment or on the command line, for example `-DCONFIG_HACOAP_SENSOR_SAMPLE_PERIOD_S=600`.

| Option | Default | |
|---|---|---|
| `CONFIG_HACOAP_HW_VERSION` | `"v2.0"` | Reported in `info` |
| `CONFIG_HACOAP_PUMP_DEFAULT_DURATION` / `_MAX_DURATION` | 1 s / 9 s | Pump run time |
| `CONFIG_HACOAP_SENSOR_SAMPLE_PERIOD_S` | 300 | Sensor sampling period |
| `CONFIG_HACOAP_SOIL_POWER_UP_MS` | 200 | Soil sensor settling time |
| `CONFIG_HACOAP_SOIL_DRY_MV` / `_WET_MV` | 2200 / 980 | Soil sensor calibration |
| `CONFIG_HACOAP_WDT_TIMEOUT_MS` / `_FEED_PERIOD_MS` | 30000 / 10000 | Watchdog |
| `CONFIG_HACOAP_SRP_*` | see below | SRP names |

## 🔄 SRP Client Service Registration

> **Important**: Each device requires a unique hostname to function properly.

- The hostname and service instance are `ha-coap-<suffix>`. The suffix is the factory device ID by default (`CONFIG_HACOAP_SRP_SUFFIX_DEVICE_ID`). It can be a random number (`_SUFFIX_RANDOM`), a fixed ID (`_SUFFIX_MANUAL` with `CONFIG_HACOAP_SRP_MANUAL_ID`) or nothing (`_SUFFIX_NONE`), and the prefixes are set by `CONFIG_HACOAP_SRP_HOSTNAME` and `CONFIG_HACOAP_SRP_SERVICE_INSTANCE`
- The SRP server will reject duplicate hostnames during registration
- Note that OpenThread stores the SRP key in non-volatile memory
  - If the device is factory reset (`ot factoryreset`), the key will be erased
  - This can cause issues when the SRP client attempts to update its service with the SRP server

## 🌐 Network Communication

### Discover Thread Devices
```bash
avahi-browse -r _ot._udp
```

### Test Connectivity
```bash
ping -6 fd49:969:3c3c:1:88a2:4c28:69ec:34f7
```

### CoAP Communication Examples
```bash
# Get the 'pumpdc' resource
coap-client -m get coap://[fd49:969:3c3c:1:88a2:4c28:69ec:34f7]/pumpdc -v 6

# Other examples could be added here...
```

## 📲 Flashing Instructions

### nRF52840 Dongle

1. **Generate DFU package**:
   ```bash
   nrfutil pkg generate --hw-version 52 --sd-req 0x00 --application-version 1 \
     --application /PATH_TO_REPO/build_1/zephyr/zephyr.hex nrfDongle_dfu_package.zip
   ```

2. **Flash the Dongle**:
   > Put the device in bootloader mode by holding the side switch while connecting to USB
   ```bash
   nrfutil dfu usb-serial -pkg nrfDongle_dfu_package.zip -p /dev/ttyACM0
   ```

### Firmware Updates via USB

1. **Create MCUMGR connection**:
   - USB-CDC: 
     ```bash
     mcumgr conn add serial type="serial" connstring="COM7,baud=115200,mtu=512"
     ```
     > Replace COM7 with the appropriate port on your system
   
   - UDP: 
     ```bash
     mcumgr conn add udp type="udp" connstring="[fd49:969:3c3c:1:8c6a:5db:a6ef:178f]:1337"
     ```
     > Replace IPV6 IP address with the address of the device


*Note: if using UDP, replace "serial" with "udp" in the following commands.*

2. **View current firmware**:
   ```bash
   mcumgr -c serial image list
   ```

3. **Upload new image**:
   ```bash
   mcumgr -c serial image upload zephyr/app_update.bin
   ```

4. **Confirm new image**:
   ```bash
   mcumgr -c serial image confirm <NEW_HASH>
   ```
   > The image is built in `application/build` (see Building)

5. **mcumgr script**:
   Alternatively, the mcumgr interactive script can be used.
   ```bash
   cd scripts
   ./mcumgr-dfu.sh
   ```
   
## 📝 Roadmap

- [ ] Implement dynamic SRP client hostname reassignment when duplicates are detected
- [x] Refactor SRP functionality out of `coap_server.c` (now `src/srp.c`)

## 📚 References

- [OpenThread Documentation](https://openthread.io/guides)
- [nRF Connect SDK Documentation](https://developer.nordicsemi.com/nRF_Connect_SDK/doc/latest/nrf/index.html)
- [CoAP Protocol RFC 7252](https://tools.ietf.org/html/rfc7252)