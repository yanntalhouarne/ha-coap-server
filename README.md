# OpenThread CoAP Server

*Using nRF SDK Connect v2.4*

## 1. nRF Connect Build Configuration
- **SDK**
  * `nRF Connect SDK v2.4.3`
- **Toolchain**
  * `nRF Connect SDK Toolchain v2.4.3`
- **Board target**
  * `hacoap`
- **Configuration:**
  * `prj.conf`
- **Kconfig fragments:**
  * `overlay-mtd.conf`
- **Base Devicetree overlays:**
  * `boards/usb.overlay`
- **Extra CMake arguments:**
  * `-DBOARD_ROOT="c:\Users\talho\Documents\Smargit\repos\ha-coap-server\application\"`

## 2. SRP Client Service Registering

- For each new device flashed, a unique hostname and service instance must be set in `ot_srp_config.h`
- If hostname is not unique, the SRP server (on the border router dongle) will reject the registering of the service
- OpenThread saves the SRP key to non-volatile memory. If the device is erased (e.g., `ot factoryreset`), the key will be erased and the SRP client on the device will have issues updating its service with the SRP server

## 3. Ping the Device

- Browse ha-coap nodes IPv6 addresses
  * `avahi-browse -r _ot._udp`
- Ping device
  * `ping -6 fd49:969:3c3c:1:88a2:4c28:69ec:34f7`
- CoAP communication
  * Example: get `pumpdc` resource   
    * `coap-client -m get coap://[fd49:969:3c3c:1:88a2:4c28:69ec:34f7]/pumpdc -v 6`

## 4. Flash nRF52840 Dongle

- Generate DFU package from .hex file:
  ```
  nrfutil pkg generate --hw-version 52 --sd-req 0x00 --application-version 1 --application /PATH_TO_THIS_REPO/build_1/zephyr/zephyr.hex nrfDongle_dfu_package.zip
  ```
- Flash Dongle (make sure it is set in bootloader mode by holding the side switch while connecting it to the USB port):
  ```
  nrfutil dfu usb-serial -pkg nrfDongle_dfu_package.zip -p /dev/ttyACM0
  ```

## 5. Flashing Firmware with USB

- Create connection to MCUGMR target:
  ```
  mcumgr conn add testDK type="serial" connstring="COM7,baud=115200,mtu=512"
  ```
  (where COM7 is the COM port shown in Device Manager (Windows) or /dev/tty* (Linux))
- List slots and images:
  ```
  mcumgr -c testDK image list
  ```
- `test` new image:
  ```
  mcumgr -c testDK image upload zephyr/app_update.bin
  ```
- `confirm` new image:
  - Confirm new image:
    ```
    mcumgr -c testDK image confirm <NEW_HASH>
    ```
  - Flash new image (must be in `build_*` folder (e.g., `ha-coap-server\application\build_mtd_lp`)):
    ```
    mcumgr -c testDK image upload build/zephyr/app_update.bin
    ```

## 6. Remaining Work

- Set a different SRP client hostname if it is already taken (the SRP Client callback in coap_server.c will be called with aError = DUPLICATE)
- Move the SRP stuff out of coap_server.c
- FOTA over OpenThread (see https://devzone.nordicsemi.com/f/nordic-q-a/96148/mcumgr-over-openthread-udp-error-8)