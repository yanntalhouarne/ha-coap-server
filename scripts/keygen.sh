#!/usr/bin/env bash
# Creates your private MCUboot signing key (ECDSA P-256) for this firmware.
#
# Writes application/keys/mcuboot-signing-key.pem (ignored by git), which every build then
# uses: MCUboot embeds its public half, and update images are signed with it. Boards only
# accept updates signed with the key their bootloader was built with.
#
# Back the key up somewhere safe (password manager, encrypted drive). Without it you can't
# update your boards over USB or the air anymore, only reflash them over SWD.
#
# Refuses to overwrite an existing key. Run scripts/setup.sh first.

set -euo pipefail

NCS_VERSION="${NCS_VERSION:-v2.4.3}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEY="$REPO/application/keys/mcuboot-signing-key.pem"

if [ -e "$KEY" ]; then
    echo "$KEY already exists. Replacing it would lock out boards that use it; delete it yourself if you really mean to." >&2
    exit 1
fi

if command -v nrfutil > /dev/null; then
    NRFUTIL="$(command -v nrfutil)"
elif [ -x "$HOME/.local/bin/nrfutil" ]; then
    NRFUTIL="$HOME/.local/bin/nrfutil"
else
    echo "nrfutil not found. Run scripts/setup.sh first." >&2
    exit 1
fi

mkdir -p "$(dirname "$KEY")"
"$NRFUTIL" toolchain-manager launch --ncs-version "$NCS_VERSION" --chdir "$REPO" -- \
    python external/bootloader/mcuboot/scripts/imgtool.py keygen -k "$KEY" -t ecdsa-p256
chmod 600 "$KEY"

echo
echo "Created $KEY"
echo "Back it up now: you need this exact file to update boards flashed with it."
echo "Next builds are signed with it. Flash each board once over SWD so its bootloader trusts it."
