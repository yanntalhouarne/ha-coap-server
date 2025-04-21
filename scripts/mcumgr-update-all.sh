#!/bin/bash

# ===================================================
# HA-CoAP Bulk Device Manager
# A tool to flash firmware to multiple Thread devices
# ===================================================

# Terminal colors for better visual experience
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
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
            color="$CYAN"
            prefix="[INFO]"
            ;;
        "SUCCESS")
            color="$GREEN"
            prefix="[SUCCESS]"
            ;;
        "ERROR")
            color="$RED"
            prefix="[ERROR]"
            ;;
        "WARNING")
            color="$YELLOW"
            prefix="[WARNING]"
            ;;
    esac
    
    # Print to console with color
    echo -e "${color}${prefix} ${message}${NC}"
    
    # Log to file without color codes
    echo "$(date '+%Y-%m-%d %H:%M:%S') ${prefix} ${message}" >> "$LOG_FILE"
}

# Print banner
function print_banner() {
    clear
    echo -e "${BLUE}+---------------------------------------------------+${NC}"
    echo -e "${BLUE}|                                                   |${NC}"
    echo -e "${BLUE}|${CYAN}              HA-CoAP Bulk Updater                 ${BLUE}|${NC}"
    echo -e "${BLUE}|${CYAN}         Multi-Device Flashing Tool                ${BLUE}|${NC}"
    echo -e "${BLUE}|                                                   |${NC}"
    echo -e "${BLUE}+---------------------------------------------------+${NC}"
    echo ""
    
    # Also log the banner to the log file
    echo "+---------------------------------------------------+" >> "$LOG_FILE"
    echo "|              HA-CoAP Bulk Updater                 |" >> "$LOG_FILE"
    echo "|         Multi-Device Flashing Tool                |" >> "$LOG_FILE"
    echo "+---------------------------------------------------+" >> "$LOG_FILE"
    echo "Log started at: $(date '+%Y-%m-%d %H:%M:%S')" >> "$LOG_FILE"
    echo "" >> "$LOG_FILE"
}

# Function to discover ha-coap devices and their IPv6 addresses
function discover_devices() {
    log "INFO" "Scanning for ha-coap devices..."
    
    # Run avahi-browse with a timeout to ensure it doesn't run indefinitely
    output=$(timeout 3s avahi-browse -r _ot._udp 2>/dev/null)
    
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
        log "INFO" "Troubleshooting tips:"
        log "INFO" "- Make sure your devices are powered on and connected"
        log "INFO" "- Verify Thread network is properly set up"
        log "INFO" "- Increase the timeout value in the script (currently 3s)"
        exit 1
    fi
    
    # Display the list of devices
    log "SUCCESS" "Found ${#devices[@]} ha-coap device(s)"
    for i in "${!devices[@]}"; do
        log "INFO" "[$((i+1))] ${devices[$i]} (${addresses[$i]})"
    done
    
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

# Function to update a single device
function update_device() {
    local device_name="$1"
    local device_address="$2"
    local test_mode="$3"
    local retry_count=0
    local upload_success=false
    
    log "INFO" "===== Processing device: ${device_name} (${device_address}) ====="
    
    # Add the UDP connection
    log "INFO" "Connecting via UDP to [${device_address}]:1337..."
    mcumgr conn add udp type="udp" connstring="[${device_address}]:1337" > /dev/null 2>&1
    
    if [ $? -ne 0 ]; then
        log "ERROR" "Failed to establish UDP connection to ${device_name}"
        return 1
    fi
    
    log "SUCCESS" "UDP connection established to ${device_name}"
    
    # Get the current image list
    log "INFO" "Retrieving current image list from ${device_name}..."
    image_list_output=$(mcumgr -c "udp" image list 2>&1)
    
    # Check if the command was successful
    if [ $? -ne 0 ]; then
        log "ERROR" "Failed to retrieve image list from ${device_name}: ${image_list_output}"
        mcumgr conn remove "udp" > /dev/null 2>&1
        return 1
    fi
    
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
        log "INFO" "Getting hash of new image..."
        new_image_hash=$(./get-image-hash.sh)
        
        if [ -z "$new_image_hash" ]; then
            log "WARNING" "Could not determine new image hash. Proceeding anyway."
        else
            log "INFO" "New image hash: ${new_image_hash}"
            
            # Compare the hashes
            if [ "$current_hash" == "$new_image_hash" ]; then
                log "INFO" "Device ${device_name} already has the current image installed."
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
            # Add a short delay before retrying
            sleep 3
        fi
        
        # Clear the progress file
        > "$TEMP_PROGRESS_FILE"
        
        # Upload the new image with stall detection
        log "INFO" "Uploading firmware image to ${device_name}..."
        log "INFO" "Upload will be terminated if stalled for ${UPLOAD_STALL_TIMEOUT} seconds"
        
        # Record start time for timing the upload
        local upload_start_time=$(date +%s)
        
        # Clear the progress file and stall indicator
        > "$TEMP_PROGRESS_FILE"
        rm -f "$TEMP_PROGRESS_FILE.stalled" 2>/dev/null
        rm -f "$TEMP_PROGRESS_FILE.log" 2>/dev/null
        rm -f "$TEMP_PROGRESS_FILE.py" 2>/dev/null
        
        # Use a better approach with coproc to monitor the process
        # This fixes the "wait: pid is not a child of this shell" error
        log "INFO" "Starting upload process..."
        
        # Create a named pipe for progress monitoring
        local pipe_file="/tmp/mcumgr_pipe_$"
        mkfifo "$pipe_file" 2>/dev/null
        
        # Start the upload in background using a process group
        set -m  # Enable job control
        mcumgr -c "udp" image upload "${BUILD_DIR}/zephyr/app_update.bin" > "$pipe_file" 2>&1 &
        upload_pid=$!
        set +m  # Disable job control
        
        # Start cat in background to read from the pipe and capture output
        cat "$pipe_file" | tee "$TEMP_PROGRESS_FILE" &
        cat_pid=$!
        
        # Start Python monitor in background only if stall detection is enabled
        if [ $UPLOAD_STALL_TIMEOUT -gt 0 ]; then
            stall_monitor_script "$TEMP_PROGRESS_FILE" $UPLOAD_STALL_TIMEOUT "$device_name" $upload_pid &
            monitor_pid=$!
        fi
        
        # Calculate a reasonable timeout (stall timeout plus margin)
        wait_timeout=$((UPLOAD_STALL_TIMEOUT + 3600))  # 1 hour margin
        
        # Wait for the upload to finish with timeout
        upload_status=0
        upload_done=false
        
        log "INFO" "Waiting for upload to complete (timeout: ${wait_timeout}s)..."
        
        # Start a timeout counter
        start_time=$(date +%s)
        while ! $upload_done; do
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
                        sleep 2
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
            log "ERROR" "Upload failed due to stall timeout"
            
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
            upload_success=true
        else
            if [ $retry_count -lt $MAX_UPLOAD_RETRIES ]; then
                log "ERROR" "Upload attempt $retry_count failed for ${device_name}"
                log "INFO" "Will retry in a moment..."
            else
                log "ERROR" "All $MAX_UPLOAD_RETRIES upload attempts failed for ${device_name}"
                mcumgr conn remove "udp" > /dev/null 2>&1
                return 1
            fi
        fi
    done
    
    # Only proceed with confirmation and reset if upload was successful
    if [ "$upload_success" = true ]; then
        # Get the updated image list
        log "INFO" "Getting updated image list from ${device_name}..."
        image_list_output=$(mcumgr -c "udp" image list 2>&1)
        
        # Save updated image list to the log
        echo "Updated image list from ${device_name}:" >> "$LOG_FILE"
        echo "$image_list_output" >> "$LOG_FILE"
        echo "" >> "$LOG_FILE"
        
        # Extract the hash of the newly uploaded image
        new_hash=$(echo "$image_list_output" | awk '/image=0 slot=1/{found=1} found && /hash:/{print $2; exit}')
        
        if [ -z "$new_hash" ]; then
            log "ERROR" "Failed to get new image hash for ${device_name}!"
            mcumgr conn remove "udp" > /dev/null 2>&1
            return 1
        fi
        
        log "INFO" "New image hash on ${device_name}: ${new_hash}"
        
        # Test or confirm based on the mode
        if [ "$test_mode" = true ]; then
            log "INFO" "Setting image for testing on ${device_name}..."
            test_output=$(mcumgr -c "udp" image test "$new_hash" 2>&1)
            
            if [ $? -ne 0 ]; then
                log "ERROR" "Failed to set test mode for ${device_name}: ${test_output}"
                mcumgr conn remove "udp" > /dev/null 2>&1
                return 1
            fi
            
            log "SUCCESS" "Image marked for testing on ${device_name}. It will run once after reset and revert if boot fails."
        else
            log "INFO" "Confirming image permanently on ${device_name}..."
            confirm_output=$(mcumgr -c "udp" image confirm "$new_hash" 2>&1)
            
            if [ $? -ne 0 ]; then
                log "ERROR" "Failed to confirm image for ${device_name}: ${confirm_output}"
                mcumgr conn remove "udp" > /dev/null 2>&1
                return 1
            fi
            
            log "SUCCESS" "Image confirmed permanently on ${device_name}."
        fi
        
        # Reset the device
        log "INFO" "Resetting device ${device_name}..."
        reset_output=$(mcumgr -c "udp" reset 2>&1)
        
        if [ $? -ne 0 ]; then
            log "WARNING" "Failed to reset device ${device_name}: ${reset_output}"
            # Not returning error as the flash was successful
        else
            log "SUCCESS" "Device ${device_name} reset initiated."
        fi
        
        # Clean up connection
        mcumgr conn remove "udp" > /dev/null 2>&1
        
        log "SUCCESS" "Flash process completed for ${device_name}"
        return 0
    fi
    
    # If we reach here, all retries failed
    log "ERROR" "Flash process failed for ${device_name} after ${MAX_UPLOAD_RETRIES} attempts"
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
    
    if ! command -v mcumgr &> /dev/null; then
        log "ERROR" "mcumgr not found. Please install it before running this script."
        log "INFO" "Installation instructions: https://docs.zephyrproject.org/latest/services/device_mgmt/mcumgr.html"
        exit 1
    fi
    
    if ! command -v avahi-browse &> /dev/null; then
        log "ERROR" "avahi-browse not found. Please install avahi-utils before running this script."
        log "INFO" "Installation: sudo apt install avahi-utils"
        exit 1
    fi
    
    if ! command -v tee &> /dev/null; then
        log "ERROR" "tee command not found. This is required for progress display."
        log "INFO" "Installation: sudo apt install coreutils"
        exit 1
    fi
    
    if ! command -v grep &> /dev/null; then
        log "ERROR" "grep command not found. This is required for progress monitoring."
        log "INFO" "Installation: sudo apt install grep"
        exit 1
    fi
    
    if ! command -v python3 &> /dev/null; then
        log "ERROR" "python3 not found. This is required for stall detection."
        log "INFO" "Installation: sudo apt install python3"
        exit 1
    fi
    
    # Recommend timeout command which helps prevent hanging
    if ! command -v timeout &> /dev/null; then
        log "WARNING" "timeout command not found. Installing it is recommended for better stall handling."
        log "INFO" "Installation: sudo apt install coreutils"
    fi
    
    # Check for the get-image-hash.sh script
    if [ ! -f "./get-image-hash.sh" ]; then
        log "WARNING" "get-image-hash.sh not found in the current directory."
        log "INFO" "Hash comparison feature will not work properly."
    fi
    
    # Check if the get-image-hash.sh script is executable
    if [ -f "./get-image-hash.sh" ] && [ ! -x "./get-image-hash.sh" ]; then
        log "INFO" "Making get-image-hash.sh executable..."
        chmod +x ./get-image-hash.sh
    fi
    
    # Locate build directory
    log "INFO" "Locating build directory..."
    
    # First check the default location
    if [ -d "../application/build" ]; then
        BUILD_DIR="../application/build"
    else
        log "WARNING" "Default build directory not found at: ../application/build"
        log "INFO" "Current directory: $(pwd)"
        
        # Prompt for custom path
        echo -e "${YELLOW}? Enter full path to the build directory:${NC} "
        read -r build_path
        
        if [ -d "$build_path" ]; then
            BUILD_DIR="$build_path"
        else
            log "ERROR" "Invalid build directory: $build_path"
            exit 1
        fi
    fi
    
    log "SUCCESS" "Using build directory: $BUILD_DIR"
    
    # Verify firmware image exists
    if [ ! -f "${BUILD_DIR}/zephyr/app_update.bin" ]; then
        log "ERROR" "Firmware image not found at: ${BUILD_DIR}/zephyr/app_update.bin"
        exit 1
    fi
    
    log "SUCCESS" "Firmware image found: ${BUILD_DIR}/zephyr/app_update.bin"
    
    # Discover available devices
    discover_devices
    
    # Prompt for operation mode
    echo ""
    echo -e "${BLUE}+-------------------------------------------+${NC}"
    echo -e "${BLUE}|          Firmware Update Configuration    |${NC}"
    echo -e "${BLUE}+-------------------------------------------+${NC}"
    echo -e "  ${CYAN}1.${NC} Test mode ${YELLOW}(can be reverted if problems occur)${NC}"
    echo -e "  ${CYAN}2.${NC} Confirm immediately ${RED}(permanent, no going back)${NC}"
    echo ""
    echo -e "${YELLOW}? Select update mode [1-2]:${NC} "
    read -r test_confirm_choice
    
    if [[ "$test_confirm_choice" == "1" ]]; then
        TEST_MODE=true
        log "INFO" "Selected mode: Test mode (will revert if boot fails)"
    elif [[ "$test_confirm_choice" == "2" ]]; then
        TEST_MODE=false
        log "INFO" "Selected mode: Confirm immediately (permanent)"
    else
        log "ERROR" "Invalid selection: $test_confirm_choice"
        exit 1
    fi
    
    # Allow configuration of timeout
    echo ""
    echo -e "${YELLOW}? Enter upload stall timeout in seconds (300 is default, 0 to disable):${NC} "
    read -r timeout_setting
    
    # Validate input
    if [[ "$timeout_setting" =~ ^[0-9]+$ ]]; then
        if [ "$timeout_setting" -gt 0 ]; then
            UPLOAD_STALL_TIMEOUT=$timeout_setting
            log "INFO" "Upload stall timeout set to ${UPLOAD_STALL_TIMEOUT} seconds"
        else
            log "INFO" "Stall detection disabled"
            UPLOAD_STALL_TIMEOUT=0
        fi
    else
        log "INFO" "Using default stall timeout of ${UPLOAD_STALL_TIMEOUT} seconds"
    fi
    
    # Allow configuration of max retries
    echo ""
    echo -e "${YELLOW}? Enter maximum number of upload retry attempts (${MAX_UPLOAD_RETRIES} is default):${NC} "
    read -r retry_setting
    
    # Validate input
    if [[ "$retry_setting" =~ ^[0-9]+$ ]]; then
        if [ "$retry_setting" -ge 0 ]; then
            MAX_UPLOAD_RETRIES=$retry_setting
            log "INFO" "Maximum upload retries set to ${MAX_UPLOAD_RETRIES}"
        fi
    else
        log "INFO" "Using default retry setting of ${MAX_UPLOAD_RETRIES} attempts"
    fi
    
    # Confirm before proceeding
    total_devices=${#DEVICE_NAMES[@]}
    echo ""
    echo -e "${YELLOW}? You are about to update firmware on ${total_devices} devices. Continue? (y/n):${NC} "
    read -r confirm
    
    if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
        log "INFO" "Operation cancelled by user."
        exit 0
    fi
    
    # Track statistics
    SUCCESSFUL_UPDATES=0
    FAILED_UPDATES=0
    SKIPPED_UPDATES=0
    
    # Process each device
    for i in "${!DEVICE_NAMES[@]}"; do
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
        sleep 2
    done
    
    # Display summary
    echo ""
    log "INFO" "==== Update Summary ===="
    log "INFO" "Total devices: $total_devices"
    log "SUCCESS" "Successful updates: $SUCCESSFUL_UPDATES"
    log "INFO" "Skipped updates (already had image): $SKIPPED_UPDATES"
    if [ $FAILED_UPDATES -gt 0 ]; then
        log "ERROR" "Failed updates: $FAILED_UPDATES"
    else
        log "INFO" "Failed updates: $FAILED_UPDATES"
    fi
    log "INFO" "Log file: $LOG_FILE"
    
    log "INFO" "Bulk update process completed."
    
    # Clean up temp files
    cleanup
}

# Run the main function
main 