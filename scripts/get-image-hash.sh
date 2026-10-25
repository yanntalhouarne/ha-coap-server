#!/bin/bash
# Prints the SHA-256 hash that MCUboot (and 'mcumgr image list') reports for a build's
# update image, zephyr/app_update.bin.
#
# Usage: get-image-hash.sh [build_dir]   (default: application/build in this repository)
# Needs Python 3.7+ (see hacoap_tools.py). Works on Linux, macOS and Windows (Git Bash).

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/hacoap-common.sh"

BUILD_DIR="${1:-$HACOAP_DEFAULT_BUILD_DIR}"

if ! find_python; then
    echo "Error: Python 3.7+ not found. $(install_hint python)" >&2
    exit 1
fi

hacoap_tools image-hash "$BUILD_DIR/zephyr/app_update.bin"
