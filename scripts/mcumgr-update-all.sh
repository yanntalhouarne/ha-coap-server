#!/bin/bash

# ===================================================
# HA-CoAP Bulk Device Manager
# A tool to flash firmware to multiple Thread devices
# ===================================================

# Terminal colors and formatting
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Configuration
UPLOAD_STALL_TIMEOUT=300  # 5 minutes in seconds
PROGRESS_CHECK_INTERVAL=10  # Check progress every 10 seconds
MAX_UPLOAD_RETRIES=3  # Maximum number of upload retry attempts

# Timestamp for log files
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
LOG_FILE="flash_logs_${TIMESTAMP}.log"
TEMP_PROGRESS_FILE="/tmp/mcumgr_progress_$TIMESTAMP.tmp"

# Function to log messages to both console and log file
function log() {
    local level="$1"
    local message="$2"
    local color="$NC"
    local prefix=""
    
    case "$level" in
        "INFO")
            color="${CYAN}"
            prefix="[INFO]"
            ;;
        "SUCCESS")
            color="${GREEN}"
            prefix="[✓]"
            ;;
        "ERROR")
            color="${RED}"
            prefix="[✗]"
            ;;
        "WARNING")
            color="${YELLOW}"
            prefix="[!]"
            ;;
    esac
    
    # Print to console with color
    echo -e "${color}${prefix} ${message}${NC}"
    
    # Log to file without color codes
    echo "$(date '+%Y-%m-%d %H:%M:%S') ${prefix} ${message}" >> "$LOG_FILE"
}

# Print fancy banner
function print_banner() {
    clear
    echo -e "${BLUE}┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓${NC}"
    echo -e "${BLUE}┃                                                ┃${NC}"
    echo -e "${BLUE}┃  ${BOLD}${CYAN}       HA-CoAP Bulk Device Manager          ${NC}${BLUE}  ┃${NC}"
    echo -e "${BLUE}┃  ${CYAN}    Flash Firmware to Multiple Devices      ${BLUE}  ┃${NC}"
    echo -e "${BLUE}┃                                                ┃${NC}"
    echo -e "${BLUE}┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛${NC}"
    echo ""
    
    # Log the banner to the log file (plain text version)
    echo "+---------------------------------------------------+" >> "$LOG_FILE"
    echo "|              HA-CoAP Bulk Updater                 |" >> "$LOG_FILE"
    echo "|         Multi-Device Flashing Tool                |" >> "$LOG_FILE"
    echo "+---------------------------------------------------+" >> "$LOG_FILE"
    echo "Log started at: $(date '+%Y-%m-%d %H:%M:%S')" >> "$LOG_FILE"
    echo "" >> "$LOG_FILE"
}

# Function to display a spinner animation during operations
spinner=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
function show_spinner() {
    local pid=$1
    local message="$2"
    local i=0
    
    # Hide cursor
    tput civis
    
    while kill -0 $pid 2>/dev/null; do
        echo -ne "\r${CYAN}${spinner[$i]} ${message}${NC}"
        i=$(( (i+1) % ${#spinner[@]} ))
        sleep 0.1
    done
    
    # Clear spinner and restore cursor
    echo -ne "\r\033[K"
    tput cnorm
}

# Function to show progress bar
function show_progress_bar() {
    local percent=$1
    local width=50
    
    # Ensure percent is a valid integer
    if ! [[ "$percent" =~ ^[0-9]+$ ]]; then
        percent=0
    fi
    
    # Cap at 100%
    if [ $percent -gt 100 ]; then
        percent=100
    fi
    
    local num_filled=$(( $percent * $width / 100 ))
    local num_empty=$(( $width - $num_filled ))
    
    # Create the bar with filled and empty parts
    local bar=""
    for ((i=0; i<$num_filled; i++)); do
        bar="${bar}█"
    done
    
    for ((i=0; i<$num_empty; i++)); do
        bar="${bar}░"
    done
    
    # Display the progress bar
    echo -ne "\r[${bar}] ${percent}%"
}

# Function to discover ha-coap devices and their IPv6 addresses
function discover_devices() {
    log "INFO" "Scanning for ha-coap devices..."
    
    # Start spinner in background during scan
    (
        i=0
        while true; do
            echo -ne "\r${CYAN}${spinner[$i]} Scanning network for devices...${NC}"
            i=$(( (i+1) % ${#spinner[@]} ))
            sleep 0.1
        done
    ) &
    SPINNER_PID=$!
    
    # Hide cursor during spinner
    tput civis
    
    # Run avahi-browse with a timeout to ensure it doesn't run indefinitely
    output=$(timeout 3s avahi-browse -r _ot._udp 2>/dev/null)
    
    # Kill spinner and restore cursor
    kill $SPINNER_PID &>/dev/null
    wait $SPINNER_PID 2>/dev/null
    echo -ne "\r\033[K"
    tput cnorm
    
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
            if [[ -n "${seen_devices[$device_name]}" ]]; then
                continue
            fi
            
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
        log "ERROR" "No ha-coap devices found."
        echo -e "${YELLOW}┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓${NC}"
        echo -e "${YELLOW}┃  ${BOLD}Troubleshooting Tips:${NC}                         ${YELLOW}┃${NC}"
        echo -e "${YELLOW}┃  ✓ Make sure your devices are powered on           ┃${NC}"
        echo -e "${YELLOW}┃  ✓ Verify Thread network is properly set up        ┃${NC}"
        echo -e "${YELLOW}┃  ✓ Try increasing scan timeout in the script       ┃${NC}"
        echo -e "${YELLOW}┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛${NC}"
        exit 1
    fi
    
    # Display the list of devices in a nice table
    log "SUCCESS" "Found ${#devices[@]} ha-coap device(s)"
    echo -e "${CYAN}┏━━━━━━━┳━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┳━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓${NC}"
    echo -e "${CYAN}┃${BOLD} ID    ┃ Device Name                   ┃ IPv6 Address                          ${NC}${CYAN}┃${NC}"
    echo -e "${CYAN}┣━━━━━━━╋━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╋━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫${NC}"
    
    for i in "${!devices[@]}"; do
        printf "${CYAN}┃${NC} %-5s ${CYAN}┃${NC} %-29s ${CYAN}┃${NC} %-19s\n" "$((i+1))" "${devices[$i]}" "${addresses[$i]}"
    done
    
    echo -e "${CYAN}┗━━━━━━━┻━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┻━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛${NC}"
    
    # Return the arrays through global variables
    DEVICE_NAMES=("${devices[@]}")
    DEVICE_ADDRESSES=("${addresses[@]}")
}

# Function to extract KiB value from progress output
function extract_kib_value() {
    local progress_line="$1"
    
    # Debug - log the exact input
    echo "$(date '+%Y-%m-%d %H:%M:%S') [DEBUG] Raw progress line: '$progress_line'" >> "$LOG_FILE"
    
    # Try to match the pattern "X.XX KiB / Y.YY KiB"
    if [[ "$progress_line" =~ ([0-9]+\.?[0-9]*)\ +KiB\ +/\ +([0-9]+\.?[0-9]*)\ +KiB ]]; then
        # Return just the first number (current progress)
        echo "$(date '+%Y-%m-%d %H:%M:%S') [DEBUG] Matched pattern 1, extracted: ${BASH_REMATCH[1]}" >> "$LOG_FILE"
        echo "${BASH_REMATCH[1]}"
    # Try to match just "X.XX KiB" (alternative format)
    elif [[ "$progress_line" =~ ([0-9]+\.?[0-9]*)\ +KiB ]]; then
        echo "$(date '+%Y-%m-%d %H:%M:%S') [DEBUG] Matched pattern 2, extracted: ${BASH_REMATCH[1]}" >> "$LOG_FILE"
        echo "${BASH_REMATCH[1]}"
    # Try to match values without decimal point
    elif [[ "$progress_line" =~ ([0-9]+)\ +KiB ]]; then
        echo "$(date '+%Y-%m-%d %H:%M:%S') [DEBUG] Matched pattern 3, extracted: ${BASH_REMATCH[1]}" >> "$LOG_FILE"
        echo "${BASH_REMATCH[1]}"
    # If no match found
    else
        echo "$(date '+%Y-%m-%d %H:%M:%S') [DEBUG] No pattern matched, returning 0" >> "$LOG_FILE"
        echo "0"
    fi
}

# Function to monitor stall using Python (more reliable parsing)
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
            
            # Check for stall
            if current_value == last_value:
                consecutive_same_readings += 1
                stall_counter += check_interval
                log(f"Same value detected ({consecutive_same_readings} times): {current_value}, stall counter = {stall_counter}s")
                
                # Stall timeout reached - be very explicit about what's happening
                if stall_counter >= timeout:
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
    
    # Run the Python script
    python3 "${TEMP_PROGRESS_FILE}.py" "$@"
}

# Function to update a single device with visual progress indicators
function update_device() {
    local device_name="$1"
    local device_address="$2"
    local test_mode="$3"
    local retry_count=0
    local upload_success=false
    
    echo -e "${BLUE}┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓${NC}"
    echo -e "${BLUE}┃  ${BOLD}Device:${NC} ${CYAN}${device_name}${NC}"
    echo -e "${BLUE}┃  ${BOLD}Address:${NC} ${CYAN}${device_address}${NC}"
    echo -e "${BLUE}┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛${NC}"
    
    log "INFO" "Processing device: ${device_name} (${device_address})"
    
    # Add the UDP connection with spinner
    echo -ne "${CYAN}⏳ Connecting...${NC}"
    
    mcumgr conn add udp type="udp" connstring="[${device_address}]:1337" > /dev/null 2>&1
    
    if [ $? -ne 0 ]; then
        echo -ne "\r\033[K"
        log "ERROR" "Failed to establish UDP connection to ${device_name}"
        return 1
    fi
    
    echo -ne "\r\033[K"
    log "SUCCESS" "UDP connection established to ${device_name}"
    
    # Get the current image list with spinner
    echo -ne "${CYAN}⏳ Reading current firmware...${NC}"
    
    image_list_output=$(mcumgr -c "udp" image list 2>&1)
    
    # Check if the command was successful
    if [ $? -ne 0 ]; then
        echo -ne "\r\033[K"
        log "ERROR" "Failed to retrieve image list from ${device_name}: ${image_list_output}"
        mcumgr conn remove "udp" > /dev/null 2>&1
        return 1
    fi
    
    echo -ne "\r\033[K"
    log "INFO" "Retrieved current image list"
    
    # Save image list to the log
    echo "Image list from ${device_name}:" >> "$LOG_FILE"
    echo "$image_list_output" >> "$LOG_FILE"
    echo "" >> "$LOG_FILE"
    
    # Extract the current hash in slot 0
    current_hash=$(echo "$image_list_output" | awk '/image=0 slot=0/{found=1} found && /hash:/{print $2; exit}')
    
    if [ -z "$current_hash" ]; then
        log "WARNING" "Could not determine current image hash for ${device_name}. Proceeding anyway."
    else
        log "INFO" "Current image hash on ${device_name}: ${current_hash}"
        
        # Get the hash of the image we're about to upload
        echo -ne "${CYAN}⏳ Checking image hash...${NC}"
        new_image_hash=$(./get-image-hash.sh)
        echo -ne "\r\033[K"
        
        if [ -z "$new_image_hash" ]; then
            log "WARNING" "Could not determine new image hash. Proceeding anyway."
        else
            log "INFO" "New image hash: ${new_image_hash}"
            
            # Compare the hashes
            if [ "$current_hash" == "$new_image_hash" ]; then
                log "INFO" "Device ${device_name} already has the current image installed."
                echo -e "${GREEN}✓ Device is already up to date!${NC}"
                # Clean up connection
                mcumgr conn remove "udp" > /dev/null 2>&1
                # Increment skipped updates count
                SKIPPED_UPDATES=$((SKIPPED_UPDATES + 1))
                return 0
            fi
        fi
    fi
    
    # Implement retry logic
    while [ $retry_count -lt $MAX_UPLOAD_RETRIES ] && [ "$upload_success" = false ]; do
        # Increment retry count
        retry_count=$((retry_count + 1))
        
        if [ $retry_count -gt 1 ]; then
            log "INFO" "Retry attempt $retry_count of $MAX_UPLOAD_RETRIES for ${device_name}..."
            echo -e "${YELLOW}↻ Retrying upload (attempt $retry_count of $MAX_UPLOAD_RETRIES)${NC}"
            # Add a short delay before retrying
            sleep 3
        fi
        
        # Clear the progress file
        > "$TEMP_PROGRESS_FILE"
        
        # Upload the new image with stall detection and progress bar
        log "INFO" "Uploading firmware image to ${device_name}..."
        echo -e "${CYAN}⏳ Uploading firmware...${NC}"
        
        if [ $UPLOAD_STALL_TIMEOUT -gt 0 ]; then
            log "INFO" "Upload will be terminated if stalled for ${UPLOAD_STALL_TIMEOUT} seconds"
            echo -e "${CYAN}ℹ️  Stall detection: ${UPLOAD_STALL_TIMEOUT}s timeout${NC}"
        fi
        
        # Record start time for timing the upload
        local upload_start_time=$(date +%s)
        
        # Clear the progress file and stall indicator
        > "$TEMP_PROGRESS_FILE"
        rm -f "$TEMP_PROGRESS_FILE.stalled" 2>/dev/null
        rm -f "$TEMP_PROGRESS_FILE.log" 2>/dev/null
        rm -f "$TEMP_PROGRESS_FILE.py" 2>/dev/null
        
        # Create a named pipe for progress monitoring
        local pipe_file="/tmp/mcumgr_pipe_$"
        mkfifo "$pipe_file" 2>/dev/null
        
        # Start the upload in background using a process group
        set -m  # Enable job control
        mcumgr -c "udp" image upload "${BUILD_DIR}/zephyr/app_update.bin" > "$pipe_file" 2>&1 &
        upload_pid=$!
        set +m  # Disable job control
        
        # Start cat in background to read from the pipe and capture output
        cat "$pipe_file" | tee "$TEMP_PROGRESS_FILE" > /dev/null &
        cat_pid=$!
        
        # Start Python monitor in background only if stall detection is enabled
        if [ $UPLOAD_STALL_TIMEOUT -gt 0 ]; then
            stall_monitor_script "$TEMP_PROGRESS_FILE" $UPLOAD_STALL_TIMEOUT "$device_name" $upload_pid &
            monitor_pid=$!
        fi
        
        # Calculate a reasonable timeout (stall timeout plus margin)
        wait_timeout=$((UPLOAD_STALL_TIMEOUT + 7200))  # 2 hour upload timeout per device
        
        # Wait for the upload to finish with timeout and show progress
        upload_status=0
        upload_done=false
        
        log "INFO" "Waiting for upload to complete (timeout: ${wait_timeout}s)..."
        
        # Hide cursor during progress display
        tput civis
        
        # For progress display
        last_progress="0"
        total_size="0"
        
        # Start a timeout counter
        start_time=$(date +%s)
        while ! $upload_done; do
                            # Update progress display
            if [ -f "$TEMP_PROGRESS_FILE" ]; then
                # Get the latest progress line with KiB
                progress_line=$(grep -o "[0-9]\+\.*[0-9]* KiB / [0-9]\+\.*[0-9]* KiB" "$TEMP_PROGRESS_FILE" 2>/dev/null | tail -n 1)
                
                if [ -n "$progress_line" ]; then
                    # Extract values more safely using awk
                    current_kb=$(echo "$progress_line" | awk '{print $1}')
                    total_kb=$(echo "$progress_line" | awk '{print $4}')
                    
                    if [ -n "$current_kb" ] && [ -n "$total_kb" ]; then
                        # Convert floating point to integer by removing the decimal point
                        # This avoids the "invalid arithmetic operator" error with decimal numbers
                        current_kb_int=$(echo "$current_kb" | sed 's/\..*//')
                        total_kb_int=$(echo "$total_kb" | sed 's/\..*//')
                        
                        if [ -n "$current_kb_int" ] && [ -n "$total_kb_int" ] && [ "$total_kb_int" -gt 0 ]; then
                            percent=$((current_kb_int * 100 / total_kb_int))
                            show_progress_bar $percent
                        fi
                        
                        # Save for rate calculation
                        if [ "$last_progress" = "0" ]; then
                            last_progress=$current_kb
                            progress_time=$(date +%s)
                        else
                            current_time=$(date +%s)
                            time_diff=$((current_time - progress_time))
                            
                            if [ $time_diff -ge 2 ]; then
                                # Calculate rate in KiB/s - convert to integers first
                                # This fixes the "invalid arithmetic operator" error with decimal numbers
                                current_kb_int=$(echo "$current_kb" | sed 's/\..*//')
                                last_progress_int=$(echo "$last_progress" | sed 's/\..*//')
                                
                                if [ -n "$current_kb_int" ] && [ -n "$last_progress_int" ] && [ "$current_kb_int" -gt "$last_progress_int" ]; then
                                    rate=$(( (current_kb_int - last_progress_int) / time_diff ))
                                    
                                    # Update the display with rate
                                    if [ $rate -gt 0 ]; then
                                        echo -ne " ($rate KiB/s)"
                                    fi
                                fi
                                
                                # Reset for next calculation
                                last_progress=$current_kb
                                progress_time=$current_time
                            fi
                        fi
                    fi
                fi
            fi
            
            # Check if process is still running
            if ! kill -0 $upload_pid 2>/dev/null; then
                # Process completed
                wait $upload_pid 2>/dev/null
                upload_status=$?
                upload_done=true
                log "INFO" "Upload process completed with status $upload_status"
            else
                # Check for stall marker
                if [ -f "$TEMP_PROGRESS_FILE.stalled" ]; then
                    log "ERROR" "Upload stalled and was terminated by monitor"
                    kill -9 $upload_pid 2>/dev/null
                    upload_status=1
                    upload_done=true
                else
                    # Check for timeout
                    current_time=$(date +%s)
                    elapsed=$((current_time - start_time))
                    
                    if [ $elapsed -gt $wait_timeout ]; then
                        log "WARNING" "Upload timeout after ${elapsed}s, forcing termination"
                        kill -9 $upload_pid 2>/dev/null
                        upload_status=1
                        upload_done=true
                    else
                        # Sleep briefly before checking again
                        sleep 0.5
                    fi
                fi
            fi
        done
        
        # Restore cursor
        echo -e "\n"
        tput cnorm
        
        # Allow cat process to finish reading the pipe
        sleep 1
        kill $cat_pid 2>/dev/null
        rm -f "$pipe_file" 2>/dev/null
        
        # Check if the process was killed due to a stall
        if [ -f "$TEMP_PROGRESS_FILE.stalled" ]; then
            upload_status=1
            log "ERROR" "Upload failed due to stall timeout"
            echo -e "${RED}✗ Upload stalled and was terminated${NC}"
            
            # Show the monitor log to diagnose issues
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
        rm -f "$TEMP_PROGRESS_FILE" 2>/dev/null
        rm -f "$TEMP_PROGRESS_FILE.stalled" 2>/dev/null
        rm -f "$TEMP_PROGRESS_FILE.py" 2>/dev/null
        rm -f "$TEMP_PROGRESS_FILE.log" 2>/dev/null
        
        # Calculate upload duration
        local upload_end_time=$(date +%s)
        local upload_duration=$((upload_end_time - upload_start_time))
        local minutes=$((upload_duration / 60))
        local seconds=$((upload_duration % 60))
        
        # Check if the upload was successful
        if [ $upload_status -eq 0 ]; then
            log "SUCCESS" "Upload completed successfully for ${device_name}"
            log "INFO" "Upload time: ${minutes} minutes ${seconds} seconds"
            echo -e "${GREEN}✓ Upload completed in ${minutes}m ${seconds}s${NC}"
            upload_success=true
        else
            if [ $retry_count -lt $MAX_UPLOAD_RETRIES ]; then
                log "ERROR" "Upload attempt $retry_count failed for ${device_name}"
                echo -e "${RED}✗ Upload failed${NC}"
                log "INFO" "Will retry in a moment..."
            else
                log "ERROR" "All $MAX_UPLOAD_RETRIES upload attempts failed for ${device_name}"
                echo -e "${RED}✗ All $MAX_UPLOAD_RETRIES upload attempts failed${NC}"
                mcumgr conn remove "udp" > /dev/null 2>&1
                return 1
            fi
        fi
    done
    
    # Only proceed with confirmation and reset if upload was successful
    if [ "$upload_success" = true ]; then
        # Get the updated image list
        echo -ne "${CYAN}⏳ Verifying uploaded image...${NC}"
        log "INFO" "Getting updated image list from ${device_name}..."
        image_list_output=$(mcumgr -c "udp" image list 2>&1)
        echo -ne "\r\033[K"
        
        # Save updated image list to the log
        echo "Updated image list from ${device_name}:" >> "$LOG_FILE"
        echo "$image_list_output" >> "$LOG_FILE"
        echo "" >> "$LOG_FILE"
        
        # Extract the hash of the newly uploaded image
        new_hash=$(echo "$image_list_output" | awk '/image=0 slot=1/{found=1} found && /hash:/{print $2; exit}')
        
        if [ -z "$new_hash" ]; then
            log "ERROR" "Failed to get new image hash for ${device_name}!"
            echo -e "${RED}✗ Verification failed - cannot find new image hash${NC}"
            mcumgr conn remove "udp" > /dev/null 2>&1
            return 1
        fi
        
        log "INFO" "New image hash on ${device_name}: ${new_hash}"
        
        # Test or confirm based on the mode
        if [ "$test_mode" = true ]; then
            echo -ne "${CYAN}⏳ Setting image for testing...${NC}"
            log "INFO" "Setting image for testing on ${device_name}..."
            test_output=$(mcumgr -c "udp" image test "$new_hash" 2>&1)
            
            if [ $? -ne 0 ]; then
                echo -ne "\r\033[K"
                log "ERROR" "Failed to set test mode for ${device_name}: ${test_output}"
                echo -e "${RED}✗ Failed to set test mode${NC}"
                mcumgr conn remove "udp" > /dev/null 2>&1
                return 1
            fi
            
            echo -ne "\r\033[K"
            log "SUCCESS" "Image marked for testing on ${device_name}. It will run once after reset and revert if boot fails."
            echo -e "${GREEN}✓ Image set for test boot${NC}"
        else
            echo -ne "${CYAN}⏳ Setting image as permanent...${NC}"
            log "INFO" "Confirming image permanently on ${device_name}..."
            confirm_output=$(mcumgr -c "udp" image confirm "$new_hash" 2>&1)
            
            if [ $? -ne 0 ]; then
                echo -ne "\r\033[K"
                log "ERROR" "Failed to confirm image for ${device_name}: ${confirm_output}"
                echo -e "${RED}✗ Failed to confirm image${NC}"
                mcumgr conn remove "udp" > /dev/null 2>&1
                return 1
            fi
            
            echo -ne "\r\033[K"
            log "SUCCESS" "Image confirmed permanently on ${device_name}."
            echo -e "${GREEN}✓ Image confirmed as permanent${NC}"
        fi
        
        # Reset the device
        echo -ne "${CYAN}⏳ Rebooting device...${NC}"
        log "INFO" "Resetting device ${device_name}..."
        reset_output=$(mcumgr -c "udp" reset 2>&1)
        
        if [ $? -ne 0 ]; then
            echo -ne "\r\033[K"
            log "WARNING" "Failed to reset device ${device_name}: ${reset_output}"
            echo -e "${YELLOW}! Device reset command failed, but flash was successful${NC}"
            # Not returning error as the flash was successful
        else
            echo -ne "\r\033[K"
            log "SUCCESS" "Device ${device_name} reset initiated."
            echo -e "${GREEN}✓ Device reboot initiated${NC}"
        fi
        
        # Clean up connection
        mcumgr conn remove "udp" > /dev/null 2>&1
        
        echo -e "${GREEN}✅ Update completed successfully for ${device_name}${NC}"
        log "SUCCESS" "Flash process completed for ${device_name}"
        return 0
    fi
    
    # If we reach here, all retries failed
    log "ERROR" "Flash process failed for ${device_name} after ${MAX_UPLOAD_RETRIES} attempts"
    echo -e "${RED}❌ Update failed for ${device_name}${NC}"
    mcumgr conn remove "udp" > /dev/null 2>&1
    return 1
}

# Function to clean up temp files
function cleanup() {
    # Clean up all temporary files
    if [ -f "$TEMP_PROGRESS_FILE" ]; then
        rm -f "$TEMP_PROGRESS_FILE"
    fi
    rm -f "$TEMP_PROGRESS_FILE.stalled" 2>/dev/null
    rm -f "$TEMP_PROGRESS_FILE.log" 2>/dev/null
    rm -f "$TEMP_PROGRESS_FILE.py" 2>/dev/null
    rm -f "/tmp/mcumgr_pipe_$" 2>/dev/null
    
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
    
    # Always make sure cursor is visible
    tput cnorm
}

# Main function
function main() {
    print_banner
    
    # Set up cleanup trap
    trap cleanup EXIT
    
    # Enable pipefail to catch errors in piped commands
    set -o pipefail
    
    # Check for required dependencies
    log "INFO" "Checking for required dependencies..."
    echo -e "${CYAN}⏳ Checking system requirements...${NC}"
    
    # Create a table for dependencies
    echo -e "${CYAN}┏━━━━━━━━━━━━━━━━━━━━━━━━━┳━━━━━━━━━━━━━━━━━━━━┓${NC}"
    echo -e "${CYAN}┃${BOLD} Dependency              ┃ Status             ${NC}${CYAN}┃${NC}"
    echo -e "${CYAN}┣━━━━━━━━━━━━━━━━━━━━━━━━━╋━━━━━━━━━━━━━━━━━━━━┫${NC}"
    
    # Check each dependency
    local deps_ok=true
    
    # Check mcumgr
    if command -v mcumgr &> /dev/null; then
        printf "${CYAN}┃${NC} %-23s ${CYAN}┃${NC} ${GREEN}%-19s${NC}\n" "mcumgr" "✓ Installed"
    else
        printf "${CYAN}┃${NC} %-23s ${CYAN}┃${NC} ${RED}%-19s${NC}\n" "mcumgr" "✗ Missing!"
        deps_ok=false
    fi
    
    # Check avahi-browse
    if command -v avahi-browse &> /dev/null; then
        printf "${CYAN}┃${NC} %-23s ${CYAN}┃${NC} ${GREEN}%-19s${NC}\n" "avahi-utils" "✓ Installed"
    else
        printf "${CYAN}┃${NC} %-23s ${CYAN}┃${NC} ${RED}%-19s${NC}\n" "avahi-utils" "✗ Missing!"
        deps_ok=false
    fi
    
    # Check tee
    if command -v tee &> /dev/null; then
        printf "${CYAN}┃${NC} %-23s ${CYAN}┃${NC} ${GREEN}%-19s${NC}\n" "tee (coreutils)" "✓ Installed"
    else
        printf "${CYAN}┃${NC} %-23s ${CYAN}┃${NC} ${RED}%-19s${NC}\n" "tee (coreutils)" "✗ Missing!"
        deps_ok=false
    fi
    
    # Check grep
    if command -v grep &> /dev/null; then
        printf "${CYAN}┃${NC} %-23s ${CYAN}┃${NC} ${GREEN}%-19s${NC}\n" "grep" "✓ Installed"
    else
        printf "${CYAN}┃${NC} %-23s ${CYAN}┃${NC} ${RED}%-19s${NC}\n" "grep" "✗ Missing!"
        deps_ok=false
    fi
    
    # Check python3
    if command -v python3 &> /dev/null; then
        printf "${CYAN}┃${NC} %-23s ${CYAN}┃${NC} ${GREEN}%-19s${NC}\n" "python3" "✓ Installed"
    else
        printf "${CYAN}┃${NC} %-23s ${CYAN}┃${NC} ${RED}%-19s${NC}\n" "python3" "✗ Missing!"
        deps_ok=false
    fi
    
    # Check timeout (recommended)
    if command -v timeout &> /dev/null; then
        printf "${CYAN}┃${NC} %-23s ${CYAN}┃${NC} ${GREEN}%-19s${NC}\n" "timeout (coreutils)" "✓ Installed"
    else
        printf "${CYAN}┃${NC} %-23s ${CYAN}┃${NC} ${YELLOW}%-19s${NC}\n" "timeout (coreutils)" "! Recommended"
    fi
    
    echo -e "${CYAN}┗━━━━━━━━━━━━━━━━━━━━━━━━━┻━━━━━━━━━━━━━━━━━━━━┛${NC}"
    
    # Exit if any required dependencies are missing
    if [ "$deps_ok" = false ]; then
        log "ERROR" "Missing required dependencies. Please install them and try again."
        echo -e "${RED}✗ Missing required dependencies. Please install the missing packages.${NC}"
        exit 1
    fi
    
    # Check for the get-image-hash.sh script
    if [ ! -f "./get-image-hash.sh" ]; then
        log "WARNING" "get-image-hash.sh not found in the current directory."
        echo -e "${YELLOW}! get-image-hash.sh not found. Hash comparison feature will not work properly.${NC}"
    fi
    
    # Check if the get-image-hash.sh script is executable
    if [ -f "./get-image-hash.sh" ] && [ ! -x "./get-image-hash.sh" ]; then
        log "INFO" "Making get-image-hash.sh executable..."
        chmod +x ./get-image-hash.sh
        echo -e "${GREEN}✓ Made get-image-hash.sh executable${NC}"
    fi
    
    # Locate build directory
    log "INFO" "Locating build directory..."
    echo -e "${CYAN}⏳ Locating firmware build directory...${NC}"
    
    # First check the default location
    if [ -d "../application/build" ]; then
        BUILD_DIR="../application/build"
        echo -e "${GREEN}✓ Found build directory at default location${NC}"
    else
        log "WARNING" "Default build directory not found at: ../application/build"
        echo -e "${YELLOW}! Default build directory not found${NC}"
        log "INFO" "Current directory: $(pwd)"
        
        # Prompt for custom path with better visuals
        echo ""
        echo -e "${YELLOW}? Enter full path to the build directory:${NC} "
        read -r build_path
        
        if [ -d "$build_path" ]; then
            BUILD_DIR="$build_path"
            echo -e "${GREEN}✓ Custom build directory accepted${NC}"
        else
            log "ERROR" "Invalid build directory: $build_path"
            echo -e "${RED}✗ Invalid build directory: $build_path${NC}"
            exit 1
        fi
    fi
    
    log "SUCCESS" "Using build directory: $BUILD_DIR"
    
    # Verify firmware image exists
    echo -ne "${CYAN}⏳ Checking for firmware image...${NC}"
    if [ ! -f "${BUILD_DIR}/zephyr/app_update.bin" ]; then
        echo -ne "\r\033[K"
        log "ERROR" "Firmware image not found at: ${BUILD_DIR}/zephyr/app_update.bin"
        echo -e "${RED}✗ Firmware image not found at: ${BUILD_DIR}/zephyr/app_update.bin${NC}"
        exit 1
    fi
    
    echo -ne "\r\033[K"
    log "SUCCESS" "Firmware image found: ${BUILD_DIR}/zephyr/app_update.bin"
    echo -e "${GREEN}✓ Firmware image found: ${BUILD_DIR}/zephyr/app_update.bin${NC}"
    
    # Discover available devices
    discover_devices
    
    # Prompt for operation mode with better visuals
    echo ""
    echo -e "${BLUE}┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓${NC}"
    echo -e "${BLUE}┃  ${BOLD}${CYAN}        Firmware Update Configuration       ${NC}${BLUE}  ┃${NC}"
    echo -e "${BLUE}┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫${NC}"
    echo -e "${BLUE}┃  ${CYAN}1. Test mode ${YELLOW}(can revert if boot fails)       ${NC}${CYAN}┃${NC}"
    echo -e "${BLUE}┃  ${CYAN}2. Confirm immediately ${RED}(permanent update)     ${NC}${CYAN}┃${NC}"
    echo -e "${BLUE}┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛${NC}"
    echo ""
    echo -ne "${YELLOW}? Select update mode [1-2]:${NC} "
    read -r test_confirm_choice
    
    if [[ "$test_confirm_choice" == "1" ]]; then
        TEST_MODE=true
        log "INFO" "Selected mode: Test mode (will revert if boot fails)"
        echo -e "${GREEN}✓ Selected: Test mode${NC}"
    elif [[ "$test_confirm_choice" == "2" ]]; then
        TEST_MODE=false
        log "INFO" "Selected mode: Confirm immediately (permanent)"
        echo -e "${GREEN}✓ Selected: Permanent mode${NC}"
    else
        log "ERROR" "Invalid selection: $test_confirm_choice"
        echo -e "${RED}✗ Invalid selection${NC}"
        exit 1
    fi
    
    # Allow configuration of timeout
    echo ""
    echo -e "${BLUE}┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓${NC}"
    echo -e "${BLUE}┃  ${BOLD}${CYAN}         Upload Timeout Configuration       ${NC}${BLUE}  ┃${NC}"
    echo -e "${BLUE}┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛${NC}"
    echo -e "${CYAN}This timeout will cancel uploads that stall for too long.${NC}"
    echo -e "${CYAN}Default is 300 seconds (5 minutes). Enter 0 to disable.${NC}"
    echo ""
    echo -ne "${YELLOW}? Enter upload stall timeout in seconds:${NC} "
    read -r timeout_setting
    
    # Validate input
    if [[ "$timeout_setting" =~ ^[0-9]+$ ]]; then
        if [ "$timeout_setting" -gt 0 ]; then
            UPLOAD_STALL_TIMEOUT=$timeout_setting
            log "INFO" "Upload stall timeout set to ${UPLOAD_STALL_TIMEOUT} seconds"
            echo -e "${GREEN}✓ Timeout set to ${UPLOAD_STALL_TIMEOUT} seconds${NC}"
        else
            log "INFO" "Stall detection disabled"
            UPLOAD_STALL_TIMEOUT=0
            echo -e "${YELLOW}! Stall detection disabled${NC}"
        fi
    else
        log "INFO" "Using default stall timeout of ${UPLOAD_STALL_TIMEOUT} seconds"
        echo -e "${GREEN}✓ Using default timeout (${UPLOAD_STALL_TIMEOUT} seconds)${NC}"
    fi
    
    # Allow configuration of max retries
    echo ""
    echo -e "${BLUE}┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓${NC}"
    echo -e "${BLUE}┃  ${BOLD}${CYAN}          Upload Retry Configuration        ${NC}${BLUE}  ┃${NC}"
    echo -e "${BLUE}┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛${NC}"
    echo -e "${CYAN}Number of times to retry uploading if it fails.${NC}"
    echo -e "${CYAN}Default is ${MAX_UPLOAD_RETRIES} retries.${NC}"
    echo ""
    echo -ne "${YELLOW}? Enter maximum number of upload retry attempts:${NC} "
    read -r retry_setting
    
    # Validate input
    if [[ "$retry_setting" =~ ^[0-9]+$ ]]; then
        if [ "$retry_setting" -ge 0 ]; then
            MAX_UPLOAD_RETRIES=$retry_setting
            log "INFO" "Maximum upload retries set to ${MAX_UPLOAD_RETRIES}"
            echo -e "${GREEN}✓ Max retries set to ${MAX_UPLOAD_RETRIES}${NC}"
        fi
    else
        log "INFO" "Using default retry setting of ${MAX_UPLOAD_RETRIES} attempts"
        echo -e "${GREEN}✓ Using default retries (${MAX_UPLOAD_RETRIES})${NC}"
    fi
    
    # Confirm before proceeding with a nice summary
    total_devices=${#DEVICE_NAMES[@]}
    echo ""
    echo -e "${BLUE}┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓${NC}"
    echo -e "${BLUE}┃  ${BOLD}${CYAN}            Operation Summary               ${NC}${BLUE}  ┃${NC}"
    echo -e "${BLUE}┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫${NC}"
    echo -e "${BLUE}┃  ${BOLD}Devices to update:${NC} ${CYAN}${total_devices}${NC}"
    echo -e "${BLUE}┃  ${BOLD}Update mode:${NC} ${CYAN}$([ "$TEST_MODE" = true ] && echo "Test mode" || echo "Permanent")${NC}"
    echo -e "${BLUE}┃  ${BOLD}Stall timeout:${NC} ${CYAN}${UPLOAD_STALL_TIMEOUT}s${NC}"
    echo -e "${BLUE}┃  ${BOLD}Max retries:${NC} ${CYAN}${MAX_UPLOAD_RETRIES}${NC}"
    echo -e "${BLUE}┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛${NC}"
    echo ""
    echo -ne "${YELLOW}? Proceed with firmware update? (y/n):${NC} "
    read -r confirm
    
    if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
        log "INFO" "Operation cancelled by user."
        echo -e "${YELLOW}Operation cancelled by user.${NC}"
        exit 0
    fi
    
    # Track statistics
    SUCCESSFUL_UPDATES=0
    FAILED_UPDATES=0
    SKIPPED_UPDATES=0
    
    # Display a progress header
    echo ""
    echo -e "${BLUE}┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓${NC}"
    echo -e "${BLUE}┃  ${BOLD}${CYAN}           Starting Updates...              ${NC}${BLUE}  ┃${NC}"
    echo -e "${BLUE}┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛${NC}"
    echo ""
    
    # Process each device with progress indication
    for i in "${!DEVICE_NAMES[@]}"; do
        # Show progress counter
        echo -e "${CYAN}Device ${i+1}/${total_devices}${NC}"
        
        # Fixed array access for device addresses 
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
        if [ $i -lt $((${#DEVICE_NAMES[@]} - 1)) ]; then
            echo -e "${CYAN}Waiting before next device...${NC}"
            sleep 2
            echo ""
            echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
            echo ""
        fi
    done
    
    # Display summary with nice formatting
    echo ""
    echo -e "${BLUE}┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓${NC}"
    echo -e "${BLUE}┃  ${BOLD}${CYAN}              Update Summary               ${NC}${BLUE}  ┃${NC}"
    echo -e "${BLUE}┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫${NC}"
    echo -e "${BLUE}┃  ${BOLD}Total devices:${NC} ${CYAN}${total_devices}${NC}                        ${BLUE}┃${NC}"
    echo -e "${BLUE}┃  ${BOLD}Successful updates:${NC} ${GREEN}${SUCCESSFUL_UPDATES}${NC}                    ${BLUE}┃${NC}"
    echo -e "${BLUE}┃  ${BOLD}Skipped (already updated):${NC} ${CYAN}${SKIPPED_UPDATES}${NC}                ${BLUE}┃${NC}"
    
    if [ $FAILED_UPDATES -gt 0 ]; then
        echo -e "${BLUE}┃  ${BOLD}Failed updates:${NC} ${RED}${FAILED_UPDATES}${NC}                         ${BLUE}┃${NC}"
    else
        echo -e "${BLUE}┃  ${BOLD}Failed updates:${NC} ${GREEN}${FAILED_UPDATES}${NC}                         ${BLUE}┃${NC}"
    fi
    
    echo -e "${BLUE}┃  ${BOLD}Log file:${NC} ${CYAN}${LOG_FILE}${NC}       ${BLUE}┃${NC}"
    echo -e "${BLUE}┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛${NC}"
    
    # Final completion message
    if [ $FAILED_UPDATES -eq 0 ]; then
        echo -e "\n${GREEN}${BOLD}✅ Bulk update process completed successfully!${NC}\n"
    else
        echo -e "\n${YELLOW}${BOLD}⚠️  Bulk update completed with ${FAILED_UPDATES} failures.${NC}\n"
        echo -e "${YELLOW}Check the log file for details: ${LOG_FILE}${NC}\n"
    fi
    
    # Clean up temp files
    cleanup
}

# Run the main function
main