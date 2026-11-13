#!/usr/bin/env bash
# Prepares this macOS or Linux machine to open the HA-CoAP server (its VM) in VS Code over SSH.
#
#   1. Makes this machine's SSH key for it (~/.ssh/hacoap-server), unless it has one.
#   2. Adds "hacoap" (over ZeroTier: from anywhere) and "hacoap-lan" (the home network) to ~/.ssh/config.
#   3. Prints the one command to run on a machine that can already connect, which lets this one in
#      (the server only takes keys it knows, no passwords).
#
# Then: VS Code, Remote-SSH: Connect to Host > hacoap, and open ~/ha-coap-server.
# Over ZeroTier, this machine must have joined your ZeroTier network. Safe to run again.
#
# Usage: scripts/connect-to-server.sh [zerotier address] [lan address] [user]

set -euo pipefail

ZEROTIER="${1:-10.243.120.130}"
LAN="${2:-192.168.50.178}"
SERVER_USER="${3:-hacoap}"
# The server's own key, to check on the first connection (ssh asks to trust it)
FINGERPRINT="SHA256:QrVf83X9noTSwHB7HFWQsz/DJrmV4RTVVRxQGoPpzc8"

KEY="$HOME/.ssh/hacoap-server"
CONFIG="$HOME/.ssh/config"
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"

# 1. The key
if [ -f "$KEY" ]; then
    echo "This machine's key: $KEY (already there)"
else
    ssh-keygen -q -t ed25519 -N "" -C "$(id -un)@$(hostname) for hacoap" -f "$KEY"
    echo "Made this machine's key: $KEY"
fi

# 2. The hosts
if [ -f "$CONFIG" ] && grep -qE '^Host hacoap[[:space:]]*$' "$CONFIG"; then
    echo "~/.ssh/config already has hacoap"
else
    cat >> "$CONFIG" << EOF

# The HA-CoAP server (its VM, user $SERVER_USER). VS Code: Remote-SSH: Connect to Host > hacoap.
# Over ZeroTier, so from anywhere; hacoap-lan is the same server on the home network.
Host hacoap
  HostName $ZEROTIER
  User $SERVER_USER
  IdentityFile ~/.ssh/hacoap-server
  IdentitiesOnly yes

Host hacoap-lan
  HostName $LAN
  User $SERVER_USER
  IdentityFile ~/.ssh/hacoap-server
  IdentitiesOnly yes
EOF
    chmod 600 "$CONFIG"
    echo "Added hacoap and hacoap-lan to $CONFIG"
fi

# 3. Letting it in
PUBLIC="$(cat "$KEY.pub")"
echo
echo "Now, on a machine that can already connect (or in the VM's console in Proxmox), run:"
echo
echo "  ssh hacoap \"grep -qxF '$PUBLIC' ~/.ssh/authorized_keys || echo '$PUBLIC' >> ~/.ssh/authorized_keys\""
echo
echo "Then test it here: ssh hacoap hostname"
echo "The first time, ssh shows the server's key: it must be $FINGERPRINT"
