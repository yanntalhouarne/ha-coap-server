#!/bin/bash

# ========================================================================
#                    HA-CoAP Bulk Device Manager
#          A tool for efficient firmware updates to Thread devices
#
# Works on Linux, macOS and Windows (Git Bash). Needs mcumgr and Python 3.7+.
# Device discovery uses the zeroconf Python package or, on Linux, avahi-browse;
# without either, type the device addresses.
# ========================================================================

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/hacoap-common.sh"

# ----------------------
# Non-interactive mode
# ----------------------
# Used by the web updater (../firmware-updater). Set HACOAP_NON_INTERACTIVE=true
# and pass the settings through these environment variables instead of prompts:
#   HACOAP_BUILD_DIR      build directory containing zephyr/app_update.bin
#                         (default: application/build in this repository)
#   HACOAP_DEVICES        space-separated "name=address" entries (IPv6 address for
#                         UDP; COM7, /dev/ttyACM0 or /dev/cu.usbmodem... for USB);
#                         "address" alone also works
#   HACOAP_CONNECTION     UDP (default) or USB
#   HACOAP_UPDATE_MODE    test (default) or confirm
#   HACOAP_STALL_TIMEOUT  seconds before a stalled upload is cancelled (0 disables)
#   HACOAP_MAX_RETRIES    upload attempts per device
# Each device ends with a machine-readable "RESULT <name> success|skipped|failed" line.
NON_INTERACTIVE="${HACOAP_NON_INTERACTIVE:-false}"

# ----------------------
# Terminal color definitions
# ----------------------
if [ "$NON_INTERACTIVE" = true ]; then
    # Plain output for log files and the web UI
    RED=''; GREEN=''; YELLOW=''; BLUE=''; PURPLE=''; CYAN=''
    BOLD=''; DIM=''; NC=''
    BG_BLUE=''; BG_GREEN=''; BG_RED=''; BG_YELLOW=''
else
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[0;33m'
    BLUE='\033[0;34m'
    PURPLE='\033[0;35m'
    CYAN='\033[0;36m'
    BOLD='\033[1m'
    DIM='\033[2m'
    NC='\033[0m' # No Color
    BG_BLUE='\033[44m'
    BG_GREEN='\033[42m'
    BG_RED='\033[41m'
    BG_YELLOW='\033[43m'
fi

# ----------------------
# Configuration variables
# ----------------------
declare -r TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
declare -r TEMP_PROGRESS_FILE="/tmp/mcumgr_progress_${TIMESTAMP}_$$.tmp"

# Default settings (can be modified by user input)
UPLOAD_STALL_TIMEOUT=300  # 5 minutes in seconds
PROGRESS_CHECK_INTERVAL=1  # Check progress every second for smoother UI
MAX_UPLOAD_RETRIES=3  # Maximum number of upload retry attempts

# Global variables for tracking devices and statistics
declare -a DEVICE_NAMES
declare -a DEVICE_ADDRESSES
declare -a SELECTED_INDICES
declare -a SERIAL_PORTS
declare -a SERIAL_PORT_DESCRIPTIONS
UPLOAD_PID=""  # mcumgr upload running in the background, if any
MONITOR_PID="" # stall monitor running in the background, if any
BOARD_PORT_COUNT=0 # serial ports identified as the ha-coap board
DEVICES_ENTERED=false # true when device addresses were typed instead of discovered
SUCCESSFUL_UPDATES=0
FAILED_UPDATES=0
SKIPPED_UPDATES=0
BUILD_DIR=""
DEVICE_RESULT="" # outcome of the last update_device call: success, skipped or failed
TEST_MODE=true
CONNECTION_TYPE="" # New variable to store connection type (USB or UDP)
SERIAL_PORT="" # New variable to store the selected serial port

# ----------------------
# UI Components
# ----------------------

# Function: draw_box
# Description: Draws a colored box with text
# Parameters:
#   $1 - Text to display
#   $2 - Color for the box (optional)
function draw_box() {
    local text="$1"
    local color="${2:-$BLUE}"
    local length=${#text}
    local border_length=$((length + 4))
    
    echo -e "${color}+$(printf '%*s' $border_length | tr ' ' '-')+${NC}"
    echo -e "${color}|  ${NC}${BOLD}${text}${NC}${color}  |${NC}"
    echo -e "${color}+$(printf '%*s' $border_length | tr ' ' '-')+${NC}"
}

# Function: draw_progress_bar
# Description: Draws a simple progress bar
# Parameters:
#   $1 - Current value (0-100)
#   $2 - Width of the progress bar
function draw_progress_bar() {
    local current=$1
    local width=${2:-50}
    
    # Ensure current is within bounds
    if [ $current -lt 0 ]; then
        current=0
    elif [ $current -gt 100 ]; then
        current=100
    fi
    
    # Calculate the number of filled and empty segments
    local filled=$(( (width * current) / 100 ))
    local empty=$((width - filled))
    
    # Construct the progress bar
    local bar=""
    bar+="${GREEN}$(printf '%*s' $filled '' | tr ' ' '#')${NC}"
    bar+="${DIM}$(printf '%*s' $empty '' | tr ' ' '.')${NC}"
    
    # Print with percentage
    printf "[%s] %3d%%" "$bar" "$current"
}

# Function: show_spinner
# Description: Shows a spinner for a command
# Parameters:
#   $1 - Command to run
#   $2 - Message to display
function show_spinner() {
    local cmd="$1"
    local msg="$2"
    
    # Run the command in the background
    eval "$cmd" &
    local pid=$!
    
    # Spinner characters
    local spin='-\|/'
    local i=0
    
    # Display spinner while command runs
    echo -n "$msg "
    while kill -0 $pid 2>/dev/null; do
        local char="${spin:i++%${#spin}:1}"
        printf "\b%s" "$char"
        sleep 0.1
    done
    printf "\b \n"
    
    # Wait for the background process to finish
    wait $pid
    return $?
}

# ----------------------
# Utility Functions
# ----------------------

# Function: log
# Description: Logs messages to console with appropriate formatting
# Parameters:
#   $1 - Log level (INFO, SUCCESS, ERROR, WARNING, DEBUG, PROGRESS)
#   $2 - Message to log
function log() {
    local level="$1"
    local message="$2"
    local color="$NC"
    local prefix=""
    local icon=""
    
    case "$level" in
        "INFO")     color="$CYAN";    prefix="[INFO]";    icon="ℹ " ;;
        "SUCCESS")  color="$GREEN";   prefix="[SUCCESS]"; icon="✓ " ;;
        "ERROR")    color="$RED";     prefix="[ERROR]";   icon="✗ " ;;
        "WARNING")  color="$YELLOW";  prefix="[WARNING]"; icon="! " ;;
        "DEBUG")    color="$DIM";     prefix="[DEBUG]";   icon="  " ;;
        "PROGRESS") color="$CYAN";    prefix="[PROGRESS]";icon="  " ;;
    esac
    
    # Print to console with color, only if not DEBUG level
    if [ "$level" != "DEBUG" ]; then
        echo -e "${color}${icon}${prefix}${NC} ${message}"
    fi
}

# Function: print_banner
# Description: Displays a stylized banner at the start of the script
function print_banner() {
    if [ "$NON_INTERACTIVE" != true ]; then
        clear
    fi

    echo ""
    echo -e "${BLUE}+----------------------------------------------------+${NC}"
    echo -e "${BLUE}|                                                    |${NC}"
    echo -e "${BLUE}|${BOLD}${CYAN}            HA-CoAP Bulk Updater v1.6.0             ${BLUE}|${NC}"
    echo -e "${BLUE}|${CYAN}             Multi-Device Flashing Tool             ${BLUE}|${NC}"
    echo -e "${BLUE}|                                                    |${NC}"
    echo -e "${BLUE}+----------------------------------------------------+${NC}"
    
    echo ""
}

# Function: cleanup
# Description: Cleans up temporary files and processes
function cleanup() {
    # Stop the upload and stall monitor this script started, if still running
    if [ -n "$UPLOAD_PID" ] && kill -0 "$UPLOAD_PID" 2>/dev/null; then
        log "WARNING" "Stopping the unfinished mcumgr upload..."
        stop_process "$UPLOAD_PID"
    fi
    stop_process "$MONITOR_PID"
    UPLOAD_PID=""
    MONITOR_PID=""

    # Clean up all temporary files (the monitor also exits once its file is gone)
    rm -f "$TEMP_PROGRESS_FILE" "$TEMP_PROGRESS_FILE.stalled" 2>/dev/null
}

# ----------------------
# Connection Type Selection
# ----------------------

# Function: select_connection_type
# Description: Prompt user to select between USB and UDP connection
function select_connection_type() {
    draw_box "Connection Type Selection" "${BLUE}"
    
    echo -e "${YELLOW}Please select the connection type:${NC}"
    echo ""
    
    # Show the options with better visuals
    echo -e "  ${CYAN}1${NC}  ${BOLD}USB Connection${NC}"
    echo -e "    ${DIM}• Connect to devices via serial port${NC}"
    echo -e "    ${DIM}• Requires physical USB connection to devices${NC}"
    echo ""
    echo -e "  ${CYAN}2${NC}  ${BOLD}UDP Connection${NC}"
    echo -e "    ${DIM}• Connect to devices over Thread network${NC}"
    echo -e "    ${DIM}• Supports remote device updates${NC}"
    echo ""
    
    printf "${YELLOW}? Select connection type [1-2]:${NC} "
    read -r connection_choice
    
    if [[ "$connection_choice" == "1" ]]; then
        CONNECTION_TYPE="USB"
        echo -e "${GREEN}✓${NC} Selected: ${BOLD}USB Connection${NC}"
        log "INFO" "Selected connection type: USB"
    elif [[ "$connection_choice" == "2" ]]; then
        CONNECTION_TYPE="UDP"
        echo -e "${GREEN}✓${NC} Selected: ${BOLD}UDP Connection${NC}"
        log "INFO" "Selected connection type: UDP"
    else
        echo -e "${RED}✗ Invalid selection: $connection_choice${NC}"
        log "ERROR" "Invalid connection type selection: $connection_choice"
        exit 1
    fi
}

# Function: list_serial_ports
# Description: Detects serial ports for the USB connection (the board's first)
function list_serial_ports() {
    draw_box "Scanning for Serial Ports" "${BLUE}"

    log "INFO" "Scanning for serial ports..."

    echo -e "${CYAN}Scanning for available serial ports...${NC}"

    SERIAL_PORTS=()
    SERIAL_PORT_DESCRIPTIONS=()
    BOARD_PORT_COUNT=0
    local port description board
    while IFS=$'\t' read -r port description board; do
        [ -n "$port" ] || continue
        if [ "$board" = "1" ]; then
            description="${description} (ha-coap board)"
            BOARD_PORT_COUNT=$((BOARD_PORT_COUNT + 1))
        fi
        SERIAL_PORTS+=("$port")
        SERIAL_PORT_DESCRIPTIONS+=("$description")
    done < <(hacoap_tools serial-ports)

    # Check if we found any ports
    if [ ${#SERIAL_PORTS[@]} -eq 0 ]; then
        echo ""
        echo -e "${YELLOW}No serial ports found.${NC}"
        log "WARNING" "No serial ports found. Check the USB cable, drivers and permissions, or type the port name."
        return
    fi

    # Display the list of ports in a nice format
    echo ""
    echo -e "${BOLD}Found ${GREEN}${#SERIAL_PORTS[@]}${NC}${BOLD} serial ports:${NC}"
    echo -e "${DIM}---------------------------------------------${NC}"

    for i in "${!SERIAL_PORTS[@]}"; do
        printf "${GREEN}%2d${NC}  ${BOLD}%-20s${NC}  ${DIM}%s${NC}\n" $((i+1)) "${SERIAL_PORTS[$i]}" "${SERIAL_PORT_DESCRIPTIONS[$i]}"
    done

    echo -e "${DIM}---------------------------------------------${NC}"
    echo ""

    log "SUCCESS" "Found ${#SERIAL_PORTS[@]} serial port(s)"
}

# Function: select_serial_port
# Description: Lets the user pick the serial port, or type one
function select_serial_port() {
    # If the board is the only port, or the only board port, select it automatically
    if [ ${#SERIAL_PORTS[@]} -eq 1 ] || [ "$BOARD_PORT_COUNT" -eq 1 ]; then
        SERIAL_PORT="${SERIAL_PORTS[0]}"
        echo -e "${GREEN}✓${NC} Automatically selected: ${BOLD}${SERIAL_PORT}${NC} ${DIM}${SERIAL_PORT_DESCRIPTIONS[0]}${NC}"
        log "INFO" "Automatically selected serial port: ${SERIAL_PORT}"
        return
    fi

    if [ ${#SERIAL_PORTS[@]} -gt 1 ]; then
        echo -e "${YELLOW}Select a serial port (enter the number, or press Enter to type one):${NC}"
        echo ""

        for i in "${!SERIAL_PORTS[@]}"; do
            printf "${CYAN}%2d${NC}  ${BOLD}%-20s${NC}  ${DIM}%s${NC}\n" $((i+1)) "${SERIAL_PORTS[$i]}" "${SERIAL_PORT_DESCRIPTIONS[$i]}"
        done

        echo ""
        printf "${YELLOW}?${NC} Enter selection: "
        read -r port_selection

        if [[ "$port_selection" =~ ^[0-9]+$ ]] && [ "$port_selection" -ge 1 ] && [ "$port_selection" -le ${#SERIAL_PORTS[@]} ]; then
            SERIAL_PORT="${SERIAL_PORTS[$((port_selection-1))]}"
            echo -e "${GREEN}✓${NC} Selected port: ${BOLD}${SERIAL_PORT}${NC}"
            log "INFO" "Selected serial port: ${SERIAL_PORT}"
            return
        elif [ -n "$port_selection" ]; then
            echo -e "${RED}✗ Invalid selection: $port_selection${NC}"
            log "ERROR" "Invalid serial port selection: $port_selection"
            exit 1
        fi
    fi

    echo -e "${YELLOW}Enter the serial port (for example COM7, /dev/ttyACM0 or /dev/cu.usbmodem1101):${NC}"
    printf "${BOLD}>${NC} "
    read -r SERIAL_PORT
    if ! is_valid_serial_port "$SERIAL_PORT"; then
        echo -e "${RED}✗ Not a serial port name: ${SERIAL_PORT}${NC}"
        log "ERROR" "Invalid serial port: ${SERIAL_PORT}"
        exit 1
    fi
    log "INFO" "Selected serial port: ${SERIAL_PORT}"
}

# ----------------------
# Device Discovery & Management
# ----------------------

# Function: discover_devices
# Description: Finds HA-CoAP devices on the network (see hacoap_tools.py discover),
# or asks for their addresses when discovery isn't available or finds nothing.
# Only used for UDP connection
function discover_devices() {
    # Draw nice header
    draw_box "Scanning for Thread Devices"

    log "INFO" "Scanning for ha-coap devices..."

    echo -e "${CYAN}Scanning network for HA-CoAP devices...${NC}"

    local output status name address
    output=$(hacoap_tools discover --timeout 3 2>/dev/null)
    status=$?

    DEVICE_NAMES=()
    DEVICE_ADDRESSES=()
    while IFS=$'\t' read -r name address; do
        [ -n "$address" ] || continue
        DEVICE_NAMES+=("$name")
        DEVICE_ADDRESSES+=("$address")
    done <<< "$output"

    if [ $status -eq 3 ]; then
        log "WARNING" "Automatic discovery isn't available: $(install_hint discovery)"
    elif [ ${#DEVICE_ADDRESSES[@]} -eq 0 ]; then
        echo ""
        echo -e "${BG_RED}${BOLD} No ha-coap devices found ${NC}"
        echo ""
        log "WARNING" "No ha-coap devices found."
        log "INFO" "Troubleshooting tips:"
        log "INFO" "- Make sure your devices are powered on and on the Thread network"
        log "INFO" "- Make sure this computer is on the same network as the border router"
    fi

    if [ ${#DEVICE_ADDRESSES[@]} -eq 0 ]; then
        enter_device_addresses
        return
    fi

    echo -e "${GREEN}✓${NC} Scan complete!"

    # Display the list of devices in a nicer format
    echo ""
    echo -e "${BOLD}Found ${GREEN}${#DEVICE_ADDRESSES[@]}${NC}${BOLD} HA-CoAP devices:${NC}"
    echo -e "${DIM}---------------------------------------------${NC}"

    for i in "${!DEVICE_ADDRESSES[@]}"; do
        printf "${GREEN}%2d${NC}  ${BOLD}%-30s${NC}  ${DIM}%s${NC}\n" $((i+1)) "${DEVICE_NAMES[$i]}" "${DEVICE_ADDRESSES[$i]}"
    done

    echo -e "${DIM}---------------------------------------------${NC}"
    echo ""

    log "SUCCESS" "Found ${#DEVICE_ADDRESSES[@]} ha-coap device(s)"
}

# Function: enter_device_addresses
# Description: Asks for device IPv6 addresses; all of them are then updated
function enter_device_addresses() {
    local line address

    echo -e "${YELLOW}Enter the devices' IPv6 addresses, separated by spaces:${NC}"
    printf "${BOLD}>${NC} "
    read -r line

    for address in $line; do
        if ! is_valid_ipv6 "$address"; then
            echo -e "${RED}✗ Not an IPv6 address: ${address}${NC}"
            log "ERROR" "Invalid IPv6 address: ${address}"
            exit 1
        fi
        DEVICE_NAMES+=("$address")
        DEVICE_ADDRESSES+=("$address")
    done

    if [ ${#DEVICE_ADDRESSES[@]} -eq 0 ]; then
        log "ERROR" "No devices given."
        exit 1
    fi
    DEVICES_ENTERED=true
    log "INFO" "Using ${#DEVICE_ADDRESSES[@]} device(s) entered by hand"
}

# Function: setup_usb_device
# Description: Sets up a placeholder device for USB connection
function setup_usb_device() {
    # For USB connection, we'll create a placeholder device
    DEVICE_NAMES=("USB-Device")
    DEVICE_ADDRESSES=("$SERIAL_PORT")
    
    echo -e "${GREEN}✓${NC} USB device configured: ${BOLD}${SERIAL_PORT}${NC}"
    log "INFO" "USB device configured with port: ${SERIAL_PORT}"
    
    # Auto-select the only device
    SELECTED_INDICES=(0)
}

# Function: select_devices
# Description: Allow user to select which devices to update
# Only used for UDP connection
function select_devices() {
    # Devices entered by hand are all updated
    if [ "$DEVICES_ENTERED" = true ]; then
        SELECTED_INDICES=("${!DEVICE_ADDRESSES[@]}")
        log "INFO" "Selected all ${#DEVICE_ADDRESSES[@]} device(s) entered"
        return
    fi
    
    # If only one device, select it automatically
    if [ ${#DEVICE_NAMES[@]} -eq 1 ]; then
        SELECTED_INDICES=(0)
        log "INFO" "Automatically selected the only available device: ${DEVICE_NAMES[0]}"
        return
    fi
    
    draw_box "Device Selection" "${BLUE}"
    
    echo -e "${YELLOW}Select devices to update (comma-separated list, 'all' for all devices):${NC}"
    echo ""
    
    # Display devices with numbers
    for i in "${!DEVICE_NAMES[@]}"; do
        printf "${CYAN}%2d${NC}  ${BOLD}%-30s${NC}  ${DIM}%s${NC}\n" $((i+1)) "${DEVICE_NAMES[$i]}" "${DEVICE_ADDRESSES[$i]}"
    done
    
    echo ""
    printf "${YELLOW}?${NC} Enter selection: "
    read -r selection
    
    # Process selection
    if [[ "$selection" == "all" ]]; then
        # Select all devices
        for i in "${!DEVICE_NAMES[@]}"; do
            SELECTED_INDICES+=($i)
        done
        log "INFO" "Selected all ${#DEVICE_NAMES[@]} devices"
    else
        # Process comma-separated list
        IFS=',' read -ra NUMS <<< "$selection"
        for num in "${NUMS[@]}"; do
            # Remove any whitespace
            num=$(echo "$num" | tr -d '[:space:]')
            # Handle ranges like 1-3
            if [[ "$num" == *-* ]]; then
                start=${num%-*}
                end=${num#*-}
                if [[ "$start" =~ ^[0-9]+$ ]] && [[ "$end" =~ ^[0-9]+$ ]]; then
                    for ((i=start; i<=end; i++)); do
                        if [ $i -ge 1 ] && [ $i -le ${#DEVICE_NAMES[@]} ]; then
                            SELECTED_INDICES+=($((i-1)))
                        fi
                    done
                fi
            # Handle single numbers
            elif [[ "$num" =~ ^[0-9]+$ ]]; then
                if [ "$num" -ge 1 ] && [ "$num" -le ${#DEVICE_NAMES[@]} ]; then
                    SELECTED_INDICES+=($((num-1)))
                fi
            fi
        done
    fi
    
    # Remove duplicates
    SELECTED_INDICES=($(echo "${SELECTED_INDICES[@]}" | tr ' ' '\n' | sort -u | tr '\n' ' '))
    
    # Verify at least one device is selected
    if [ ${#SELECTED_INDICES[@]} -eq 0 ]; then
        echo ""
        echo -e "${BG_RED}${BOLD} No valid devices selected ${NC}"
        log "ERROR" "No valid devices selected."
        exit 1
    fi
    
    # Show the selected devices
    echo ""
    echo -e "${BOLD}Selected ${GREEN}${#SELECTED_INDICES[@]}${NC}${BOLD} devices for update:${NC}"
    echo -e "${DIM}---------------------------------------------${NC}"
    
    for i in "${SELECTED_INDICES[@]}"; do
        printf "${GREEN}%2d${NC}  ${BOLD}%-30s${NC}  ${DIM}%s${NC}\n" $((i+1)) "${DEVICE_NAMES[$i]}" "${DEVICE_ADDRESSES[$i]}"
    done
    
    echo -e "${DIM}---------------------------------------------${NC}"
    echo ""
    
    log "INFO" "Selected ${#SELECTED_INDICES[@]} devices for update"
}

# Function: extract_kib_value
# Description: Prints the upload percentage (0-100) from an mcumgr progress line
#   ("12.34 KiB / 456.78 KiB" or "0 B / 456.78 KiB")
# Parameters:
#   $1 - Progress line to extract from
function extract_kib_value() {
    local progress_line="$1"

    if [[ "$progress_line" =~ ([0-9]+\.?[0-9]*)\ *(B|KiB|KB)\ */\ *([0-9]+\.?[0-9]*)\ *(KiB|KB) ]]; then
        awk -v current="${BASH_REMATCH[1]}" -v unit="${BASH_REMATCH[2]}" -v total="${BASH_REMATCH[3]}" \
            'BEGIN { if (unit == "B") current /= 1024; if (total > 0) printf "%d", current * 100 / total; else print 0 }'
    else
        echo "0"
    fi
}

# ----------------------
# Stall Monitoring
# ----------------------

# Function: start_stall_monitor
# Description: Starts the stall monitor (hacoap_tools.py stall-monitor) in the background.
# It writes $TEMP_PROGRESS_FILE.stalled when the upload progress stops changing for
# UPLOAD_STALL_TIMEOUT seconds; the upload loop then stops mcumgr.
function start_stall_monitor() {
    hacoap_tools stall-monitor "$TEMP_PROGRESS_FILE" "$UPLOAD_STALL_TIMEOUT" &
    MONITOR_PID=$!
}

# ----------------------
# Firmware Update Functions
# ----------------------

# Function: update_device
# Description: Updates firmware on a single device with retry logic
# Parameters:
#   $1 - Device name
#   $2 - Device address or serial port
#   $3 - Test mode flag (true/false)
#   $4 - Connection type (USB or UDP)
function update_device() {
    local device_name="$1"
    local device_address="$2"
    local test_mode="$3"
    local connection_type="$4"
    local retry_count=0
    local upload_success=false
    local connection_id=""
    DEVICE_RESULT="failed"
    current_hash=""
    new_image_hash=""

    # Draw a nice box for this device
    echo ""
    draw_box "Updating Device: ${BOLD}${device_name}${NC}" "${BLUE}"
    
    log "INFO" "===== Processing device: ${device_name} (${device_address}) ====="
    
    # Add the connection based on type
    if [ "$connection_type" = "UDP" ]; then
        echo -ne "${CYAN}→${NC} Connecting via UDP to [${device_address}]:1337... "
        mcumgr conn add udp type="udp" connstring="[${device_address}]:1337" > /dev/null 2>&1
        connection_id="udp"
    else
        echo -ne "${CYAN}→${NC} Connecting via serial to ${device_address}... "
        mcumgr conn add serial type="serial" connstring="${device_address},baud=115200,mtu=512" > /dev/null 2>&1
        connection_id="serial"
    fi
    
    if [ $? -ne 0 ]; then
        echo -e "${RED}Failed!${NC}"
        log "ERROR" "Failed to establish ${connection_type} connection to ${device_name}"
        return 1
    fi
    
    echo -e "${GREEN}Connected!${NC}"
    log "SUCCESS" "${connection_type} connection established to ${device_name}"
    
    # Get the current image list
    echo -ne "${CYAN}→${NC} Retrieving current image list... "
    image_list_output=$(mcumgr -c "$connection_id" image list 2>&1)
    
    # Check if the command was successful
    if [ $? -ne 0 ]; then
        echo -e "${RED}Failed!${NC}"
        log "ERROR" "Failed to retrieve image list from ${device_name}: ${image_list_output}"
        mcumgr conn remove "$connection_id" > /dev/null 2>&1
        return 1
    fi
    
    echo -e "${GREEN}Received!${NC}"
    
    # Extract the current hash in slot 0
    current_hash=$(echo "$image_list_output" | awk '/image=0 slot=0/{found=1} found && /hash:/{print $2; exit}')
    
    if [ -z "$current_hash" ]; then
        echo -e "${YELLOW}→ Could not determine current image hash.${NC} ${DIM}Proceeding anyway.${NC}"
        log "WARNING" "Could not determine current image hash for ${device_name}. Proceeding anyway."
    else
        echo -e "${CYAN}ℹ${NC} Current image hash: ${DIM}${current_hash}${NC}"
        log "INFO" "Current image hash on ${device_name}: ${current_hash}"
        
        # Get the hash of the image we're about to upload
        echo -ne "${CYAN}→${NC} Getting hash of new image... "
        new_image_hash=$(hacoap_tools image-hash "${BUILD_DIR}/zephyr/app_update.bin" 2>/dev/null)
        
        if [ -z "$new_image_hash" ]; then
            echo -e "${YELLOW}Not available${NC}"
            log "WARNING" "Could not determine new image hash. Proceeding anyway."
        else
            echo -e "${GREEN}Received!${NC}"
            log "INFO" "New image hash: ${new_image_hash}"
            
            # Compare the hashes
            if [ "$current_hash" == "$new_image_hash" ]; then
                echo -e "${GREEN}✓${NC} Device ${BOLD}${device_name}${NC} already has the current image installed."
                echo -e "${DIM}Skipping update for this device.${NC}"
                log "INFO" "Device ${device_name} already has the current image installed."
                # Clean up connection
                mcumgr conn remove "$connection_id" > /dev/null 2>&1
                # Increment skipped updates count
                SKIPPED_UPDATES=$((SKIPPED_UPDATES + 1))
                DEVICE_RESULT="skipped"
                return 0
            fi
        fi
    fi
    
    # Show image information
    local image_size
    if image_size=$(file_size "${BUILD_DIR}/zephyr/app_update.bin"); then
        echo -e "${CYAN}ℹ${NC} Firmware size: $(format_kib "$image_size") KiB"
    fi

    # Implement retry logic
    while [ $retry_count -lt $MAX_UPLOAD_RETRIES ] && [ "$upload_success" = false ]; do
        # Increment retry count
        retry_count=$((retry_count + 1))

        if [ $retry_count -gt 1 ]; then
            echo -e "${YELLOW}→ Retry attempt $retry_count of $MAX_UPLOAD_RETRIES...${NC}"
            log "INFO" "Retry attempt $retry_count of $MAX_UPLOAD_RETRIES for ${device_name}..."
            # Add a short delay before retrying
            sleep 3
        fi

        # Upload the new image with stall detection
        echo -e "${CYAN}→${NC} ${BOLD}Uploading firmware image...${NC}"
        log "INFO" "Uploading firmware image to ${device_name}..."
        if [ $UPLOAD_STALL_TIMEOUT -gt 0 ]; then
            echo -e "${DIM}Upload will be terminated if stalled for ${UPLOAD_STALL_TIMEOUT} seconds${NC}"
            log "INFO" "Upload will be terminated if stalled for ${UPLOAD_STALL_TIMEOUT} seconds"
        fi

        # Record start time for timing the upload
        local upload_start_time=$(date +%s)

        # Clear the progress file and stall indicator
        > "$TEMP_PROGRESS_FILE"
        rm -f "$TEMP_PROGRESS_FILE.stalled" 2>/dev/null

        # Start the upload in the background, with its progress output going to a file
        mcumgr -c "$connection_id" image upload "${BUILD_DIR}/zephyr/app_update.bin" > "$TEMP_PROGRESS_FILE" 2>&1 &
        UPLOAD_PID=$!

        # Start the stall monitor only if stall detection is enabled
        if [ $UPLOAD_STALL_TIMEOUT -gt 0 ]; then
            start_stall_monitor
        fi

        # Calculate a reasonable timeout (stall timeout plus margin)
        wait_timeout=$((UPLOAD_STALL_TIMEOUT + 3600))  # 1 hour margin

        # Wait for the upload to finish with timeout and show a simple progress indicator
        upload_status=0
        upload_done=false

        # Start a timeout counter
        start_time=$(date +%s)
        last_percent=0
        progress_bar_width=40

        # Create a line for the progress bar and keep updating it
        echo -e " [${DIM}$(printf '%-'$progress_bar_width's' | tr ' ' '.')${NC}] 0%"

        while ! $upload_done; do
            # Check if process is still running
            if ! kill -0 "$UPLOAD_PID" 2>/dev/null; then
                # Process completed
                wait "$UPLOAD_PID" 2>/dev/null
                upload_status=$?
                upload_done=true

                # Show 100% progress for successful completion
                if [ $upload_status -eq 0 ]; then
                    echo -ne "\r "
                    draw_progress_bar 100 $progress_bar_width
                    echo ""
                    log "INFO" "Upload process completed successfully"
                else
                    echo ""
                    tr '\r' '\n' < "$TEMP_PROGRESS_FILE" | grep -av "KiB" | tail -n 3
                    log "INFO" "Upload process completed with error status $upload_status"
                fi
            else
                # Check for stall marker
                if [ -f "$TEMP_PROGRESS_FILE.stalled" ]; then
                    log "ERROR" "Upload stalled and was terminated by monitor"
                    stop_process "$UPLOAD_PID"
                    upload_status=1
                    upload_done=true

                    # Show error in the progress bar
                    echo -e "\r ${RED}[STALLED]${NC} Upload terminated due to stall timeout               "
                else
                    # Check for timeout
                    current_time=$(date +%s)
                    elapsed=$((current_time - start_time))

                    if [ $elapsed -gt $wait_timeout ]; then
                        log "WARNING" "Upload timeout after ${elapsed}s, forcing termination"
                        stop_process "$UPLOAD_PID"
                        upload_status=1
                        upload_done=true

                        # Show error in the progress bar
                        echo -e "\r ${RED}[TIMEOUT]${NC} Upload exceeded maximum time limit               "
                    else
                        # Get the last progress line (mcumgr redraws it with carriage returns)
                        local progress_line=$(tr '\r' '\n' < "$TEMP_PROGRESS_FILE" 2>/dev/null | grep -a "/" | grep -a "KiB" | tail -n 1)
                        if [ -n "$progress_line" ]; then
                            # Extract percentage
                            local percent=$(extract_kib_value "$progress_line")

                            # Only update if the percentage has changed
                            if [ "$percent" != "$last_percent" ]; then
                                last_percent=$percent
                                # Update the progress bar
                                echo -ne "\r "
                                draw_progress_bar $percent $progress_bar_width
                                # Use PROGRESS level for progress updates - these won't go to log file
                                log "PROGRESS" "Upload progress: $percent%"
                            fi
                        fi

                        # Sleep briefly before checking again
                        sleep $PROGRESS_CHECK_INTERVAL
                    fi
                fi
            fi
        done
        UPLOAD_PID=""

        # Check if the process was killed due to a stall
        if [ -f "$TEMP_PROGRESS_FILE.stalled" ]; then
            upload_status=1

            # Get stall information from the marker file
            if [ -s "$TEMP_PROGRESS_FILE.stalled" ]; then
                stall_info=$(cat "$TEMP_PROGRESS_FILE.stalled")
                # Split the info by the pipe character
                IFS='|' read -r stalled_value stalled_time <<< "$stall_info"

                echo -e "${RED}✗ Upload failed due to stall timeout${NC}"
                log "ERROR" "Upload failed - stalled at ${stalled_value} for ${stalled_time} seconds"
            else
                echo -e "${RED}✗ Upload failed due to stall timeout${NC}"
                log "ERROR" "Upload failed due to stall timeout"
            fi
        fi

        # Stop the monitor if it's still running
        stop_process "$MONITOR_PID"
        MONITOR_PID=""

        # Remove the temp files
        rm -f "$TEMP_PROGRESS_FILE" "$TEMP_PROGRESS_FILE.stalled" 2>/dev/null

        # Calculate upload duration
        local upload_end_time=$(date +%s)
        local upload_duration=$((upload_end_time - upload_start_time))
        local minutes=$((upload_duration / 60))
        local seconds=$((upload_duration % 60))
        
        # Check if the upload was successful
        if [ $upload_status -eq 0 ]; then
            echo -e "${GREEN}✓ Upload completed successfully!${NC}"
            echo -e "${DIM}Upload time: ${minutes} min ${seconds} sec${NC}"
            log "SUCCESS" "Upload completed successfully for ${device_name}"
            log "INFO" "Upload time: ${minutes} minutes ${seconds} seconds"
            upload_success=true
        else
            if [ $retry_count -lt $MAX_UPLOAD_RETRIES ]; then
                echo -e "${RED}✗ Upload attempt $retry_count failed.${NC}"
                log "ERROR" "Upload attempt $retry_count failed for ${device_name}"
            else
                echo -e "${RED}✗ All $MAX_UPLOAD_RETRIES upload attempts failed.${NC}"
                log "ERROR" "All $MAX_UPLOAD_RETRIES upload attempts failed for ${device_name}"
                mcumgr conn remove "$connection_id" > /dev/null 2>&1
                return 1
            fi
        fi
    done
    
    # Only proceed with confirmation and reset if upload was successful
    if [ "$upload_success" = true ]; then
        # Get the updated image list
        echo -ne "${CYAN}→${NC} Getting updated image list... "
        image_list_output=$(mcumgr -c "$connection_id" image list 2>&1)
        
        # Check if the command was successful
        if [ $? -ne 0 ]; then
            echo -e "${RED}Failed!${NC}"
            log "ERROR" "Failed to get updated image list from ${device_name}"
        else
            echo -e "${GREEN}Received!${NC}"
        fi
        
        # Extract the hash of the newly uploaded image
        new_hash=$(echo "$image_list_output" | awk '/image=0 slot=1/{found=1} found && /hash:/{print $2; exit}')
        
        if [ -z "$new_hash" ]; then
            echo -e "${RED}✗ Failed to get new image hash!${NC}"
            log "ERROR" "Failed to get new image hash for ${device_name}!"
            mcumgr conn remove "$connection_id" > /dev/null 2>&1
            return 1
        fi
        
        echo -e "${CYAN}ℹ${NC} New image hash: ${DIM}${new_hash}${NC}"
        log "INFO" "New image hash on ${device_name}: ${new_hash}"
        
        # Test or confirm based on the mode
        if [ "$test_mode" = true ]; then
            echo -ne "${CYAN}→${NC} Setting image for testing... "
            test_output=$(mcumgr -c "$connection_id" image test "$new_hash" 2>&1)
            
            if [ $? -ne 0 ]; then
                echo -e "${RED}Failed!${NC}"
                log "ERROR" "Failed to set test mode for ${device_name}: ${test_output}"
                mcumgr conn remove "$connection_id" > /dev/null 2>&1
                return 1
            fi
            
            echo -e "${GREEN}Done!${NC}"
            log "SUCCESS" "Image marked for testing on ${device_name}. It will run once after reset and revert if boot fails."
        else
            echo -ne "${CYAN}→${NC} Confirming image permanently... "
            confirm_output=$(mcumgr -c "$connection_id" image confirm "$new_hash" 2>&1)
            
            if [ $? -ne 0 ]; then
                echo -e "${RED}Failed!${NC}"
                log "ERROR" "Failed to confirm image for ${device_name}: ${confirm_output}"
                mcumgr conn remove "$connection_id" > /dev/null 2>&1
                return 1
            fi
            
            echo -e "${GREEN}Done!${NC}"
            log "SUCCESS" "Image confirmed permanently on ${device_name}."
        fi
        
        # Reset the device
        echo -ne "${CYAN}→${NC} Resetting device... "
        reset_output=$(mcumgr -c "$connection_id" reset 2>&1)
        
        if [ $? -ne 0 ]; then
            echo -e "${YELLOW}Warning: Reset command failed!${NC}"
            log "WARNING" "Failed to reset device ${device_name}: ${reset_output}"
            # Not returning error as the flash was successful
        else
            echo -e "${GREEN}Reset initiated!${NC}"
            log "SUCCESS" "Device ${device_name} reset initiated."
        fi
        
        # Clean up connection
        mcumgr conn remove "$connection_id" > /dev/null 2>&1
        
        echo -e "${GREEN}${BOLD}✓ Flash process completed successfully for ${device_name}${NC}"
        log "SUCCESS" "Flash process completed for ${device_name}"
        DEVICE_RESULT="success"
        return 0
    fi
    
    # If we reach here, all retries failed
    echo -e "${RED}${BOLD}✗ Flash process failed for ${device_name} after ${MAX_UPLOAD_RETRIES} attempts${NC}"
    log "ERROR" "Flash process failed for ${device_name} after ${MAX_UPLOAD_RETRIES} attempts"
    mcumgr conn remove "$connection_id" > /dev/null 2>&1
    return 1
}

# ----------------------
# Dependency Checking
# ----------------------

# Function: check_dependencies
# Description: Verifies all required tools are installed
function check_dependencies() {
    draw_box "Checking Dependencies" "${BLUE}"

    log "INFO" "Checking for required dependencies (${HACOAP_OS})..."

    local missing_deps=false
    local tool

    # mcumgr, plus standard tools every supported shell has (listed in case one is broken)
    for tool in mcumgr awk grep tr; do
        printf "${CYAN}→${NC} Checking for ${BOLD}%-20s${NC}... " "$tool"
        if command -v "$tool" &> /dev/null; then
            echo -e "${GREEN}Found!${NC}"
        else
            echo -e "${RED}Missing!${NC}"
            if [ "$tool" = "mcumgr" ]; then
                echo -e "   ${YELLOW}Install:${NC} ${DIM}$(install_hint mcumgr)${NC}"
            fi
            log "ERROR" "${tool} not found. Please install it before running this script."
            missing_deps=true
        fi
    done

    # Python runs hacoap_tools.py (discovery, serial ports, image hashes, stall detection)
    printf "${CYAN}→${NC} Checking for ${BOLD}%-20s${NC}... " "Python 3.7+"
    if find_python; then
        echo -e "${GREEN}Found!${NC} ${DIM}(${PYTHON[*]})${NC}"
    else
        echo -e "${RED}Missing!${NC}"
        echo -e "   ${YELLOW}Install:${NC} ${DIM}$(install_hint python)${NC}"
        log "ERROR" "Python 3.7 or newer not found. Please install it before running this script."
        missing_deps=true
    fi

    # Automatic device discovery is optional: device addresses can be typed instead
    if [ "$missing_deps" = false ] && [ "$NON_INTERACTIVE" != true ]; then
        printf "${CYAN}→${NC} Checking for ${BOLD}%-20s${NC}... " "device discovery"
        if "${PYTHON[@]}" -c "import zeroconf" &> /dev/null; then
            echo -e "${GREEN}Found!${NC} ${DIM}(zeroconf)${NC}"
        elif command -v avahi-browse &> /dev/null; then
            echo -e "${GREEN}Found!${NC} ${DIM}(avahi-browse)${NC}"
        else
            echo -e "${YELLOW}Missing.${NC} ${DIM}Over-the-air updates will ask for device addresses.${NC}"
            echo -e "   ${YELLOW}Install:${NC} ${DIM}$(install_hint discovery)${NC}"
            log "WARNING" "No device discovery available; device addresses will have to be typed."
        fi
    fi

    if $missing_deps; then
        echo ""
        echo -e "${BG_RED}${BOLD} Missing dependencies detected! Please install them and try again. ${NC}"
        log "ERROR" "Missing dependencies. Please install them and try again."
        exit 1
    fi

    echo ""
    echo -e "${BG_GREEN}${BOLD} All dependencies found! ${NC}"
    log "SUCCESS" "All required dependencies found."
}

# Function: locate_build_directory
# Description: Locates or prompts for the build directory
function locate_build_directory() {
    draw_box "Locating Build Directory" "${BLUE}"
    
    log "INFO" "Locating build directory..."
    
    # First check the default location
    printf "${CYAN}→${NC} Checking default build path... "
    if [ -d "${HACOAP_BUILD_DIR:-$HACOAP_DEFAULT_BUILD_DIR}" ]; then
        BUILD_DIR="${HACOAP_BUILD_DIR:-$HACOAP_DEFAULT_BUILD_DIR}"
        echo -e "${GREEN}Found!${NC}"
    else
        echo -e "${YELLOW}Not found.${NC}"
        log "WARNING" "Default build directory not found at: ${HACOAP_DEFAULT_BUILD_DIR}"
        log "INFO" "Current directory: $(pwd)"
        
        # Prompt for custom path with better visuals
        echo ""
        echo -e "${YELLOW}Please enter the full path to your build directory:${NC}"
        echo -e "${DIM}(Example: /home/user/thread-project/build)${NC}"
        printf "${BOLD}>${NC} "
        read -r build_path
        
        if [ -d "$build_path" ]; then
            BUILD_DIR="$build_path"
            echo -e "${GREEN}✓ Valid build directory!${NC}"
        else
            echo -e "${RED}✗ Directory not found: ${build_path}${NC}"
            log "ERROR" "Invalid build directory: $build_path"
            exit 1
        fi
    fi
    
    log "SUCCESS" "Using build directory: $BUILD_DIR"
    echo -e "${CYAN}ℹ${NC} Using build directory: ${BOLD}${BUILD_DIR}${NC}"
    
    # Verify firmware image exists with nice UI
    printf "${CYAN}→${NC} Checking for firmware image... "
    if [ ! -f "${BUILD_DIR}/zephyr/app_update.bin" ]; then
        echo -e "${RED}Not found!${NC}"
        echo -e "${RED}✗ Firmware image not found at:${NC} ${DIM}${BUILD_DIR}/zephyr/app_update.bin${NC}"
        log "ERROR" "Firmware image not found at: ${BUILD_DIR}/zephyr/app_update.bin"
        exit 1
    else
        echo -e "${GREEN}Found!${NC}"
        
        # Show size information
        local image_size
        if image_size=$(file_size "${BUILD_DIR}/zephyr/app_update.bin"); then
            echo -e "${CYAN}ℹ${NC} Firmware size: ${BOLD}$(format_kib "$image_size") KiB${NC}"
        fi
    fi
    
    log "SUCCESS" "Firmware image found: ${BUILD_DIR}/zephyr/app_update.bin"
}

# Function: prompt_for_mode
# Description: Prompts user to select update mode (test or confirm)
# Returns: Sets global TEST_MODE variable
function prompt_for_mode() {
    draw_box "Firmware Update Configuration" "${BLUE}"
    
    # Create a menu for mode selection
    echo -e "${YELLOW}Please select the update mode:${NC}"
    echo ""
    
    # Show the options with better visuals
    echo -e "  ${CYAN}1${NC}  ${BOLD}Test mode${NC}"
    echo -e "    ${DIM}• Image will be tested once and reverted if boot fails${NC}"
    echo -e "    ${DIM}• Safer option for initial deployments${NC}"
    echo ""
    echo -e "  ${CYAN}2${NC}  ${BOLD}Confirm immediately${NC}"
    echo -e "    ${DIM}• Image will be permanently installed${NC}"
    echo -e "    ${DIM}• ${RED}No automatic fallback if boot fails${NC}"
    echo ""
    
    printf "${YELLOW}? Select mode [1-2]:${NC} "
    read -r test_confirm_choice
    
    if [[ "$test_confirm_choice" == "1" ]]; then
        TEST_MODE=true
        echo -e "${GREEN}✓${NC} Selected: ${BOLD}Test mode${NC} ${DIM}(will revert if boot fails)${NC}"
        log "INFO" "Selected mode: Test mode (will revert if boot fails)"
    elif [[ "$test_confirm_choice" == "2" ]]; then
        TEST_MODE=false
        echo -e "${GREEN}✓${NC} Selected: ${BOLD}Confirm immediately${NC} ${RED}(permanent)${NC}"
        log "INFO" "Selected mode: Confirm immediately (permanent)"
    else
        echo -e "${RED}✗ Invalid selection: $test_confirm_choice${NC}"
        log "ERROR" "Invalid selection: $test_confirm_choice"
        exit 1
    fi
}

# Function: configure_settings
# Description: Prompts for and configures stall timeout and retry settings
function configure_settings() {
    echo ""
    echo -e "${YELLOW}Advanced Settings:${NC}"
    echo -e "${DIM}Press Enter to accept defaults${NC}"
    echo ""
    
    # Create better UI for stall timeout configuration
    echo -e "  ${CYAN}Stall Timeout${NC}  ${DIM}Time (seconds) before cancelling a stalled upload${NC}"
    echo -e "    ${DIM}• Default: ${UPLOAD_STALL_TIMEOUT} seconds${NC}"
    echo -e "    ${DIM}• Enter 0 to disable stall detection${NC}"
    
    printf "  ${YELLOW}?${NC} Enter timeout: "
    read -r timeout_setting
    
    # Validate input
    if [[ "$timeout_setting" =~ ^[0-9]+$ ]]; then
        if [ "$timeout_setting" -gt 0 ]; then
            UPLOAD_STALL_TIMEOUT=$timeout_setting
            echo -e "  ${GREEN}✓${NC} Stall timeout set to ${BOLD}${UPLOAD_STALL_TIMEOUT}${NC} seconds"
            log "INFO" "Upload stall timeout set to ${UPLOAD_STALL_TIMEOUT} seconds"
        else
            echo -e "  ${YELLOW}→${NC} Stall detection disabled"
            log "INFO" "Stall detection disabled"
            UPLOAD_STALL_TIMEOUT=0
        fi
    else
        echo -e "  ${GREEN}✓${NC} Using default stall timeout: ${BOLD}${UPLOAD_STALL_TIMEOUT}${NC} seconds"
        log "INFO" "Using default stall timeout of ${UPLOAD_STALL_TIMEOUT} seconds"
    fi
    
    echo ""
    
    # Create better UI for retry configuration
    echo -e "  ${CYAN}Upload Retries${NC}  ${DIM}Number of times to retry a failed upload${NC}"
    echo -e "    ${DIM}• Default: ${MAX_UPLOAD_RETRIES} attempts${NC}"
    
    printf "  ${YELLOW}?${NC} Enter max retries: "
    read -r retry_setting
    
    # Validate input
    if [[ "$retry_setting" =~ ^[0-9]+$ ]]; then
        if [ "$retry_setting" -ge 0 ]; then
            MAX_UPLOAD_RETRIES=$retry_setting
            echo -e "  ${GREEN}✓${NC} Maximum upload retries set to ${BOLD}${MAX_UPLOAD_RETRIES}${NC}"
            log "INFO" "Maximum upload retries set to ${MAX_UPLOAD_RETRIES}"
        fi
    else
        echo -e "  ${GREEN}✓${NC} Using default retry setting: ${BOLD}${MAX_UPLOAD_RETRIES}${NC} attempts"
        log "INFO" "Using default retry setting of ${MAX_UPLOAD_RETRIES} attempts"
    fi
    
    echo ""
    
    # Progress check interval setting (for smoother UI)
    echo -e "  ${CYAN}UI Refresh Rate${NC}  ${DIM}How often to update the progress display (seconds)${NC}"
    echo -e "    ${DIM}• Default: ${PROGRESS_CHECK_INTERVAL} second${NC}"
    
    printf "  ${YELLOW}?${NC} Enter refresh interval: "
    read -r refresh_setting
    
    # Validate input
    if [[ "$refresh_setting" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
        if awk -v value="$refresh_setting" 'BEGIN { exit !(value > 0) }'; then
            PROGRESS_CHECK_INTERVAL=$refresh_setting
            echo -e "  ${GREEN}✓${NC} UI refresh interval set to ${BOLD}${PROGRESS_CHECK_INTERVAL}${NC} seconds"
            log "INFO" "Progress check interval set to ${PROGRESS_CHECK_INTERVAL} seconds"
        fi
    else
        echo -e "  ${GREEN}✓${NC} Using default refresh interval: ${BOLD}${PROGRESS_CHECK_INTERVAL}${NC} second"
        log "INFO" "Using default progress check interval of ${PROGRESS_CHECK_INTERVAL} seconds"
    fi
}

# Function: display_summary
# Description: Shows summary of the update operation
function display_summary() {
    echo ""
    draw_box "Update Summary" "${BLUE}"
    
    echo -e "${CYAN}ℹ${NC} Total devices: $1"
    
    if [ $SUCCESSFUL_UPDATES -gt 0 ]; then
        echo -e "${GREEN}✓${NC} Successful updates: ${GREEN}${SUCCESSFUL_UPDATES}${NC}"
    else
        echo -e "${DIM}✓ Successful updates: ${SUCCESSFUL_UPDATES}${NC}"
    fi
    
    if [ $SKIPPED_UPDATES -gt 0 ]; then
        echo -e "${YELLOW}→${NC} Skipped updates (already had image): ${YELLOW}${SKIPPED_UPDATES}${NC}"
    else
        echo -e "${DIM}→ Skipped updates: ${SKIPPED_UPDATES}${NC}"
    fi
    
    if [ $FAILED_UPDATES -gt 0 ]; then
        echo -e "${RED}✗${NC} Failed updates: ${RED}${FAILED_UPDATES}${NC}"
    else
        echo -e "${DIM}✗ Failed updates: ${FAILED_UPDATES}${NC}"
    fi
    
    echo ""
    
    # Display a final message based on results
    if [ $FAILED_UPDATES -eq 0 ] && [ $SUCCESSFUL_UPDATES -gt 0 ]; then
        echo -e "${BG_GREEN}${BOLD} All updates completed successfully! ${NC}"
    elif [ $FAILED_UPDATES -gt 0 ] && [ $SUCCESSFUL_UPDATES -gt 0 ]; then
        echo -e "${BG_YELLOW}${BOLD} Updates completed with some failures. ${NC}"
    elif [ $FAILED_UPDATES -gt 0 ] && [ $SUCCESSFUL_UPDATES -eq 0 ] && [ $SKIPPED_UPDATES -gt 0 ]; then
        echo -e "${BG_YELLOW}${BOLD} No new updates were performed. ${NC}"
    elif [ $FAILED_UPDATES -gt 0 ] && [ $SUCCESSFUL_UPDATES -eq 0 ] && [ $SKIPPED_UPDATES -eq 0 ]; then
        echo -e "${BG_RED}${BOLD} All updates failed! ${NC}"
    fi
    
    log "INFO" "==== Update Summary ===="
    log "INFO" "Total devices: $1"
    log "SUCCESS" "Successful updates: $SUCCESSFUL_UPDATES"
    log "INFO" "Skipped updates (already had image): $SKIPPED_UPDATES"
    if [ $FAILED_UPDATES -gt 0 ]; then
        log "ERROR" "Failed updates: $FAILED_UPDATES"
    else
        log "INFO" "Failed updates: $FAILED_UPDATES"
    fi
    
    log "INFO" "Bulk update process completed."
}

# ----------------------
# Non-interactive Configuration
# ----------------------

# Function: configure_non_interactive
# Description: Reads the HACOAP_* environment variables (see the top of this file)
# in place of the interactive prompts, and validates them
function configure_non_interactive() {
    draw_box "Non-interactive Configuration" "${BLUE}"

    log "INFO" "Running in non-interactive mode"

    CONNECTION_TYPE="${HACOAP_CONNECTION:-UDP}"
    if [ "$CONNECTION_TYPE" != "UDP" ] && [ "$CONNECTION_TYPE" != "USB" ]; then
        log "ERROR" "Invalid HACOAP_CONNECTION: ${CONNECTION_TYPE} (expected UDP or USB)"
        exit 1
    fi

    DEVICE_NAMES=()
    DEVICE_ADDRESSES=()
    local entry name address
    for entry in ${HACOAP_DEVICES:-}; do
        if [[ "$entry" == *=* ]]; then
            name="${entry%%=*}"
            address="${entry#*=}"
        else
            name="$entry"
            address="$entry"
        fi

        if ! [[ "$name" =~ ^[A-Za-z0-9._:/-]+$ ]]; then
            log "ERROR" "Invalid device name: ${name}"
            exit 1
        fi
        if [ "$CONNECTION_TYPE" = "UDP" ] && ! is_valid_ipv6 "$address"; then
            log "ERROR" "Invalid IPv6 address for ${name}: ${address}"
            exit 1
        fi
        if [ "$CONNECTION_TYPE" = "USB" ] && ! is_valid_serial_port "$address"; then
            log "ERROR" "Invalid serial port for ${name}: ${address}"
            exit 1
        fi

        DEVICE_NAMES+=("$name")
        DEVICE_ADDRESSES+=("$address")
    done

    if [ ${#DEVICE_ADDRESSES[@]} -eq 0 ]; then
        log "ERROR" "No devices given (set HACOAP_DEVICES)"
        exit 1
    fi
    SELECTED_INDICES=("${!DEVICE_ADDRESSES[@]}")
    log "INFO" "Selected ${#SELECTED_INDICES[@]} device(s) over ${CONNECTION_TYPE}"

    BUILD_DIR="${HACOAP_BUILD_DIR:-$HACOAP_DEFAULT_BUILD_DIR}"
    if [ ! -f "${BUILD_DIR}/zephyr/app_update.bin" ]; then
        log "ERROR" "Firmware image not found at: ${BUILD_DIR}/zephyr/app_update.bin"
        exit 1
    fi
    log "SUCCESS" "Firmware image found: ${BUILD_DIR}/zephyr/app_update.bin"

    case "${HACOAP_UPDATE_MODE:-test}" in
        test)
            TEST_MODE=true
            log "INFO" "Selected mode: Test mode (will revert if boot fails)"
            ;;
        confirm)
            TEST_MODE=false
            log "INFO" "Selected mode: Confirm immediately (permanent)"
            ;;
        *)
            log "ERROR" "Invalid HACOAP_UPDATE_MODE: ${HACOAP_UPDATE_MODE} (expected test or confirm)"
            exit 1
            ;;
    esac

    if [ -n "${HACOAP_STALL_TIMEOUT:-}" ]; then
        if ! [[ "$HACOAP_STALL_TIMEOUT" =~ ^[0-9]+$ ]]; then
            log "ERROR" "Invalid HACOAP_STALL_TIMEOUT: ${HACOAP_STALL_TIMEOUT}"
            exit 1
        fi
        UPLOAD_STALL_TIMEOUT=$HACOAP_STALL_TIMEOUT
    fi
    log "INFO" "Upload stall timeout: ${UPLOAD_STALL_TIMEOUT} seconds (0 = disabled)"

    if [ -n "${HACOAP_MAX_RETRIES:-}" ]; then
        if ! [[ "$HACOAP_MAX_RETRIES" =~ ^[0-9]+$ ]]; then
            log "ERROR" "Invalid HACOAP_MAX_RETRIES: ${HACOAP_MAX_RETRIES}"
            exit 1
        fi
        MAX_UPLOAD_RETRIES=$HACOAP_MAX_RETRIES
    fi
    log "INFO" "Maximum upload attempts: ${MAX_UPLOAD_RETRIES}"
}

# ----------------------
# Main Function
# ----------------------

# Main function to orchestrate the update process
function main() {
    print_banner
    
    # Set up cleanup trap
    trap cleanup EXIT
    
    # Enable pipefail to catch errors in piped commands
    set -o pipefail
    
    # Verify all dependencies are installed
    check_dependencies
    
    if [ "$NON_INTERACTIVE" = true ]; then
        # All settings come from HACOAP_* environment variables
        configure_non_interactive
    else
        # Prompt for connection type selection
        select_connection_type
        
        # Setup connection based on type
        if [ "$CONNECTION_TYPE" = "UDP" ]; then
            # Discover available devices (or ask for their addresses)
            discover_devices
            
            # Allow selection of which devices to update
            select_devices
        else  # USB connection
            # Find and select serial port
            list_serial_ports
            select_serial_port
            
            # Setup a single device for USB connection
            setup_usb_device
        fi
        
        # Find the build directory
        locate_build_directory
        
        # Prompt for operation mode
        prompt_for_mode
        
        # Configure stall timeout and retry settings
        configure_settings
    fi
    
    total_devices=${#SELECTED_INDICES[@]}
    
    # Confirm before proceeding (the web updater asks for confirmation itself)
    if [ "$NON_INTERACTIVE" != true ]; then
        echo ""
        echo -e "${YELLOW}? You are about to update firmware on ${total_devices} devices. Continue? (y/n):${NC} "
        read -r confirm
        
        if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
            log "INFO" "Operation cancelled by user."
            exit 0
        fi
    fi
    
    # Process each selected device
    for i in "${SELECTED_INDICES[@]}"; do
        update_device "${DEVICE_NAMES[$i]}" "${DEVICE_ADDRESSES[$i]}" "$TEST_MODE" "$CONNECTION_TYPE"
        
        # Skipped devices are already counted in update_device
        case "$DEVICE_RESULT" in
            success) SUCCESSFUL_UPDATES=$((SUCCESSFUL_UPDATES + 1)) ;;
            skipped) ;;
            *) FAILED_UPDATES=$((FAILED_UPDATES + 1)) ;;
        esac
        log "INFO" "RESULT ${DEVICE_NAMES[$i]} ${DEVICE_RESULT}"
        
        # Add a small delay between devices to avoid network congestion
        sleep 2
    done
    
    # Display summary
    display_summary "$total_devices"
    
    # Clean up temp files
    cleanup
}

# Run the main function
main