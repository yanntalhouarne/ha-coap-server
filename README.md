# 📡 OpenThread CoAP Server

![Version](https://img.shields.io/badge/nRF%20SDK-v2.4-blue)
![License](https://img.shields.io/badge/license-MIT-green)

*An implementation of CoAP server functionality using OpenThread on nRF hardware*

## 📋 Overview

This project implements a CoAP server using OpenThread on Nordic Semiconductor's nRF hardware. It enables IoT devices to communicate using the CoAP protocol over Thread network.
This project is meant to be run on the [ha-coap-pcb](https://github.com/yanntalhouarne/ha-coap-pcb_) custom board, along with the [ha-coap](https://github.com/yanntalhouarne/ha-coap-integration) Home Assistant custom integration .

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
  -DBOARD_ROOT="c:\Users\talho\Documents\Smargit\repos\ha-coap-server\application\"
  ```

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
   ```bash
   mcumgr conn add testDK type="serial" connstring="COM7,baud=115200,mtu=512"
   ```
   > Replace COM7 with the appropriate port on your system

2. **View current firmware**:
   ```bash
   mcumgr -c testDK image list
   ```

3. **Upload new image**:
   ```bash
   mcumgr -c testDK image upload zephyr/app_update.bin
   ```

4. **Confirm new image**:
   ```bash
   mcumgr -c testDK image confirm <NEW_HASH>
   ```

5. **Alternative flash method**:
   ```bash
   mcumgr -c testDK image upload build/zephyr/app_update.bin
   ```
   > Image must be in a `build_*` folder (e.g., `ha-coap-server\application\build_mtd_lp`)

## 📝 Roadmap

- [ ] Implement dynamic SRP client hostname reassignment when duplicates are detected
- [ ] Refactor SRP functionality out of `coap_server.c`
- [ ] Add FOTA support over OpenThread
  - See [mcumgr over OpenThread UDP discussion](https://devzone.nordicsemi.com/f/nordic-q-a/96148/mcumgr-over-openthread-udp-error-8)

## 📚 References

- [OpenThread Documentation](https://openthread.io/guides)
- [nRF Connect SDK Documentation](https://developer.nordicsemi.com/nRF_Connect_SDK/doc/latest/nrf/index.html)
- [CoAP Protocol RFC 7252](https://tools.ietf.org/html/rfc7252)