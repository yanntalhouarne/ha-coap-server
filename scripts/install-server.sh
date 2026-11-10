#!/usr/bin/env bash
# Sets up this Linux machine (Debian 12+, Ubuntu 22.04+, Raspberry Pi OS) to run the fleet manager
# and the Thread border router, so both can move to a new VM or PC:
#
#   1. Packages: Python, git, curl and Docker. A kernel with USB serial (cdc_acm) for the radio
#      dongle: Debian's "cloud" kernel has none, so Debian's standard kernel is installed (a
#      restart is then needed, and running this again afterwards removes the cloud kernel).
#   2. This user in the docker and dialout groups (the app runs the border router with docker).
#   3. The network, for a border router: IPv6 forwarding, and router advertisements still
#      accepted on the home network's interface (forwarding turns them off otherwise).
#   4. The app: its Python environment, and a systemd service that starts it with the machine.
#
# Then, in the page: restore a backup (Settings), and start the border router (Border router tab).
# The backup brings the devices, the history and the Thread network's settings: the border router
# joins the same network, and the boards follow by themselves.
#
# Run it from the checkout, as the user the app runs as (not root: it uses sudo). Safe to run again.
# Usage: scripts/install-server.sh [--no-service]

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_USER="$(id -un)"
SERVICE=hacoap-manager
SERVICE_FILE="/etc/systemd/system/$SERVICE.service"
WITH_SERVICE=1
[ "${1:-}" = "--no-service" ] && WITH_SERVICE=0

step() { echo; echo "==> $*"; }
note() { echo "    $*"; }

if [ "$(id -u)" -eq 0 ]; then
    echo "Run this as the user the app should run as, not as root (it uses sudo where needed)." >&2
    exit 1
fi
if ! command -v apt-get > /dev/null; then
    echo "This needs a Debian-based Linux (Debian, Ubuntu, Raspberry Pi OS)." >&2
    exit 1
fi
. /etc/os-release
NEED_RESTART=0

# 1. Packages ---------------------------------------------------------------------------------
step "Packages: Python, git, curl, Docker"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git curl python3 python3-venv python3-pip docker.io > /dev/null
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' || {
    echo "The app needs Python 3.10 or newer ($(python3 --version) here)." >&2; exit 1; }
note "$(python3 --version), $(sudo docker --version)"

step "USB serial for the radio dongle"
has_acm() { /usr/sbin/modinfo cdc_acm > /dev/null 2>&1 || grep -q '/cdc-acm.ko' "/lib/modules/$(uname -r)/modules.builtin" 2> /dev/null; }
if has_acm; then
    note "This kernel ($(uname -r)) has it."
    # Back on the standard kernel after the restart: the cloud one goes, so updates boot normally
    if [ "${ID:-}" = "debian" ] && dpkg -l 'linux-image-*cloud*' 2> /dev/null | grep -q '^ii'; then
        note "Removing Debian's cloud kernel (no USB), now that the standard one runs."
        sudo DEBIAN_FRONTEND=noninteractive apt-get purge -y -qq 'linux-image-*cloud*' > /dev/null
        sudo sed -i 's/^GRUB_DEFAULT=.*/GRUB_DEFAULT=0/' /etc/default/grub
        sudo update-grub 2> /dev/null
    fi
elif [ "${ID:-}" = "debian" ] && [ "$(dpkg --print-architecture)" = "amd64" ]; then
    note "This kernel ($(uname -r)) has no USB serial: installing Debian's standard kernel."
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq linux-image-amd64 > /dev/null
    STANDARD=$(ls /boot/vmlinuz-*-amd64 | grep -v cloud | sed 's|/boot/vmlinuz-||' | sort -V | tail -1)
    SUBMENU=$(sudo grep -oE "submenu '[^']+'" /boot/grub/grub.cfg | head -1 | sed "s/submenu '//; s/'$//")
    sudo sed -i "s|^GRUB_DEFAULT=.*|GRUB_DEFAULT=\"$SUBMENU>Debian GNU/Linux, with Linux $STANDARD\"|" /etc/default/grub
    sudo update-grub 2> /dev/null
    NEED_RESTART=1
    note "It starts on $STANDARD after a restart."
else
    note "This kernel ($(uname -r)) has no USB serial (cdc_acm): install your distribution's standard kernel"
    note "(on Ubuntu: linux-image-generic), restart, and run this again."
fi

# 2. Groups -----------------------------------------------------------------------------------
step "Groups: $APP_USER in docker (the border router) and dialout (boards on USB)"
sudo usermod -aG docker,dialout "$APP_USER"

# 3. The network ------------------------------------------------------------------------------
INFRA_IF=$(awk '$2 == "00000000" { print $1; exit }' /proc/net/route)
step "Network: IPv6 forwarding, router advertisements on ${INFRA_IF:-?}"
if [ -z "$INFRA_IF" ]; then
    echo "No default route: connect this machine to your home network first." >&2
    exit 1
fi
NETPLAN=0
[ -d /etc/netplan ] && command -v netplan > /dev/null && NETPLAN=1
{
    echo "# The Thread border router (Docker, see the app's Border router tab) routes between the"
    echo "# Thread network and $INFRA_IF. Written by scripts/install-server.sh."
    echo "net.ipv6.conf.all.forwarding = 1"
    echo "net.ipv4.ip_forward = 1"
    # Where the kernel itself handles router advertisements (not systemd-networkd or NetworkManager,
    # which do it on their own): keep accepting them with forwarding on, with their routes
    if [ "$NETPLAN" = 0 ] && ! systemctl is-active -q NetworkManager 2> /dev/null; then
        echo "net.ipv6.conf.$INFRA_IF.accept_ra = 2"
        echo "net.ipv6.conf.$INFRA_IF.accept_ra_rt_info_max_plen = 64"
    fi
} | sudo tee /etc/sysctl.d/60-otbr.conf > /dev/null
sudo /usr/sbin/sysctl -q --system
if [ "$NETPLAN" = 1 ]; then
    # systemd-networkd stops accepting router advertisements once forwarding is on, unless told to
    case "$INFRA_IF" in wl*) SECTION=wifis ;; *) SECTION=ethernets ;; esac
    sudo tee /etc/netplan/60-thread-border-router.yaml > /dev/null << EOF
# This machine is the Thread border router (OTBR in Docker). It forwards IPv6, so accept
# router advertisements explicitly: forwarding would otherwise turn them off.
# Written by scripts/install-server.sh.
network:
    version: 2
    $SECTION:
        $INFRA_IF:
            accept-ra: true
EOF
    sudo chmod 600 /etc/netplan/60-thread-border-router.yaml
    sudo netplan apply 2> /dev/null
    note "netplan: accept-ra on $INFRA_IF"
fi

# 4. The app ----------------------------------------------------------------------------------
step "The app: its Python environment"
python3 -m venv "$REPO/manager/.venv"
"$REPO/manager/.venv/bin/pip" install -q --upgrade pip
"$REPO/manager/.venv/bin/pip" install -q -r "$REPO/manager/requirements.txt"

if [ "$WITH_SERVICE" = 1 ]; then
    step "Service: $SERVICE, started with the machine"
    sudo tee "$SERVICE_FILE" > /dev/null << EOF
[Unit]
Description=HA-CoAP fleet manager
Wants=network-online.target docker.service
After=network-online.target docker.service

[Service]
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$REPO/manager
# Only this machine can open it (127.0.0.1:8710) until other networks are ticked in its settings
# (Settings, Other devices); or reach it with an SSH tunnel
ExecStart=$REPO/manager/.venv/bin/python -m hacoap_manager --no-browser --workdir $REPO
Restart=on-failure
RestartSec=5
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
    sudo systemctl daemon-reload
    sudo systemctl enable -q "$SERVICE"
    sudo systemctl restart "$SERVICE"  # with the groups above
    note "Running: $(systemctl is-active "$SERVICE")"
fi

step "Done"
if [ "$NEED_RESTART" = 1 ]; then
    note "Restart this machine (sudo reboot), then run this script again: it finishes the kernel change."
fi
note "Open the page (on this machine: http://127.0.0.1:8710, or through an SSH tunnel:"
note "ssh -L 8710:127.0.0.1:8710 $APP_USER@<this machine>), then:"
note "  1. Settings > Backups: restore a backup from the old machine (it has the Thread network's settings)."
note "  2. Plug the radio dongle in (or pass it to this VM: in Proxmox, Hardware > Add > USB Device > by port)."
note "  3. Border router tab: choose the radio and $INFRA_IF, then Start the border router."
note "Optional: firmware builds need scripts/setup.sh (about 6 GB) and your signing key in application/keys/."
