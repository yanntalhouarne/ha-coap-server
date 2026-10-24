# 📡 OpenThread CoAP Server

![Version](https://img.shields.io/badge/nRF%20SDK-v2.4-blue)
![License](https://img.shields.io/badge/license-MIT-green)

*An implementation of CoAP server functionality using OpenThread on nRF hardware*

## 📋 Overview

This project implements a CoAP server using OpenThread on Nordic Semiconductor's nRF hardware. It enables IoT devices to communicate using the CoAP protocol over Thread network.
This project is meant to be run on the [ha-coap-pcb](https://github.com/yanntalhouarne/ha-coap-pcb) custom board, along with the [ha-coap](https://github.com/yanntalhouarne/ha-coap-integration) Home Assistant custom integration .

## 🛠️ Build Configuration

### Prerequisites
- **SDK**: `nRF Connect SDK v2.4.3`
- **Toolchain**: `nRF Connect SDK Toolchain v2.4.3`
- **Board target**: `hacoap`

### Project Configuration
- **Main config**: `prj.conf`
- **Kconfig fragments**: `overlay-mtd.conf`
- **Devicetree overlays**: `boards/usb.overlay`
- **CMake arguments**:
  ```
  -DBOARD_ROOT="<path to this repo>/application"
  ```

Optional fragments and overlays:

| File | Purpose |
|---|---|
| `overlay-mtd.conf` | Thread sleepy end device (battery builds) |
| `overlay-usb.conf` + `overlay-logging.conf` + `boards/usb-console.overlay` | Console and logs on a second USB CDC ACM port (the first one stays for mcumgr) |
| `overlay-debug.conf` | Asserts, `-Og` and thread info for debugging |
| `overlay-udp.conf` | mcumgr over Thread (UDP port 1337) for over-the-air updates |
| `boards/usb.overlay` | mcumgr over USB CDC ACM (always used) |
| `boards/uart.overlay` + `overlay-uart.conf` | Console on the J4 UART. UART0 is disabled otherwise, since its receiver draws current in sleep |

### Board notes
- **DC/DC regulator**: the board enables the nRF52840's DC/DC regulator (`CONFIG_BOARD_ENABLE_DCDC`, default `y`), since the ACN52840 module includes the converter components. If a board doesn't boot with it, turn it off for both the app and MCUboot (`-DCONFIG_BOARD_ENABLE_DCDC=n -Dmcuboot_CONFIG_BOARD_ENABLE_DCDC=n`) and reflash over SWD.
- **Watchdog**: the application starts a 30 s hardware watchdog, fed every 10 s from the system work queue. A watchdog reset during an MCUboot test boot reverts to the previous image.
- **Startup**: a missing sensor no longer stops the boot. It's logged, shown on the red LED (2 blinks: HDC1080, 3 blinks: fuel gauge) and reported as 0 in `data`, and the device still joins the network so it can be updated.
- **Time-of-flight sensor**: the VL53L0X node is disabled in the board DTS while it's unused. To use it, set its `status` to `"okay"` and add `CONFIG_VL53L0X=y`.

## 🔄 SRP Client Service Registration

> **Important**: Each device requires a unique hostname to function properly.

- Configure a unique hostname and service instance in `ot_srp_config.h` for each flashed device
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
   > Image must be in a `build_*` folder (e.g., `ha-coap-server\application\build_mtd_lp`)

5. **mcumgr script**:
   Alternatively, the mcumgr interactive script can be used.
   ```bash
   cd scripts
   ./mcumgr-dfu.sh
   ```
   
## 📝 Roadmap

- [ ] Implement dynamic SRP client hostname reassignment when duplicates are detected
- [ ] Refactor SRP functionality out of `coap_server.c`

## 📚 References

- [OpenThread Documentation](https://openthread.io/guides)
- [nRF Connect SDK Documentation](https://developer.nordicsemi.com/nRF_Connect_SDK/doc/latest/nrf/index.html)
- [CoAP Protocol RFC 7252](https://tools.ietf.org/html/rfc7252)