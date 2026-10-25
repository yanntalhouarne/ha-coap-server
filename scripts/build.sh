#!/usr/bin/env bash
# Builds the firmware with the nRF Connect SDK toolchain (run scripts/setup.sh once first).
#
# Usage: scripts/build.sh [variant] [extra CMake arguments...]
#
# Variants:
#   battery       Production firmware: sleepy end device, updates over USB and over Thread.
#                 Output in application/build (where the update scripts look). Default.
#   usb-logging   Adds the console and logs on a second USB serial port.
#   uart-console  Adds the console and logs on the J4 UART.
#   debug         Adds asserts, -Og and thread info, for a debugger.
# Other variants are built in application/build_<variant>. Every build starts from a clean
# build directory, so stale settings never carry over.
#
# Example: scripts/build.sh battery -DCONFIG_HACOAP_SENSOR_SAMPLE_PERIOD_S=900

set -euo pipefail

NCS_VERSION="${NCS_VERSION:-v2.4.3}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VARIANT="${1:-battery}"
shift || true

case "$VARIANT" in
    battery)
        VARIANT_ARGS=()
        ;;
    usb-logging)
        VARIANT_ARGS=("-DEXTRA_CONF_FILE=overlay-logging.conf;overlay-usb.conf" "-DEXTRA_DTC_OVERLAY_FILE=boards/usb-console.overlay")
        ;;
    uart-console)
        VARIANT_ARGS=("-DEXTRA_CONF_FILE=overlay-uart.conf;overlay-logging.conf" "-DEXTRA_DTC_OVERLAY_FILE=boards/uart.overlay")
        ;;
    debug)
        VARIANT_ARGS=("-DEXTRA_CONF_FILE=overlay-debug.conf")
        ;;
    *)
        echo "Unknown variant '$VARIANT' (battery, usb-logging, uart-console or debug)" >&2
        exit 1
        ;;
esac

if [ "$VARIANT" = "battery" ]; then
    BUILD_DIR="application/build"
else
    BUILD_DIR="application/build_${VARIANT//-/_}"
fi

if command -v nrfutil > /dev/null; then
    NRFUTIL="$(command -v nrfutil)"
elif [ -x "$HOME/.local/bin/nrfutil" ]; then
    NRFUTIL="$HOME/.local/bin/nrfutil"
else
    echo "nrfutil not found. Run scripts/setup.sh first." >&2
    exit 1
fi

"$NRFUTIL" toolchain-manager launch --ncs-version "$NCS_VERSION" --chdir "$REPO" -- \
    west build -p always -d "$BUILD_DIR" application -- ${VARIANT_ARGS[@]+"${VARIANT_ARGS[@]}"} "$@"

echo
echo "Firmware update image: $BUILD_DIR/zephyr/app_update.bin"
echo "Full image for SWD:    $BUILD_DIR/zephyr/merged.hex"
