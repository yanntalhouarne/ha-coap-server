#!/bin/bash

# ===================================================
# HA-CoAP Device Manager
# A tool to find and flash Thread-based IoT devices
# ===================================================

# Terminal colors for better visual experience
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Print banner
function print_banner() {
    clear
    echo -e "${BLUE}TPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPW${NC}"
    echo -e "${BLUE}Q                                                        Q${NC}"
    echo -e "${BLUE}Q${CYAN}              HA-CoAP Device Manager                   ${BLUE}Q${NC}"
    echo -e "${BLUE}Q${CYAN}            Thread Device Flashing Tool                ${BLUE}Q${NC}"
    echo -e "${BLUE}Q                                                        Q${NC}"
    echo -e "${BLUE}ZPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP]${NC}"
    echo ""
}

# Function to extract ha-coap devices and their IPv6 addresses
function get_devices() {
    print_banner
    echo -e "${YELLOW}* Scanning for ha-coap devices...${NC}"
    echo -e "${CYAN}   This will take a few seconds...${NC}"
    echo ""
    
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
        echo -e "${RED} No ha-coap devices found.${NC}"
                    echo -e "${CYAN}i Try these troubleshooting steps:${NC}"
        echo -e "  - Make sure your devices are powered on and connected"
        echo -e "  - Verify Thread network is properly set up"
        echo -e "  - Increase the timeout value in the script (currently 3s)"
        echo ""
        read -n 1 -s -r -p "Press any key to exit..."
        exit 1
    fi
    
    # Display the numbered list of devices
    echo -e "${GREEN}+ Found ${#devices[@]} ha-coap device(s):${NC}"
    for i in "${!devices[@]}"; do
        echo -e "  ${CYAN}$((i+1)).${NC} ${devices[$i]} ${YELLOW}(${addresses[$i]})${NC}"
    done
    
    # Get user selection
    echo ""
    echo -e "${YELLOW}? Enter the device number to select [1-${#devices[@]}] (or 'q' to quit):${NC} "
    read -r choice
    
    # Process user selection
    if [[ "$choice" == "q" ]]; then
        echo -e "${BLUE}Goodbye!${NC}"
        exit 0
    elif [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le "${#devices[@]}" ]; then
        device_name="${devices[$((choice-1))]}"
        device_address="${addresses[$((choice-1))]}"
        echo ""
        echo -e "${GREEN} Selected device: ${CYAN}$device_name${NC}"
        echo -e "${GREEN} IPv6 Address: ${YELLOW}$device_address${NC}"
        
        # Call the handle_device function with the selected device
        handle_device "$device_name" "$device_address"
    else
        echo -e "${RED} Invalid selection.${NC}"
        echo ""
        read -n 1 -s -r -p "Press any key to try again..."
        get_devices
    fi
}

# Function to handle device operations
function handle_device() {
    local device_name="$1"
    local device_address="$2"
    
    # Prompt for transport method
    echo ""
    echo -e "${BLUE}TPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPW${NC}"
    echo -e "${BLUE}Q          Connection Method             Q${NC}"
    echo -e "${BLUE}ZPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP]${NC}"
    echo -e "  ${CYAN}1.${NC} Connect via USB-CDC Serial"
    echo -e "  ${CYAN}2.${NC} Connect via UDP (Thread network)"
    echo ""
    echo -e "${YELLOW}? Select connection method [1-2]:${NC} "
    read -r transport_choice
    
    # Set variables based on transport choice
    if [[ "$transport_choice" == "1" ]]; then
        transport="serial"
        
        # Find all available serial ports
        echo -e "${YELLOW}� Looking for available serial ports...${NC}"
        port_output=$(ls /dev/ttyACM* 2>/dev/null)
        
        # Check if any ports were found
        if [ -z "$port_output" ]; then
            echo -e "${RED} No serial ports found matching /dev/ttyACM*${NC}"
            echo -e "${YELLOW}? Enter serial port path manually:${NC} "
            read -r com_port
        else
            # Create an array of ports from the ls output
            IFS=$'\n' read -rd '' -a serial_ports <<< "$port_output"
            
            # List available ports
            echo -e "${GREEN} Available serial ports:${NC}"
            for i in "${!serial_ports[@]}"; do
                echo -e "  ${CYAN}$((i+1)).${NC} ${serial_ports[$i]}"
            done
            
            # Let user choose a port
            echo ""
            echo -e "${YELLOW}? Select a serial port number [1-${#serial_ports[@]}] (or 'c' for custom):${NC} "
            read -r port_choice
            
            if [[ "$port_choice" == "c" ]]; then
                echo -e "${YELLOW}? Enter serial port path:${NC} "
                read -r com_port
            elif [[ "$port_choice" =~ ^[0-9]+$ ]] && [ "$port_choice" -ge 1 ] && [ "$port_choice" -le "${#serial_ports[@]}" ]; then
                com_port="${serial_ports[$((port_choice-1))]}"
            else
                echo -e "${RED} Invalid port selection. Try again.${NC}"
                handle_device "$device_name" "$device_address"
                return
            fi
        fi
        
        # Add the serial connection
        echo -e "${YELLOW}� Connecting via serial port ${CYAN}$com_port${NC}..."
        mcumgr conn add serial type="serial" connstring="$com_port,baud=115200,mtu=512"
        
        if [ $? -ne 0 ]; then
            echo -e "${RED} Failed to establish serial connection!${NC}"
            echo ""
            read -n 1 -s -r -p "Press any key to try again..."
            handle_device "$device_name" "$device_address"
            return
        fi
        
        echo -e "${GREEN} Serial connection established!${NC}"
        
    elif [[ "$transport_choice" == "2" ]]; then
        transport="udp"
        # Add the UDP connection
        echo -e "${YELLOW}� Connecting via UDP to ${CYAN}[$device_address]:1337${NC}..."
        mcumgr conn add udp type="udp" connstring="[$device_address]:1337"
        
        if [ $? -ne 0 ]; then
            echo -e "${RED} Failed to establish UDP connection!${NC}"
            echo ""
            read -n 1 -s -r -p "Press any key to try again..."
            handle_device "$device_name" "$device_address"
            return
        fi
        
        echo -e "${GREEN} UDP connection established!${NC}"
    else
        echo -e "${RED} Invalid selection.${NC}"
        echo ""
        read -n 1 -s -r -p "Press any key to try again..."
        handle_device "$device_name" "$device_address"
        return
    fi
    
    # Prompt for operation
    echo ""
    echo -e "${BLUE}TPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPW${NC}"
    echo -e "${BLUE}Q          Device Operation              Q${NC}"
    echo -e "${BLUE}ZPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP]${NC}"
    echo -e "  ${CYAN}1.${NC} Upload and flash new firmware image"
    echo -e "  ${CYAN}2.${NC} List current firmware images"
    echo -e "  ${CYAN}3.${NC} Return to device selection"
    echo ""
    echo -e "${YELLOW}? Select operation [1-3]:${NC} "
    read -r operation_choice
    
    if [[ "$operation_choice" == "1" ]]; then
        upload_and_process_image "$transport"
    elif [[ "$operation_choice" == "2" ]]; then
        # Just list the images
        echo -e "${YELLOW}� Listing firmware images...${NC}"
        echo ""
        mcumgr -c "$transport" image list
        echo ""
        read -n 1 -s -r -p "Press any key to return to operations menu..."
        # Clean up connection
        mcumgr conn remove "$transport" >/dev/null 2>&1
        handle_device "$device_name" "$device_address"
    elif [[ "$operation_choice" == "3" ]]; then
        # Clean up connection
        mcumgr conn remove "$transport" >/dev/null 2>&1
        get_devices
    else
        echo -e "${RED} Invalid selection.${NC}"
        echo ""
        read -n 1 -s -r -p "Press any key to try again..."
        # Clean up connection
        mcumgr conn remove "$transport" >/dev/null 2>&1
        handle_device "$device_name" "$device_address"
    fi
}

# Function to handle the upload and post-upload operations
function upload_and_process_image() {
    local transport="$1"
    
    # Check for build directory
    if [ -d "../application/build" ]; then
        # Change to the build directory
        echo -e "${YELLOW}� Changing to build directory...${NC}"
        cd ../application/build || { 
            echo -e "${RED} Failed to change to build directory${NC}"
            read -n 1 -s -r -p "Press any key to return..."
            return
        }
    else
        echo -e "${RED} Build directory not found!${NC}"
        echo -e "${CYAN}9 Expected path: ${YELLOW}../application/build${NC}"
        echo -e "${CYAN}9 Current directory: ${YELLOW}$(pwd)${NC}"
        echo ""
        echo -e "${YELLOW}? Do you want to specify a different path? (y/n):${NC} "
        read -r custom_path_choice
        
        if [[ "$custom_path_choice" == "y" ]]; then
            echo -e "${YELLOW}? Enter full path to the build directory:${NC} "
            read -r build_path
            cd "$build_path" || {
                echo -e "${RED} Failed to change to specified directory${NC}"
                read -n 1 -s -r -p "Press any key to return..."
                return
            }
        else
            read -n 1 -s -r -p "Press any key to return..."
            return
        fi
    fi
    
    # Check if firmware image exists
    if [ ! -f "zephyr/app_update.bin" ]; then
        echo -e "${RED} Firmware image not found!${NC}"
        echo -e "${CYAN}9 Expected file: ${YELLOW}zephyr/app_update.bin${NC}"
        echo ""
        read -n 1 -s -r -p "Press any key to return..."
        return
    fi
    
    # Get the image list to find the current hash at slot 0
    echo -e "${YELLOW}� Getting current image list...${NC}"
    image_list_output=$(mcumgr -c "$transport" image list)
    echo "$image_list_output"
    
    # Extract the current hash in slot 0
    current_hash=$(echo "$image_list_output" | awk '/image=0 slot=0/{found=1} found && /hash:/{print $2; exit}')
    
    if [ -z "$current_hash" ]; then
        echo -e "${YELLOW}� Could not determine current image hash. Proceeding anyway.${NC}"
    else
        echo -e "${GREEN} Current image hash in slot 0: ${CYAN}$current_hash${NC}"
        
        # Change back to the original directory to run get-image-hash.sh
        cd - > /dev/null
        
        # Get the hash of the image we're about to upload
        echo -e "${YELLOW}� Getting hash of new image...${NC}"
        new_image_hash=$(./get-image-hash.sh)
        
        if [ -z "$new_image_hash" ]; then
            echo -e "${YELLOW}� Could not determine new image hash. Proceeding anyway.${NC}"
        else
            echo -e "${GREEN} New image hash: ${CYAN}$new_image_hash${NC}"
            
            # Compare the hashes
            if [ "$current_hash" == "$new_image_hash" ]; then
                echo -e "${BLUE}9 The image you're trying to upload is already installed on the device.${NC}"
                echo -e "${YELLOW}? Do you want to proceed anyway? (y/n):${NC} "
                read -r proceed_choice
                
                if [[ "$proceed_choice" != "y" ]]; then
                    echo -e "${BLUE}Operation cancelled. The device already has this image.${NC}"
                    # Clean up connection
                    mcumgr conn remove "$transport" >/dev/null 2>&1
                    echo ""
                    read -n 1 -s -r -p "Press any key to return to main menu..."
                    get_devices
                    return
                fi
            fi
        fi
        
        # Change back to the build directory
        cd ../application/build || {
            echo -e "${RED} Failed to change back to build directory${NC}"
            read -n 1 -s -r -p "Press any key to return..."
            # Clean up connection
            mcumgr conn remove "$transport" >/dev/null 2>&1
            return
        }
    fi
    
    # Prompt for test or confirm before uploading
    echo ""
    echo -e "${BLUE}TPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPW${NC}"
    echo -e "${BLUE}Q          Firmware Update Configuration            Q${NC}"
    echo -e "${BLUE}ZPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP]${NC}"
    echo -e "  ${CYAN}1.${NC} Test mode ${YELLOW}(can be reverted if problems occur)${NC}"
    echo -e "  ${CYAN}2.${NC} Confirm immediately ${RED}(permanent, no going back)${NC}"
    echo ""
    echo -e "${YELLOW}? Select update mode [1-2]:${NC} "
    read -r test_confirm_choice
    
    # Upload the new image
    echo ""
    echo -e "${YELLOW}� Uploading firmware image...${NC}"
    echo -e "${CYAN}   This may take a while depending on connection speed...${NC}"
    echo ""
    
    mcumgr -c "$transport" image upload zephyr/app_update.bin
    
    # Check if the upload was successful
    if [ $? -ne 0 ]; then
        echo -e "${RED} Image upload failed!${NC}"
        echo ""
        read -n 1 -s -r -p "Press any key to return..."
        return
    fi
    
    echo -e "${GREEN} Upload completed successfully.${NC}"
    
    # Get the image list to find the new hash
    echo -e "${YELLOW}� Getting updated image list...${NC}"
    image_list_output=$(mcumgr -c "$transport" image list)
    echo "$image_list_output"
    
    # More direct approach to extract the hash - look specifically for the hash line after "image=0 slot=1" appears
    new_hash=$(echo "$image_list_output" | awk '/image=0 slot=1/{found=1} found && /hash:/{print $2; exit}')
    
    if [ -z "$new_hash" ]; then
        echo -e "${RED} Failed to get new image hash!${NC}"
        echo ""
        read -n 1 -s -r -p "Press any key to return..."
        return
    fi
    
    echo -e "${GREEN} New image hash: ${CYAN}$new_hash${NC}"
    
    # Test or confirm based on earlier choice
    if [[ "$test_confirm_choice" == "1" ]]; then
        echo -e "${YELLOW}� Testing image...${NC}"
        mcumgr -c "$transport" image test "$new_hash"
        echo -e "${GREEN} Image marked for testing. It will run once after reset.${NC}"
        echo -e "${CYAN}9 If the device doesn't boot properly, it will revert to the previous image.${NC}"
    elif [[ "$test_confirm_choice" == "2" ]]; then
        echo -e "${YELLOW}� Confirming image...${NC}"
        mcumgr -c "$transport" image confirm "$new_hash"
        echo -e "${GREEN} Image confirmed permanently.${NC}"
    else
        echo -e "${RED} Invalid choice. No changes made to boot configuration.${NC}"
        echo ""
        read -n 1 -s -r -p "Press any key to return..."
        return
    fi
    
    # Automatically reset the device
    echo ""
    echo -e "${YELLOW}� Resetting device automatically...${NC}"
    mcumgr -c "$transport" reset
    echo -e "${GREEN} Device reset initiated.${NC}"
    
    # Clean up connection
    mcumgr conn remove "$transport" >/dev/null 2>&1
    
    echo ""
    echo -e "${GREEN} Flash process completed.${NC}"
    echo ""
    read -n 1 -s -r -p "Press any key to return to main menu..."
    get_devices
}

# Check for required dependencies
echo -e "${YELLOW}� Checking for required dependencies...${NC}"
if ! command -v mcumgr &> /dev/null; then
    echo -e "${RED} mcumgr not found. Please install it before running this script.${NC}"
    echo -e "${CYAN}9 Installation instructions: https://docs.zephyrproject.org/latest/services/device_mgmt/mcumgr.html${NC}"
    exit 1
fi

if ! command -v avahi-browse &> /dev/null; then
    echo -e "${RED} avahi-browse not found. Please install avahi-utils before running this script.${NC}"
    echo -e "${CYAN}9 Installation: sudo apt install avahi-utils${NC}"
    exit 1
fi

# Also check for the get-image-hash.sh script
if [ ! -f "./get-image-hash.sh" ]; then
    echo -e "${YELLOW}� get-image-hash.sh not found in the current directory.${NC}"
    echo -e "${CYAN}9 Hash comparison feature will not work properly.${NC}"
fi

# Run the main function
get_devices 