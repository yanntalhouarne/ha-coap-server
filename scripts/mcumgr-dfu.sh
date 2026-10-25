#!/bin/bash

# ===================================================
# HA-CoAP Device Manager
# Guided firmware update of one device, over USB or over the air (Thread).
#
# Works on Linux, macOS and Windows (Git Bash). Needs mcumgr and Python 3.7+.
# Device discovery uses the zeroconf Python package or, on Linux, avahi-browse;
# without either, type the device's address.
#
# Usage: mcumgr-dfu.sh            (image from application/build, or $HACOAP_BUILD_DIR)
# ===================================================

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/hacoap-common.sh"

# Terminal colors for better visual experience
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

BUILD_DIR="${HACOAP_BUILD_DIR:-$HACOAP_DEFAULT_BUILD_DIR}"
TRANSPORT=""      # mcumgr connection profile: serial or udp
DEVICE_LABEL=""   # serial port or IPv6 address, for display

function print_banner() {
    clear
    echo -e "${BLUE}╔════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║                                                        ║${NC}"
    echo -e "${BLUE}║${CYAN}                HA-CoAP Device Manager                  ${BLUE}║${NC}"
    echo -e "${BLUE}║${CYAN}              Thread Device Flashing Tool               ${BLUE}║${NC}"
    echo -e "${BLUE}║                                                        ║${NC}"
    echo -e "${BLUE}╚════════════════════════════════════════════════════════╝${NC}"
    echo ""
}

function print_header() {
    echo ""
    echo -e "${BLUE}╔════════════════════════════════════════════════════╗${NC}"
    printf "${BLUE}║${NC}  %-50s${BLUE}║${NC}\n" "$1"
    echo -e "${BLUE}╚════════════════════════════════════════════════════╝${NC}"
}

function pause() {
    echo ""
    read -n 1 -s -r -p "${1:-Press any key to continue...}"
    echo ""
}

function disconnect() {
    if [ -n "$TRANSPORT" ]; then
        mcumgr conn remove "$TRANSPORT" > /dev/null 2>&1
        TRANSPORT=""
    fi
}

# Lets the user pick a serial port and creates the 'serial' connection.
# Returns 1 to go back to the main menu.
function connect_usb() {
    local ports=() descriptions=() port description board choice i

    echo -e "${YELLOW}→ Looking for serial ports...${NC}"
    while IFS=$'\t' read -r port description board; do
        [ -n "$port" ] || continue
        [ "$board" = "1" ] && description="${description} (ha-coap board)"
        ports+=("$port")
        descriptions+=("$description")
    done < <(hacoap_tools serial-ports)

    port=""
    if [ ${#ports[@]} -eq 0 ]; then
        echo -e "${RED}✗ No serial ports found.${NC}"
    else
        echo -e "${GREEN}✓ Serial ports (the board is usually listed first):${NC}"
        for i in "${!ports[@]}"; do
            echo -e "  ${CYAN}$((i+1)).${NC} ${ports[$i]} ${YELLOW}${descriptions[$i]}${NC}"
        done
        echo ""
        echo -e "${YELLOW}? Select a port [1-${#ports[@]}], 'c' to type one, or 'b' to go back:${NC} "
        read -r choice
        if [[ "$choice" == "b" ]]; then
            return 1
        elif [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le ${#ports[@]} ]; then
            port="${ports[$((choice-1))]}"
        elif [[ "$choice" != "c" ]]; then
            echo -e "${RED}✗ Invalid selection.${NC}"
            pause
            return 1
        fi
    fi

    if [ -z "$port" ]; then
        echo -e "${YELLOW}? Enter the serial port (for example COM7, /dev/ttyACM0 or /dev/cu.usbmodem1101):${NC} "
        read -r port
    fi
    if ! is_valid_serial_port "$port"; then
        echo -e "${RED}✗ Not a serial port name: ${port}${NC}"
        pause
        return 1
    fi

    echo -e "${YELLOW}→ Connecting via serial port ${CYAN}${port}${NC}..."
    if ! mcumgr conn add serial type="serial" connstring="${port},baud=115200,mtu=512" > /dev/null; then
        echo -e "${RED}✗ Failed to set up the serial connection!${NC}"
        pause
        return 1
    fi
    TRANSPORT="serial"
    DEVICE_LABEL="$port"
    echo -e "${GREEN}✓ Serial connection ready.${NC}"
}

# Lets the user pick a discovered device (or type an address) and creates the 'udp'
# connection. Returns 1 to go back to the main menu.
function connect_udp() {
    local names=() addresses=() name address choice i output status

    echo -e "${YELLOW}* Scanning for ha-coap devices...${NC}"
    echo -e "${CYAN}   This will take a few seconds...${NC}"
    output=$(hacoap_tools discover --timeout 3 2>/dev/null)
    status=$?
    while IFS=$'\t' read -r name address; do
        [ -n "$address" ] || continue
        names+=("$name")
        addresses+=("$address")
    done <<< "$output"

    address=""
    if [ "$status" = "3" ]; then
        echo -e "${YELLOW}ℹ Automatic discovery isn't available: $(install_hint discovery)${NC}"
    elif [ ${#addresses[@]} -eq 0 ]; then
        echo -e "${RED}✗ No ha-coap devices found.${NC}"
        echo -e "${CYAN}ℹ Check that the devices are powered and on the Thread network, and that this"
        echo -e "  computer is on the same network as the border router.${NC}"
    else
        echo -e "${GREEN}✓ Found ${#addresses[@]} ha-coap device(s):${NC}"
        for i in "${!addresses[@]}"; do
            echo -e "  ${CYAN}$((i+1)).${NC} ${names[$i]} ${YELLOW}(${addresses[$i]})${NC}"
        done
        echo ""
        echo -e "${YELLOW}? Select a device [1-${#addresses[@]}], 'm' to type an address, or 'b' to go back:${NC} "
        read -r choice
        if [[ "$choice" == "b" ]]; then
            return 1
        elif [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le ${#addresses[@]} ]; then
            address="${addresses[$((choice-1))]}"
            echo -e "${GREEN}✓ Selected device: ${CYAN}${names[$((choice-1))]}${NC}"
        elif [[ "$choice" != "m" ]]; then
            echo -e "${RED}✗ Invalid selection.${NC}"
            pause
            return 1
        fi
    fi

    if [ -z "$address" ]; then
        echo -e "${YELLOW}? Enter the device's IPv6 address (or press Enter to go back):${NC} "
        read -r address
        [ -n "$address" ] || return 1
    fi
    if ! is_valid_ipv6 "$address"; then
        echo -e "${RED}✗ Not an IPv6 address: ${address}${NC}"
        pause
        return 1
    fi

    echo -e "${YELLOW}→ Connecting via UDP to ${CYAN}[${address}]:1337${NC}..."
    if ! mcumgr conn add udp type="udp" connstring="[${address}]:1337" > /dev/null; then
        echo -e "${RED}✗ Failed to set up the UDP connection!${NC}"
        pause
        return 1
    fi
    TRANSPORT="udp"
    DEVICE_LABEL="$address"
    echo -e "${GREEN}✓ UDP connection ready.${NC}"
}

# Makes sure BUILD_DIR holds an update image, asking for another directory if not.
function find_image() {
    while [ ! -f "$BUILD_DIR/zephyr/app_update.bin" ]; do
        echo -e "${RED}✗ Firmware image not found: ${YELLOW}${BUILD_DIR}/zephyr/app_update.bin${NC}"
        echo -e "${YELLOW}? Enter the build directory (or press Enter to go back):${NC} "
        read -r BUILD_DIR
        if [ -z "$BUILD_DIR" ]; then
            BUILD_DIR="${HACOAP_BUILD_DIR:-$HACOAP_DEFAULT_BUILD_DIR}"
            return 1
        fi
    done
}

# Uploads the image, marks it for test or confirms it, and resets the device.
function upload_and_process_image() {
    local image image_list current_hash new_image_hash new_hash mode choice

    find_image || return
    image="$BUILD_DIR/zephyr/app_update.bin"

    echo -e "${YELLOW}→ Getting current image list...${NC}"
    if ! image_list=$(mcumgr -c "$TRANSPORT" image list 2>&1); then
        echo "$image_list"
        echo -e "${RED}✗ Could not reach the device.${NC}"
        pause
        return
    fi
    echo "$image_list"

    current_hash=$(echo "$image_list" | awk '/image=0 slot=0/{found=1} found && /hash:/{print $2; exit}')
    new_image_hash=$(hacoap_tools image-hash "$image" 2>/dev/null)
    if [ -n "$current_hash" ] && [ -n "$new_image_hash" ]; then
        echo -e "${GREEN}✓ Current image hash (slot 0): ${CYAN}${current_hash}${NC}"
        echo -e "${GREEN}✓ New image hash:               ${CYAN}${new_image_hash}${NC}"
        if [ "$current_hash" == "$new_image_hash" ]; then
            echo -e "${BLUE}ℹ This image is already installed on the device.${NC}"
            echo -e "${YELLOW}? Upload it anyway? (y/n):${NC} "
            read -r choice
            if [[ "$choice" != "y" ]]; then
                echo -e "${BLUE}Cancelled.${NC}"
                pause
                return
            fi
        fi
    else
        echo -e "${YELLOW}→ Could not compare image hashes. Proceeding anyway.${NC}"
    fi

    print_header "Firmware Update Configuration"
    echo -e "  ${CYAN}1.${NC} Test mode ${YELLOW}(boots once, reverts if it isn't confirmed)${NC}"
    echo -e "  ${CYAN}2.${NC} Confirm immediately ${RED}(permanent, no going back)${NC}"
    echo ""
    echo -e "${YELLOW}? Select update mode [1-2]:${NC} "
    read -r mode
    if [[ "$mode" != "1" && "$mode" != "2" ]]; then
        echo -e "${RED}✗ Invalid choice.${NC}"
        pause
        return
    fi

    echo ""
    echo -e "${YELLOW}→ Uploading firmware image ($(format_kib "$(file_size "$image")") KiB)...${NC}"
    echo -e "${CYAN}   This may take a while depending on connection speed...${NC}"
    echo ""
    if ! mcumgr -c "$TRANSPORT" image upload "$image"; then
        echo -e "${RED}✗ Image upload failed!${NC}"
        pause
        return
    fi
    echo -e "${GREEN}✓ Upload completed successfully.${NC}"

    echo -e "${YELLOW}→ Getting updated image list...${NC}"
    image_list=$(mcumgr -c "$TRANSPORT" image list 2>&1)
    echo "$image_list"
    new_hash=$(echo "$image_list" | awk '/image=0 slot=1/{found=1} found && /hash:/{print $2; exit}')
    if [ -z "$new_hash" ]; then
        echo -e "${RED}✗ Failed to get the new image's hash!${NC}"
        pause
        return
    fi
    echo -e "${GREEN}✓ New image hash: ${CYAN}${new_hash}${NC}"

    if [[ "$mode" == "1" ]]; then
        echo -e "${YELLOW}→ Marking the image for test...${NC}"
        if ! mcumgr -c "$TRANSPORT" image test "$new_hash"; then
            echo -e "${RED}✗ Failed to mark the image for test.${NC}"
            pause
            return
        fi
        echo -e "${GREEN}✓ Image marked for testing. It runs once after the reset.${NC}"
        echo -e "${CYAN}ℹ Once it works, confirm it: mcumgr -c <connection> image confirm${NC}"
    else
        echo -e "${YELLOW}→ Confirming image...${NC}"
        if ! mcumgr -c "$TRANSPORT" image confirm "$new_hash"; then
            echo -e "${RED}✗ Failed to confirm the image.${NC}"
            pause
            return
        fi
        echo -e "${GREEN}✓ Image confirmed permanently.${NC}"
    fi

    echo ""
    echo -e "${YELLOW}→ Resetting device...${NC}"
    mcumgr -c "$TRANSPORT" reset
    echo -e "${GREEN}✓ Device reset initiated.${NC}"
    echo ""
    echo -e "${GREEN}✓ Flash process completed.${NC}"
    pause "Press any key to return to the main menu..."
    return 2
}

# Operations on the connected device, until the user goes back.
function device_menu() {
    local choice
    while true; do
        print_header "Device: ${DEVICE_LABEL}"
        echo -e "  ${CYAN}1.${NC} Upload and flash new firmware image"
        echo -e "  ${CYAN}2.${NC} List current firmware images"
        echo -e "  ${CYAN}3.${NC} Return to the main menu"
        echo ""
        echo -e "${YELLOW}? Select operation [1-3]:${NC} "
        read -r choice
        case "$choice" in
            1)
                upload_and_process_image
                [ $? -eq 2 ] && return
                ;;
            2)
                echo -e "${YELLOW}→ Listing firmware images...${NC}"
                echo ""
                mcumgr -c "$TRANSPORT" image list
                pause "Press any key to return to the operations menu..."
                ;;
            3) return ;;
            *) echo -e "${RED}✗ Invalid selection.${NC}" ;;
        esac
    done
}

function main_menu() {
    local choice
    while true; do
        print_banner
        echo -e "  ${CYAN}1.${NC} Update over USB (serial)"
        echo -e "  ${CYAN}2.${NC} Update over the air (Thread, UDP)"
        echo -e "  ${CYAN}q.${NC} Quit"
        echo ""
        echo -e "${YELLOW}? Select connection method [1-2, q]:${NC} "
        read -r choice
        case "$choice" in
            1) connect_usb && device_menu ;;
            2) connect_udp && device_menu ;;
            q|"") echo -e "${BLUE}Goodbye!${NC}"; return ;;
            *) echo -e "${RED}✗ Invalid selection.${NC}"; pause ;;
        esac
        disconnect
    done
}

# Check for required dependencies
echo -e "${YELLOW}→ Checking for required dependencies...${NC}"
if ! command -v mcumgr > /dev/null 2>&1; then
    echo -e "${RED}✗ mcumgr not found.${NC} $(install_hint mcumgr)"
    exit 1
fi
if ! find_python; then
    echo -e "${RED}✗ Python 3.7+ not found.${NC} $(install_hint python)"
    exit 1
fi

trap disconnect EXIT
main_menu
