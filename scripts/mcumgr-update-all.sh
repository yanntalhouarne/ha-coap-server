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

# Timestamp for log files
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
LOG_FILE="flash_logs_${TIMESTAMP}.log"

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
    echo -e "${BLUE}|${CYAN}         Multi-Device Flashing Tool               ${BLUE}|${NC}"
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

# Function to extract ha-coap devices and their IPv6 addresses
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

# Function to update a single device
function update_device() {
    local device_name="$1"
    local device_address="$2"
    local test_mode="$3"
    
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
    
    # Upload the new image - SHOWING PROGRESS BAR
    log "INFO" "Uploading firmware image to ${device_name}..."
    
    # Run mcumgr directly so that the progress bar is displayed
    # Store the command output, but also let it display to the console
    set -o pipefail  # Make sure pipe failures are propagated
    mcumgr -c "udp" image upload "${BUILD_DIR}/zephyr/app_update.bin" 2>&1 | tee -a "$LOG_FILE"
    upload_status=$?
    
    # Check if the upload was successful
    if [ $upload_status -ne 0 ]; then
        log "ERROR" "Image upload failed for ${device_name}"
        mcumgr conn remove "udp" > /dev/null 2>&1
        return 1
    fi
    
    log "SUCCESS" "Upload completed successfully for ${device_name}"
    
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
}

# Main function
function main() {
    print_banner
    
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
    
    # Check for tee command
    if ! command -v tee &> /dev/null; then
        log "ERROR" "tee command not found. This is required for progress display."
        log "INFO" "Installation: sudo apt install coreutils"
        exit 1
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
        update_device "${DEVICE_NAMES[$i]}" "${DEVICE_ADDRESSES[$i]}" "$TEST_MODE"
        result=$?
        
        if [ $result -eq 0 ]; then
            SUCCESSFUL_UPDATES=$((SUCCESSFUL_UPDATES + 1))
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
    if [ $FAILED_UPDATES -gt 0 ]; then
        log "ERROR" "Failed updates: $FAILED_UPDATES"
    else
        log "INFO" "Failed updates: $FAILED_UPDATES"
    fi
    log "INFO" "Skipped updates: $SKIPPED_UPDATES"
    log "INFO" "Log file: $LOG_FILE"
    
    log "INFO" "Bulk update process completed."
}

# Run the main function
main