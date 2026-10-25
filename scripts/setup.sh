#!/usr/bin/env bash
# Prepares this repository for building on Linux (also used by CI).
#
#   1. Finds nrfutil, or downloads it to ~/.local/bin (Linux x86_64 only).
#   2. Installs the nrfutil toolchain-manager command and the nRF Connect SDK toolchain.
#   3. Fetches the pinned SDK (application/west.yml) into external/ with 'west update'.
#
# Safe to run again, for example after the SDK pin in application/west.yml changes.
# Usage: scripts/setup.sh            (NCS_VERSION=v2.4.3 by default)

set -euo pipefail

NCS_VERSION="${NCS_VERSION:-v2.4.3}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NRFUTIL_URL="https://files.nordicsemi.com/ui/api/v1/download?repoKey=swtools&path=external/nrfutil/executables/x86_64-unknown-linux-gnu/nrfutil&isNativeBrowsing=false"
NRFUTIL_LOCAL="$HOME/.local/bin/nrfutil"

# 1. nrfutil
if command -v nrfutil > /dev/null; then
    NRFUTIL="$(command -v nrfutil)"
elif [ -x "$NRFUTIL_LOCAL" ]; then
    NRFUTIL="$NRFUTIL_LOCAL"
elif [ "$(uname -s)-$(uname -m)" = "Linux-x86_64" ]; then
    echo "==> Downloading nrfutil to $NRFUTIL_LOCAL"
    mkdir -p "$(dirname "$NRFUTIL_LOCAL")"
    curl -fsSL -o "$NRFUTIL_LOCAL" "$NRFUTIL_URL"
    chmod +x "$NRFUTIL_LOCAL"
    NRFUTIL="$NRFUTIL_LOCAL"
else
    echo "nrfutil not found. Install it from https://www.nordicsemi.com/Products/Development-tools/nRF-Util and run this again." >&2
    exit 1
fi
echo "Using nrfutil: $NRFUTIL"

# 2. Toolchain
if ! "$NRFUTIL" list | grep -q toolchain-manager; then
    echo "==> Installing the nrfutil toolchain-manager command"
    "$NRFUTIL" install toolchain-manager
fi
if "$NRFUTIL" toolchain-manager list | grep -qF "$NCS_VERSION"; then
    echo "==> Toolchain $NCS_VERSION already installed"
else
    echo "==> Installing the nRF Connect SDK $NCS_VERSION toolchain (large download)"
    "$NRFUTIL" toolchain-manager install --ncs-version "$NCS_VERSION"
fi

# 3. SDK
echo "==> Fetching the SDK into external/ (west update)"
"$NRFUTIL" toolchain-manager launch --ncs-version "$NCS_VERSION" --chdir "$REPO" -- west update --narrow -o=--depth=1

echo
echo "Setup done. Build the firmware with: scripts/build.sh"
