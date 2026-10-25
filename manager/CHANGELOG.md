# Fleet manager changes

## 0.1.0

First version: the plan's phases 0, 1, 2, 5 and 6. Tested against a simulated device; not yet used with real boards.

- **Devices:** finds devices on the network (mDNS) or by address, and shows their firmware, battery, readings and when they were last seen. Rename, notes, update history, firmware slots, beep.
- **Updates** over the air or USB: upload (resumes after lost packets), trial boot, check that the device came back running the new image, confirm. One device at a time, stopping at the first failure. History of every result.
- **Images:** a library of firmware images, from files or from the builds on this computer.
- **Builds:** build profiles (variant and settings, from the firmware's Kconfig), checks for the toolchain and signing key, builds with a live log.
- **Data:** backups (one file; daily automatic ones, and one before every restore), restore, and the device list as CSV.
- Answers only on this computer (127.0.0.1).
