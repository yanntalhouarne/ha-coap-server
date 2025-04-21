#!/bin/bash

# ========================================================================
#                    HA-CoAP Bulk Device Manager
#          A tool for efficient firmware updates to Thread devices
# ========================================================================

# ----------------------
# Terminal color definitions
# ----------------------
declare -r RED='\033[0;31m'
declare -r GREEN='\033[0;32m'
declare -r YELLOW='\033[0;33m'
declare -r BLUE='\033[0;34m'
declare -r PURPLE='\033[0;35m'
declare -r CYAN='\033[0;36m'
declare -r BOLD='\033[1m'
declare -r DIM='\033[2m'
declare -r NC='\033[0m' # No Color
declare -r BG_BLUE='\033[44m'
declare -r BG_GREEN='\033[42m'
declare -r BG_RED='\033[41m'

# ----------------------
# Configuration variables
# ----------------------
declare -r TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
declare -r LOG_FILE="flash_logs_${TIMESTAMP}.log"
declare -r TEMP_PROGRESS_FILE="/tmp/mcumgr_progress_$TIMESTAMP.tmp"

# Default settings (can be modified by user input)
UPLOAD_STALL_TIMEOUT=300  # 5 minutes in seconds
PROGRESS_CHECK_INTERVAL=1  # Check progress every second for smoother UI
MAX_UPLOAD_RETRIES=3  # Maximum number of upload retry attempts

# Global variables for tracking devices and statistics
declare -a DEVICE_NAMES
declare -a DEVICE_ADDRESSES
declare -a SELECTED_INDICES
SUCCESSFUL_UPDATES=0
FAILED_UPDATES=0
SKIPPED_UPDATES=0
BUILD_DIR=""
TEST_MODE=true

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
# Description: Logs messages to both console and log file with appropriate formatting
# Parameters:
#   $1 - Log level (INFO, SUCCESS, ERROR, WARNING)
#   $2 - Message to log
function log() {
    local level="$1"
    local message="$2"
    local color="$NC"
    local prefix=""
    local icon=""
    
    case "$level" in
        "INFO")    color="$CYAN";    prefix="[INFO]";    icon="ℹ " ;;
        "SUCCESS") color="$GREEN";   prefix="[SUCCESS]"; icon="✓ " ;;
        "ERROR")   color="$RED";     prefix="[ERROR]";   icon="✗ " ;;
        "WARNING") color="$YELLOW";  prefix="[WARNING]"; icon="! " ;;
        "DEBUG")   color="$DIM";     prefix="[DEBUG]";   icon="  " ;;
    esac
    
    # Print to console with color, only if not DEBUG level
    if [ "$level" != "DEBUG" ]; then
        echo -e "${color}${icon}${prefix}${NC} ${message}"
    fi
    
    # Log to file without color codes
    echo "$(date '+%Y-%m-%d %H:%M:%S') ${prefix} ${message}" >> "$LOG_FILE"
}

# Function: print_banner
# Description: Displays a stylized banner at the start of the script
function print_banner() {
    clear
    
    echo ""
    echo -e "${BLUE}+----------------------------------------------------+${NC}"
    echo -e "${BLUE}|                                                    |${NC}"
    echo -e "${BLUE}|${BOLD}${CYAN}            HA-CoAP Bulk Updater v1.5.0             ${BLUE}|${NC}"
    echo -e "${BLUE}|${CYAN}             Multi-Device Flashing Tool             ${BLUE}|${NC}"
    echo -e "${BLUE}|                                                    |${NC}"
    echo -e "${BLUE}+----------------------------------------------------+${NC}"
    
    echo -e "\n${DIM}Log file: ${LOG_FILE}${NC}\n"
    
    # Also log the banner to the log file
    echo "+---------------------------------------------------+" >> "$LOG_FILE"
    echo "|              HA-CoAP Bulk Updater                 |" >> "$LOG_FILE"
    echo "|         Multi-Device Flashing Tool v1.5.0         |" >> "$LOG_FILE"
    echo "+---------------------------------------------------+" >> "$LOG_FILE"
    echo "Log started at: $(date '+%Y-%m-%d %H:%M:%S')" >> "$LOG_FILE"
    echo "" >> "$LOG_FILE"
}

# Function: cleanup
# Description: Cleans up temporary files and processes
function cleanup() {
    # Clean up all temporary files
    rm -f "$TEMP_PROGRESS_FILE" "$TEMP_PROGRESS_FILE.stalled" "$TEMP_PROGRESS_FILE.log" "$TEMP_PROGRESS_FILE.py" "/tmp/mcumgr_pipe_$" 2>/dev/null
    
    # Kill any remaining mcumgr processes that might be hanging
    local mcumgr_pids=$(pgrep -f "mcumgr.*upload")
    if [ -n "$mcumgr_pids" ]; then
        log "WARNING" "Cleaning up lingering mcumgr processes during exit..."
        for pid in $mcumgr_pids; do
            kill -9 $pid 2>/dev/null
        done
    fi
    
    # Kill any cat processes we might have started
    local cat_pids=$(pgrep -f "cat.*mcumgr_pipe")
    if [ -n "$cat_pids" ]; then
        for pid in $cat_pids; do
            kill -9 $pid 2>/dev/null
        done
    fi
}

# ----------------------
# Device Discovery & Management
# ----------------------

# Function: discover_devices
# Description: Uses avahi-browse to find HA-CoAP devices on the network
function discover_devices() {
    # Draw nice header
    draw_box "Scanning for Thread Devices"
    
    log "INFO" "Scanning for ha-coap devices..."
    
    echo -e "${CYAN}Scanning network for HA-CoAP devices...${NC}"
    
    # Run avahi-browse with a timeout to ensure it doesn't run indefinitely
    output=$(timeout 3s avahi-browse -r _ot._udp 2>/dev/null)
    
    echo -e "${GREEN}✓${NC} Scan complete!"
    
    # Initialize arrays to store device names and addresses
    declare -a devices=()
    declare -a addresses=()
    
    # Use an associative array to track which devices we've already seen
    declare -A seen_devices
    
    # Extract device information from the output
    while IFS= read -r line; do
        if [[ "$line" == *"= "* && "$line" == *"ha-coap"* && "$line" == *"IPv6"* ]]; then
            # Extract the device name from this line
            device_name=$(echo "$line" | awk '{print $4}')
            
            # Skip if we've already seen this device
            [[ -n "${seen_devices[$device_name]}" ]] && continue
            
            # Mark this device as seen
            seen_devices[$device_name]=1
            
            # Read the next 2 lines to get to the address line
            read -r hostname_line
            read -r address_line
            
            # Extract the IPv6 address
            ipv6_address=$(echo "$address_line" | grep -o '\[fd[^]]*\]' | tr -d '[]')
            
            # Add to our arrays if we got an address
            if [[ -n "$ipv6_address" ]]; then
                devices+=("$device_name")
                addresses+=("$ipv6_address")
            fi
        fi
    done < <(echo "$output")
    
    # Check if we found any devices
    if [ ${#devices[@]} -eq 0 ]; then
        echo ""
        echo -e "${BG_RED}${BOLD} No ha-coap devices found ${NC}"
        echo ""
        log "ERROR" "No ha-coap devices found."
        log "INFO" "Troubleshooting tips:"
        log "INFO" "- Make sure your devices are powered on and connected"
        log "INFO" "- Verify Thread network is properly set up"
        log "INFO" "- Increase the timeout value in the script (currently 3s)"
        exit 1
    fi
    
    # Display the list of devices in a nicer format
    echo ""
    echo -e "${BOLD}Found ${GREEN}${#devices[@]}${NC}${BOLD} HA-CoAP devices:${NC}"
    echo -e "${DIM}---------------------------------------------${NC}"
    
    for i in "${!devices[@]}"; do
        printf "${GREEN}%2d${NC} │ ${BOLD}%-30s${NC} │ ${DIM}%s${NC}\n" $((i+1)) "${devices[$i]}" "${addresses[$i]}"
    done
    
    echo -e "${DIM}---------------------------------------------${NC}"
    echo ""
    
    # Return the arrays through global variables
    DEVICE_NAMES=("${devices[@]}")
    DEVICE_ADDRESSES=("${addresses[@]}")
    
    log "SUCCESS" "Found ${#devices[@]} ha-coap device(s)"
}

# Function: select_devices
# Description: Allow user to select which devices to update
function select_devices() {
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
        printf "${CYAN}%2d${NC} │ ${BOLD}%-30s${NC} │ ${DIM}%s${NC}\n" $((i+1)) "${DEVICE_NAMES[$i]}" "${DEVICE_ADDRESSES[$i]}"
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
        printf "${GREEN}%2d${NC} │ ${BOLD}%-30s${NC} │ ${DIM}%s${NC}\n" $((i+1)) "${DEVICE_NAMES[$i]}" "${DEVICE_ADDRESSES[$i]}"
    done
    
    echo -e "${DIM}---------------------------------------------${NC}"
    echo ""
    
    log "INFO" "Selected ${#SELECTED_INDICES[@]} devices for update"
}

# Function: extract_kib_value
# Description: Extracts KiB values from progress output lines
# Parameters:
#   $1 - Progress line to extract from
function extract_kib_value() {
    local progress_line="$1"
    
    # Debug - log the exact input
    echo "$(date '+%Y-%m-%d %H:%M:%S') [DEBUG] Raw progress line: '$progress_line'" >> "$LOG_FILE"
    
    # Try to match the pattern "X.XX KiB / Y.YY KiB"
    if [[ "$progress_line" =~ ([0-9]+\.?[0-9]*)\ +KiB\ +/\ +([0-9]+\.?[0-9]*)\ +KiB ]]; then
        # Get both values
        local current="${BASH_REMATCH[1]}"
        local total="${BASH_REMATCH[2]}"
        
        echo "$(date '+%Y-%m-%d %H:%M:%S') [DEBUG] Matched pattern KiB/KiB, current: $current, total: $total" >> "$LOG_FILE"
        
        # Calculate percentage (making sure to handle floating point with bc)
        if [ -n "$total" ] && [ "$(echo "$total > 0" | bc -l)" -eq 1 ]; then
            local percent=$(echo "scale=2; ($current / $total) * 100" | bc -l)
            echo "${percent%.*}" # Remove decimal part
        else
            echo "0"
        fi
    # Try to match the pattern "X.XX KiB"
    elif [[ "$progress_line" =~ ([0-9]+\.?[0-9]*)\ +KiB ]]; then
        # Since we don't have a total, just estimate based on typical sizes
        local current="${BASH_REMATCH[1]}"
        echo "$(date '+%Y-%m-%d %H:%M:%S') [DEBUG] Matched pattern KiB only, current: $current" >> "$LOG_FILE"
        
        # Assuming typical image size of 200 KiB, adjust as needed
        local typical_size=200
        local percent=$(echo "scale=2; ($current / $typical_size) * 100" | bc -l)
        echo "${percent%.*}" # Remove decimal part
    # Try to match the pattern "X.XX KB / Y.YY KB" 
    elif [[ "$progress_line" =~ ([0-9]+\.?[0-9]*)\ +(KB|B)\ +/\ +([0-9]+\.?[0-9]*)\ +(KB|KiB) ]]; then
        # Get values
        local current="${BASH_REMATCH[1]}"
        local current_unit="${BASH_REMATCH[2]}"
        local total="${BASH_REMATCH[3]}"
        local total_unit="${BASH_REMATCH[4]}"
        
        echo "$(date '+%Y-%m-%d %H:%M:%S') [DEBUG] Matched pattern mixed units, current: $current $current_unit, total: $total $total_unit" >> "$LOG_FILE"
        
        # Convert B to KiB if needed
        if [ "$current_unit" = "B" ]; then
            current=$(echo "scale=2; $current / 1024" | bc -l)
        fi
        
        # Calculate percentage
        if [ -n "$total" ] && [ "$(echo "$total > 0" | bc -l)" -eq 1 ]; then
            local percent=$(echo "scale=2; ($current / $total) * 100" | bc -l)
            echo "${percent%.*}" # Remove decimal part
        else
            echo "0"
        fi
    else
        echo "$(date '+%Y-%m-%d %H:%M:%S') [DEBUG] No pattern matched in: '$progress_line'" >> "$LOG_FILE"
        echo "0"
    fi
}

# ----------------------
# Python Stall Monitoring
# ----------------------

# Function: stall_monitor_script
# Description: Creates and runs a Python script to monitor upload progress and detect stalls
# Parameters are passed through to the Python script
function stall_monitor_script() {
    # Create a temporary Python script to monitor for stalls
    cat > "${TEMP_PROGRESS_FILE}.py" << 'EOL'
#!/usr/bin/env python3
import sys
import os
import time
import re
import signal
import subprocess

# Get script arguments
if len(sys.argv) < 5:
    print("Usage: {} file_to_monitor timeout device_name pid_to_kill".format(sys.argv[0]))
    sys.exit(1)

file_to_monitor = sys.argv[1]
timeout = int(sys.argv[2])
device_name = sys.argv[3]
pid_to_kill = int(sys.argv[4])
check_interval = 1  # seconds - check more frequently for short timeouts

# Set up logging
log_file = file_to_monitor + ".log"
def log(message):
    timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
    with open(log_file, "a") as f:
        f.write(f"{timestamp} - {message}\n")

# Function to extract KiB value from progress line - get FIRST value, not second
def extract_kib_value(line):
    # Check for "Done" marker which indicates upload is complete
    if "Done" in line:
        log("Found 'Done' marker - upload completed successfully")
        return "done"
        
    # Try pattern: "X.XX KiB / Y.YY KiB" or "X B / Y.YY KiB"
    match = re.search(r'(\d+\.?\d*)\s*(B|KiB)\s*/\s*\d+\.?\d*\s*KiB', line)
    if match:
        value = match.group(1)
        unit = match.group(2)
        log(f"Matched progress pattern: value={value}, unit={unit} from '{line}'")
        
        # Convert B to KiB if needed
        if unit == "B" and float(value) == 0:
            log("Upload just started at 0 bytes, not considering as stall")
            return "start"
        return value
    
    # No match
    log(f"No match in: '{line}'")
    return "0"

log(f"Starting stall monitor: file={file_to_monitor}, timeout={timeout}s, pid={pid_to_kill}")

# Initialize tracking variables
last_value = None
stall_counter = 0
consecutive_same_readings = 0

# Get all matching processes just to be sure
def find_process_children(pid):
    try:
        output = subprocess.check_output(["pgrep", "-P", str(pid)]).decode().strip()
        return [int(p) for p in output.split()]
    except subprocess.CalledProcessError:
        return []

# Kill a process tree
def kill_process_tree(pid):
    log(f"Killing process tree starting at PID {pid}")
    # Get child processes
    children = find_process_children(pid)
    for child in children:
        kill_process_tree(child)
    
    # Kill the parent
    try:
        os.kill(pid, signal.SIGTERM)
        time.sleep(0.5)
        try:
            os.kill(pid, 0)  # Check if process exists
            os.kill(pid, signal.SIGKILL)  # Force kill if still running
            log(f"Force killed PID {pid}")
        except OSError:
            log(f"Process {pid} terminated gracefully")
    except OSError as e:
        log(f"Error killing PID {pid}: {e}")

while True:
    time.sleep(check_interval)
    
    # Check if file exists
    if not os.path.exists(file_to_monitor):
        log("File no longer exists, exiting")
        break
    
    # Read the file
    try:
        with open(file_to_monitor, "r") as f:
            lines = f.readlines()
            if not lines:
                log("File is empty, waiting for data")
                continue
            
            # Check the last line with KiB in it
            kib_lines = [l for l in lines if "KiB" in l or " B / " in l]
            if not kib_lines:
                log("No progress lines found, waiting")
                continue
                
            last_line = kib_lines[-1].strip()
            current_value = extract_kib_value(last_line)
            
            # Skip empty or initial values
            if current_value == "0" or current_value == "start":
                log("Skipping initial value")
                continue
            
            # First reading
            if last_value is None:
                last_value = current_value
                log(f"First reading: {last_value}")
                continue
            
            # Check for completed upload
            if current_value == "done":
                log("Upload process completed successfully")
                break
                
            # Check for stall
            if current_value == last_value:
                consecutive_same_readings += 1
                stall_counter += check_interval
                log(f"Same value detected ({consecutive_same_readings} times): {current_value}, stall counter = {stall_counter}s")
                
                # Check for 100% completion
                if "100" in last_line or "100.00%" in last_line or "100%" in last_line:
                    log("Found 100% completion marker - waiting briefly for 'Done' message")
                    # Give a short grace period for the "Done" message to appear
                    if consecutive_same_readings >= 5:
                        log("Upload appears to be complete at 100% - assuming successful completion")
                        break
                
                # Stall timeout reached - be very explicit about what's happening
                elif stall_counter >= timeout:
                    log(f"STALL DETECTED! Value {current_value} unchanged for {stall_counter} seconds")
                    log(f"Timeout of {timeout} seconds reached")
                    
                    # Print to stderr for visibility
                    print(f"\033[31mSTALL DETECTED! Value {current_value} unchanged for {stall_counter} seconds\033[0m", file=sys.stderr)
                    
                    # Create a marker file
                    with open(file_to_monitor + ".stalled", "w") as sf:
                        sf.write(f"STALLED at {current_value} KiB for {stall_counter} seconds\n")
                    
                    # Kill the process tree
                    kill_process_tree(pid_to_kill)
                    
                    # Final log before exiting
                    log("Monitor exiting after stall detection")
                    sys.exit(0)  # Exit with success code so the script continues
            else:
                # Progress detected - log the change
                log(f"Progress detected: {last_value} -> {current_value}")
                stall_counter = 0
                consecutive_same_readings = 0
                last_value = current_value
    
    except Exception as e:
        log(f"Error: {str(e)}")
        continue
EOL

    # Make the Python script executable
    chmod +x "${TEMP_PROGRESS_FILE}.py"
    
    # Run the Python script in the background
    python3 "${TEMP_PROGRESS_FILE}.py" "$@" &
    echo $! # Return the PID
}

# ----------------------
# Firmware Update Functions
# ----------------------

# Function: update_device
# Description: Updates firmware on a single device with retry logic
# Parameters:
#   $1 - Device name
#   $2 - Device IPv6 address
#   $3 - Test mode flag (true/false)
function update_device() {
    local device_name="$1"
    local device_address="$2"
    local test_mode="$3"
    local retry_count=0
    local upload_success=false
    
    # Draw a nice box for this device
    echo ""
    draw_box "Updating Device: ${BOLD}${device_name}${NC}" "${BLUE}"
    
    log "INFO" "===== Processing device: ${device_name} (${device_address}) ====="
    
    # Add the UDP connection
    echo -ne "${CYAN}➤${NC} Connecting via UDP to [${device_address}]:1337... "
    mcumgr conn add udp type="udp" connstring="[${device_address}]:1337" > /dev/null 2>&1
    
    if [ $? -ne 0 ]; then
        echo -e "${RED}Failed!${NC}"
        log "ERROR" "Failed to establish UDP connection to ${device_name}"
        return 1
    fi
    
    echo -e "${GREEN}Connected!${NC}"
    log "SUCCESS" "UDP connection established to ${device_name}"
    
    # Get the current image list
    echo -ne "${CYAN}➤${NC} Retrieving current image list... "
    image_list_output=$(mcumgr -c "udp" image list 2>&1)
    
    # Check if the command was successful
    if [ $? -ne 0 ]; then
        echo -e "${RED}Failed!${NC}"
        log "ERROR" "Failed to retrieve image list from ${device_name}: ${image_list_output}"
        mcumgr conn remove "udp" > /dev/null 2>&1
        return 1
    fi
    
    echo -e "${GREEN}Received!${NC}"
    
    # Save image list to the log
    echo "Image list from ${device_name}:" >> "$LOG_FILE"
    echo "$image_list_output" >> "$LOG_FILE"
    echo "" >> "$LOG_FILE"
    
    # Extract the current hash in slot 0
    current_hash=$(echo "$image_list_output" | awk '/image=0 slot=0/{found=1} found && /hash:/{print $2; exit}')
    
    if [ -z "$current_hash" ]; then
        echo -e "${YELLOW}⚠️ Could not determine current image hash.${NC} ${DIM}Proceeding anyway.${NC}"
        log "WARNING" "Could not determine current image hash for ${device_name}. Proceeding anyway."
    else
        echo -e "${CYAN}ℹ${NC} Current image hash: ${DIM}${current_hash}${NC}"
        log "INFO" "Current image hash on ${device_name}: ${current_hash}"
        
        # Get the hash of the image we're about to upload
        echo -ne "${CYAN}➤${NC} Getting hash of new image... "
        new_image_hash=$(./get-image-hash.sh 2>/dev/null)
        
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
                mcumgr conn remove "udp" > /dev/null 2>&1
                # Increment skipped updates count
                SKIPPED_UPDATES=$((SKIPPED_UPDATES + 1))
                return 0
            fi
        fi
    fi
    
    # Show image information
    local image_size=$(stat -c%s "${BUILD_DIR}/zephyr/app_update.bin" 2>/dev/null || echo "Unknown")
    if [ "$image_size" != "Unknown" ]; then
        image_size_kb=$(echo "scale=2; $image_size / 1024" | bc)
        echo -e "${CYAN}ℹ${NC} Firmware size: ${image_size_kb} KiB"
    fi
    
    # Implement retry logic
    while [ $retry_count -lt $MAX_UPLOAD_RETRIES ] && [ "$upload_success" = false ]; do
        # Increment retry count
        retry_count=$((retry_count + 1))
        
        if [ $retry_count -gt 1 ]; then
            echo -e "${YELLOW}⚠️ Retry attempt $retry_count of $MAX_UPLOAD_RETRIES...${NC}"
            log "INFO" "Retry attempt $retry_count of $MAX_UPLOAD_RETRIES for ${device_name}..."
            # Add a short delay before retrying
            sleep 3
        fi
        
        # Clear the progress file
        > "$TEMP_PROGRESS_FILE"
        
        # Upload the new image with stall detection
        echo -e "${CYAN}⬆${NC} ${BOLD}Uploading firmware image...${NC}"
        log "INFO" "Uploading firmware image to ${device_name}..."
        if [ $UPLOAD_STALL_TIMEOUT -gt 0 ]; then
            echo -e "${DIM}Upload will be terminated if stalled for ${UPLOAD_STALL_TIMEOUT} seconds${NC}"
            log "INFO" "Upload will be terminated if stalled for ${UPLOAD_STALL_TIMEOUT} seconds"
        fi
        
        # Record start time for timing the upload
        local upload_start_time=$(date +%s)
        
        # Clear the progress file and stall indicator
        > "$TEMP_PROGRESS_FILE"
        rm -f "$TEMP_PROGRESS_FILE.stalled" "$TEMP_PROGRESS_FILE.log" "$TEMP_PROGRESS_FILE.py" 2>/dev/null
        
        # Create a named pipe for progress monitoring
        local pipe_file="/tmp/mcumgr_pipe_$$"
        mkfifo "$pipe_file" 2>/dev/null
        
        # Start the upload in background
        mcumgr -c "udp" image upload "${BUILD_DIR}/zephyr/app_update.bin" > "$pipe_file" 2>&1 &
        upload_pid=$!
        
        # Start cat in background to read from the pipe and capture output
        cat "$pipe_file" | tee "$TEMP_PROGRESS_FILE" &
        cat_pid=$!
        
        # Start Python monitor in background only if stall detection is enabled
        if [ $UPLOAD_STALL_TIMEOUT -gt 0 ]; then
            monitor_pid=$(stall_monitor_script "$TEMP_PROGRESS_FILE" $UPLOAD_STALL_TIMEOUT "$device_name" $upload_pid)
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
            if ! kill -0 $upload_pid 2>/dev/null; then
                # Process completed
                wait $upload_pid 2>/dev/null
                upload_status=$?
                upload_done=true
                
                # Show 100% progress for successful completion
                if [ $upload_status -eq 0 ]; then
                    echo -ne "\r "
                    draw_progress_bar 100 $progress_bar_width
                    echo ""
                    log "INFO" "Upload process completed successfully"
                else
                    log "INFO" "Upload process completed with error status $upload_status"
                fi
            else
                # Check for stall marker
                if [ -f "$TEMP_PROGRESS_FILE.stalled" ]; then
                    log "ERROR" "Upload stalled and was terminated by monitor"
                    kill -9 $upload_pid 2>/dev/null
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
                        kill -9 $upload_pid 2>/dev/null
                        upload_status=1
                        upload_done=true
                        
                        # Show error in the progress bar
                        echo -e "\r ${RED}[TIMEOUT]${NC} Upload exceeded maximum time limit               "
                    else
                        # Get the last line with progress information if available
                        if [ -f "$TEMP_PROGRESS_FILE" ]; then
                            local progress_line=$(grep -a "KiB" "$TEMP_PROGRESS_FILE" | tail -n 1)
                            if [ -n "$progress_line" ]; then
                                # Extract percentage
                                local percent=$(extract_kib_value "$progress_line")
                                
                                # Only update if the percentage has changed
                                if [ "$percent" != "$last_percent" ]; then
                                    last_percent=$percent
                                    # Update the progress bar
                                    echo -ne "\r "
                                    draw_progress_bar $percent $progress_bar_width
                                fi
                            fi
                        fi
                        
                        # Sleep briefly before checking again
                        sleep $PROGRESS_CHECK_INTERVAL
                    fi
                fi
            fi
        done
        
        # Allow cat process to finish reading the pipe
        sleep 1
        kill $cat_pid 2>/dev/null
        rm -f "$pipe_file" 2>/dev/null
        
        # Check if the process was killed due to a stall
        if [ -f "$TEMP_PROGRESS_FILE.stalled" ]; then
            upload_status=1
            echo -e "${RED}❌ Upload failed due to stall timeout${NC}"
            log "ERROR" "Upload failed due to stall timeout"
            
            # Show the monitor log to help diagnose issues
            if [ -f "$TEMP_PROGRESS_FILE.log" ]; then
                log "DEBUG" "Python stall monitor log content:"
                cat "$TEMP_PROGRESS_FILE.log" >> "$LOG_FILE"
            fi
        fi
        
        # Kill the monitor if it's still running
        if [ $UPLOAD_STALL_TIMEOUT -gt 0 ] && kill -0 $monitor_pid 2>/dev/null; then
            kill $monitor_pid 2>/dev/null
        fi
        
        # Make sure we don't leave any zombie processes
        # Find all processes that might be related to our upload
        local zombie_pids=$(pgrep -f "mcumgr.*upload" | grep -v "$$")
        if [ -n "$zombie_pids" ]; then
            log "WARNING" "Found lingering mcumgr processes, cleaning up..."
            for pid in $zombie_pids; do
                kill -9 $pid 2>/dev/null
            done
        fi
        
        # Remove the temp files
        rm -f "$TEMP_PROGRESS_FILE" "$TEMP_PROGRESS_FILE.stalled" "$TEMP_PROGRESS_FILE.py" "$TEMP_PROGRESS_FILE.log" 2>/dev/null
        
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
                echo -e "${RED}❌ Upload attempt $retry_count failed.${NC}"
                log "ERROR" "Upload attempt $retry_count failed for ${device_name}"
            else
                echo -e "${RED}❌ All $MAX_UPLOAD_RETRIES upload attempts failed.${NC}"
                log "ERROR" "All $MAX_UPLOAD_RETRIES upload attempts failed for ${device_name}"
                mcumgr conn remove "udp" > /dev/null 2>&1
                return 1
            fi
        fi
    done
    
    # Only proceed with confirmation and reset if upload was successful
    if [ "$upload_success" = true ]; then
        # Get the updated image list
        echo -ne "${CYAN}➤${NC} Getting updated image list... "
        image_list_output=$(mcumgr -c "udp" image list 2>&1)
        
        # Check if the command was successful
        if [ $? -ne 0 ]; then
            echo -e "${RED}Failed!${NC}"
            log "ERROR" "Failed to get updated image list from ${device_name}"
        else
            echo -e "${GREEN}Received!${NC}"
        fi
        
        # Save updated image list to the log
        echo "Updated image list from ${device_name}:" >> "$LOG_FILE"
        echo "$image_list_output" >> "$LOG_FILE"
        echo "" >> "$LOG_FILE"
        
        # Extract the hash of the newly uploaded image
        new_hash=$(echo "$image_list_output" | awk '/image=0 slot=1/{found=1} found && /hash:/{print $2; exit}')
        
        if [ -z "$new_hash" ]; then
            echo -e "${RED}❌ Failed to get new image hash!${NC}"
            log "ERROR" "Failed to get new image hash for ${device_name}!"
            mcumgr conn remove "udp" > /dev/null 2>&1
            return 1
        fi
        
        echo -e "${CYAN}ℹ${NC} New image hash: ${DIM}${new_hash}${NC}"
        log "INFO" "New image hash on ${device_name}: ${new_hash}"
        
        # Test or confirm based on the mode
        if [ "$test_mode" = true ]; then
            echo -ne "${CYAN}➤${NC} Setting image for testing... "
            test_output=$(mcumgr -c "udp" image test "$new_hash" 2>&1)
            
            if [ $? -ne 0 ]; then
                echo -e "${RED}Failed!${NC}"
                log "ERROR" "Failed to set test mode for ${device_name}: ${test_output}"
                mcumgr conn remove "udp" > /dev/null 2>&1
                return 1
            fi
            
            echo -e "${GREEN}Done!${NC}"
            log "SUCCESS" "Image marked for testing on ${device_name}. It will run once after reset and revert if boot fails."
        else
            echo -ne "${CYAN}➤${NC} Confirming image permanently... "
            confirm_output=$(mcumgr -c "udp" image confirm "$new_hash" 2>&1)
            
            if [ $? -ne 0 ]; then
                echo -e "${RED}Failed!${NC}"
                log "ERROR" "Failed to confirm image for ${device_name}: ${confirm_output}"
                mcumgr conn remove "udp" > /dev/null 2>&1
                return 1
            fi
            
            echo -e "${GREEN}Done!${NC}"
            log "SUCCESS" "Image confirmed permanently on ${device_name}."
        fi
        
        # Reset the device
        echo -ne "${CYAN}➤${NC} Resetting device... "
        reset_output=$(mcumgr -c "udp" reset 2>&1)
        
        if [ $? -ne 0 ]; then
            echo -e "${YELLOW}Warning: Reset command failed!${NC}"
            log "WARNING" "Failed to reset device ${device_name}: ${reset_output}"
            # Not returning error as the flash was successful
        else
            echo -e "${GREEN}Reset initiated!${NC}"
            log "SUCCESS" "Device ${device_name} reset initiated."
        fi
        
        # Clean up connection
        mcumgr conn remove "udp" > /dev/null 2>&1
        
        echo -e "${GREEN}${BOLD}✅ Flash process completed successfully for ${device_name}${NC}"
        log "SUCCESS" "Flash process completed for ${device_name}"
        return 0
    fi
    
    # If we reach here, all retries failed
    echo -e "${RED}${BOLD}❌ Flash process failed for ${device_name} after ${MAX_UPLOAD_RETRIES} attempts${NC}"
    log "ERROR" "Flash process failed for ${device_name} after ${MAX_UPLOAD_RETRIES} attempts"
    mcumgr conn remove "udp" > /dev/null 2>&1
    return 1
}

# ----------------------
# Dependency Checking
# ----------------------

# Function: check_dependencies
# Description: Verifies all required tools are installed
function check_dependencies() {
    draw_box "Checking Dependencies" "${BLUE}"
    
    log "INFO" "Checking for required dependencies..."
    
    local missing_deps=false
    local deps=("mcumgr" "avahi-browse" "tee" "grep" "python3")
    local dep_descriptions=(
        "MCU Manager CLI tool"
        "Avahi service browser"
        "Text output utilities"
        "Text pattern matching"
        "Python 3 interpreter"
    )
    local install_instructions=(
        "https://docs.zephyrproject.org/latest/services/device_mgmt/mcumgr.html"
        "sudo apt install avahi-utils" 
        "sudo apt install coreutils"
        "sudo apt install grep"
        "sudo apt install python3"
    )
    
    for i in "${!deps[@]}"; do
        printf "${CYAN}➤${NC} Checking for ${BOLD}%-20s${NC}... " "${deps[$i]}"
        
        if command -v "${deps[$i]}" &> /dev/null; then
            echo -e "${GREEN}Found!${NC}"
        else
            echo -e "${RED}Missing!${NC}"
            echo -e "   ${YELLOW}Install:${NC} ${DIM}${install_instructions[$i]}${NC}"
            log "ERROR" "${deps[$i]} not found. Please install it before running this script."
            log "INFO" "${install_instructions[$i]}"
            missing_deps=true
        fi
    done
    
    # Recommend timeout command which helps prevent hanging
    printf "${CYAN}➤${NC} Checking for ${BOLD}%-20s${NC}... " "timeout"
    if command -v timeout &> /dev/null; then
        echo -e "${GREEN}Found!${NC}"
    else
        echo -e "${YELLOW}Missing!${NC} ${DIM}(recommended but not required)${NC}"
        echo -e "   ${YELLOW}Install:${NC} ${DIM}sudo apt install coreutils${NC}"
        log "WARNING" "timeout command not found. Installing it is recommended for better stall handling."
        log "INFO" "Installation: sudo apt install coreutils"
    fi
    
    # Check for the get-image-hash.sh script
    printf "${CYAN}➤${NC} Checking for ${BOLD}%-20s${NC}... " "get-image-hash.sh"
    if [ ! -f "./get-image-hash.sh" ]; then
        echo -e "${YELLOW}Missing!${NC} ${DIM}(hash comparison will not work)${NC}"
        log "WARNING" "get-image-hash.sh not found in the current directory."
        log "INFO" "Hash comparison feature will not work properly."
    elif [ ! -x "./get-image-hash.sh" ]; then
        echo -e "${YELLOW}Found but not executable.${NC} ${DIM}Making it executable...${NC}"
        chmod +x ./get-image-hash.sh
        log "INFO" "Making get-image-hash.sh executable..."
    else
        echo -e "${GREEN}Found!${NC}"
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
    printf "${CYAN}➤${NC} Checking default build path... "
    if [ -d "../application/build" ]; then
        BUILD_DIR="../application/build"
        echo -e "${GREEN}Found!${NC}"
    else
        echo -e "${YELLOW}Not found.${NC}"
        log "WARNING" "Default build directory not found at: ../application/build"
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
            echo -e "${RED}❌ Directory not found: ${build_path}${NC}"
            log "ERROR" "Invalid build directory: $build_path"
            exit 1
        fi
    fi
    
    log "SUCCESS" "Using build directory: $BUILD_DIR"
    echo -e "${CYAN}ℹ${NC} Using build directory: ${BOLD}${BUILD_DIR}${NC}"
    
    # Verify firmware image exists with nice UI
    printf "${CYAN}➤${NC} Checking for firmware image... "
    if [ ! -f "${BUILD_DIR}/zephyr/app_update.bin" ]; then
        echo -e "${RED}Not found!${NC}"
        echo -e "${RED}❌ Firmware image not found at:${NC} ${DIM}${BUILD_DIR}/zephyr/app_update.bin${NC}"
        log "ERROR" "Firmware image not found at: ${BUILD_DIR}/zephyr/app_update.bin"
        exit 1
    else
        echo -e "${GREEN}Found!${NC}"
        
        # Show size information
        local image_size=$(stat -c%s "${BUILD_DIR}/zephyr/app_update.bin" 2>/dev/null || echo "Unknown")
        if [ "$image_size" != "Unknown" ]; then
            image_size_kb=$(echo "scale=2; $image_size / 1024" | bc)
            echo -e "${CYAN}ℹ${NC} Firmware size: ${BOLD}${image_size_kb} KiB${NC}"
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
    echo -e "  ${CYAN}1${NC} │ ${BOLD}Test mode${NC}"
    echo -e "    ${DIM}└─ Image will be tested once and reverted if boot fails${NC}"
    echo -e "    ${DIM}└─ Safer option for initial deployments${NC}"
    echo ""
    echo -e "  ${CYAN}2${NC} │ ${BOLD}Confirm immediately${NC}"
    echo -e "    ${DIM}└─ Image will be permanently installed${NC}"
    echo -e "    ${DIM}└─ ${RED}No automatic fallback if boot fails${NC}"
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
        echo -e "${RED}❌ Invalid selection: $test_confirm_choice${NC}"
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
    echo -e "  ${CYAN}Stall Timeout${NC} │ ${DIM}Time (seconds) before cancelling a stalled upload${NC}"
    echo -e "    ${DIM}└─ Default: ${UPLOAD_STALL_TIMEOUT} seconds${NC}"
    echo -e "    ${DIM}└─ Enter 0 to disable stall detection${NC}"
    
    printf "  ${YELLOW}?${NC} Enter timeout: "
    read -r timeout_setting
    
    # Validate input
    if [[ "$timeout_setting" =~ ^[0-9]+$ ]]; then
        if [ "$timeout_setting" -gt 0 ]; then
            UPLOAD_STALL_TIMEOUT=$timeout_setting
            echo -e "  ${GREEN}✓${NC} Stall timeout set to ${BOLD}${UPLOAD_STALL_TIMEOUT}${NC} seconds"
            log "INFO" "Upload stall timeout set to ${UPLOAD_STALL_TIMEOUT} seconds"
        else
            echo -e "  ${YELLOW}⚠${NC} Stall detection disabled"
            log "INFO" "Stall detection disabled"
            UPLOAD_STALL_TIMEOUT=0
        fi
    else
        echo -e "  ${GREEN}✓${NC} Using default stall timeout: ${BOLD}${UPLOAD_STALL_TIMEOUT}${NC} seconds"
        log "INFO" "Using default stall timeout of ${UPLOAD_STALL_TIMEOUT} seconds"
    fi
    
    echo ""
    
    # Create better UI for retry configuration
    echo -e "  ${CYAN}Upload Retries${NC} │ ${DIM}Number of times to retry a failed upload${NC}"
    echo -e "    ${DIM}└─ Default: ${MAX_UPLOAD_RETRIES} attempts${NC}"
    
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
    echo -e "  ${CYAN}UI Refresh Rate${NC} │ ${DIM}How often to update the progress display (seconds)${NC}"
    echo -e "    ${DIM}└─ Default: ${PROGRESS_CHECK_INTERVAL} second${NC}"
    
    printf "  ${YELLOW}?${NC} Enter refresh interval: "
    read -r refresh_setting
    
    # Validate input
    if [[ "$refresh_setting" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
        if (( $(echo "$refresh_setting > 0" | bc -l) )); then
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
        echo -e "${YELLOW}⚠${NC} Skipped updates (already had image): ${YELLOW}${SKIPPED_UPDATES}${NC}"
    else
        echo -e "${DIM}⚠ Skipped updates: ${SKIPPED_UPDATES}${NC}"
    fi
    
    if [ $FAILED_UPDATES -gt 0 ]; then
        echo -e "${RED}❌${NC} Failed updates: ${RED}${FAILED_UPDATES}${NC}"
    else
        echo -e "${DIM}❌ Failed updates: ${FAILED_UPDATES}${NC}"
    fi
    
    echo -e "${DIM}📝 Log file: ${LOG_FILE}${NC}"
    echo ""
    
    # Display a final message based on results
    if [ $FAILED_UPDATES -eq 0 ] && [ $SUCCESSFUL_UPDATES -gt 0 ]; then
        echo -e "${BG_GREEN}${BOLD} All updates completed successfully! ${NC}"
    elif [ $FAILED_UPDATES -gt 0 ] && [ $SUCCESSFUL_UPDATES -gt 0 ]; then
        echo -e "${BG_YELLOW}${BOLD} Updates completed with some failures. ${NC}"
        echo -e "${DIM}Check the log file for details: ${LOG_FILE}${NC}"
    elif [ $FAILED_UPDATES -gt 0 ] && [ $SUCCESSFUL_UPDATES -eq 0 ] && [ $SKIPPED_UPDATES -gt 0 ]; then
        echo -e "${BG_YELLOW}${BOLD} No new updates were performed. ${NC}"
    elif [ $FAILED_UPDATES -gt 0 ] && [ $SUCCESSFUL_UPDATES -eq 0 ] && [ $SKIPPED_UPDATES -eq 0 ]; then
        echo -e "${BG_RED}${BOLD} All updates failed! ${NC}"
        echo -e "${DIM}Check the log file for details: ${LOG_FILE}${NC}"
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
    log "INFO" "Log file: $LOG_FILE"
    
    log "INFO" "Bulk update process completed."
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
    
    # Find the build directory
    locate_build_directory
    
    # Discover available devices
    discover_devices
    
    # Allow selection of which devices to update
    select_devices
    
    # Prompt for operation mode
    prompt_for_mode
    
    # Configure stall timeout and retry settings
    configure_settings
    
    # Confirm before proceeding
    total_devices=${#SELECTED_INDICES[@]}
    echo ""
    echo -e "${YELLOW}? You are about to update firmware on ${total_devices} devices. Continue? (y/n):${NC} "
    read -r confirm
    
    if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
        log "INFO" "Operation cancelled by user."
        exit 0
    fi
    
    # Process each selected device
    for i in "${SELECTED_INDICES[@]}"; do
        update_device "${DEVICE_NAMES[$i]}" "${DEVICE_ADDRESSES[$i]}" "$TEST_MODE"
        result=$?
        
        if [ $result -eq 0 ]; then
            if [ "$current_hash" == "$new_image_hash" ]; then
                # Already counted in the update_device function
                :
            else
                SUCCESSFUL_UPDATES=$((SUCCESSFUL_UPDATES + 1))
            fi
        else
            FAILED_UPDATES=$((FAILED_UPDATES + 1))
        fi
        
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