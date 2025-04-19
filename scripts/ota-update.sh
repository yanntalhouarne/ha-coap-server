#!/bin/bash

# Script to list ha-coap devices and flash them using mcumgr

# Function to extract ha-coap devices and their IPv6 addresses
function get_devices() {
    echo "Scanning for ha-coap devices (this will take a few seconds)..."
    
    # Run avahi-browse with a timeout to ensure it doesn't run indefinitely
    output=$(timeout 5s avahi-browse -r _ot._udp)
    
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
            
            # Add to our arrays
            devices+=("$device_name")
            addresses+=("$ipv6_address")
        fi
    done < <(echo "$output")
    
    # Check if we found any devices
    if [ ${#devices[@]} -eq 0 ]; then
        echo "No ha-coap devices found. Try increasing the timeout value in the script if you know devices are available."
        exit 1
    fi
    
    # Display the numbered list of devices
    echo "Available ha-coap devices:"
    for i in "${!devices[@]}"; do
        echo "  $((i+1)). ${devices[$i]}"
    done
    
    # Get user selection
    echo
    echo "Enter the number of the device to select (or 'q' to quit):"
    read -r choice
    
    # Process user selection
    if [[ "$choice" == "q" ]]; then
        echo "Exiting."
        exit 0
    elif [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le "${#devices[@]}" ]; then
        device_name="${devices[$((choice-1))]}"
        device_address="${addresses[$((choice-1))]}"
        echo
        echo "Selected device: $device_name"
        echo "IPv6 Address: $device_address"
        
        # Call the handle_device function with the selected device
        handle_device "$device_name" "$device_address"
    else
        echo "Invalid selection. Please try again."
        exit 1
    fi
}

# Function to handle device operations
function handle_device() {
    local device_name="$1"
    local device_address="$2"
    
    # Prompt for transport method
    echo
    echo "Select transport method:"
    echo "  1. USB-CDC"
    echo "  2. UDP"
    read -r transport_choice
    
    # Set variables based on transport choice
    if [[ "$transport_choice" == "1" ]]; then
        transport="serial"
        
        # Find all available serial ports using ls command
        echo "Looking for available serial ports..."
        port_output=$(ls /dev/ttyACM* 2>/dev/null)
        
        # Check if any ports were found
        if [ -z "$port_output" ]; then
            echo "No serial ports found matching /dev/ttyACM*"
            echo "Enter serial port path manually:"
            read -r com_port
        else
            # Create an array of ports from the ls output
            IFS=$'\n' read -rd '' -a serial_ports <<< "$port_output"
            
            # List available ports
            echo "Available serial ports:"
            for i in "${!serial_ports[@]}"; do
                echo "  $((i+1)). ${serial_ports[$i]}"
            done
            
            # Let user choose a port
            echo "Select a serial port number (or enter 'c' to enter custom port):"
            read -r port_choice
            
            if [[ "$port_choice" == "c" ]]; then
                echo "Enter serial port path:"
                read -r com_port
            elif [[ "$port_choice" =~ ^[0-9]+$ ]] && [ "$port_choice" -ge 1 ] && [ "$port_choice" -le "${#serial_ports[@]}" ]; then
                com_port="${serial_ports[$((port_choice-1))]}"
            else
                echo "Invalid port selection. Exiting."
                exit 1
            fi
        fi
        
        # Add the serial connection
        echo "Adding serial connection using port $com_port..."
        mcumgr conn add serial type="serial" connstring="$com_port,baud=115200,mtu=512"
    elif [[ "$transport_choice" == "2" ]]; then
        transport="udp"
        # Add the UDP connection
        echo "Adding UDP connection..."
        mcumgr conn add udp type="udp" connstring="[$device_address]:1337"
    else
        echo "Invalid transport selection."
        exit 1
    fi
    
    # Prompt for operation
    echo
    echo "Select operation:"
    echo "  1. Upload image"
    echo "  2. List images"
    read -r operation_choice
    
    if [[ "$operation_choice" == "1" ]]; then
    # Prompt for test or confirm before uploading
    echo
    echo "After uploading, do you want to test or confirm the image?"
    echo "  1. Test (can be reverted if problems occur)"
    echo "  2. Confirm (permanent)"
    read -r test_confirm_choice
    
    if [[ "$test_confirm_choice" != "1" && "$test_confirm_choice" != "2" ]]; then
        echo "Invalid choice. Please enter 1 for Test or 2 for Confirm."
    fi
    upload_and_process_image "$transport" "$test_confirm_choice"
    fi
    
    
    elif [[ "$operation_choice" == "2" ]]; then
        # Just list the images
        echo "Listing images..."
        mcumgr -c "$transport" image list
    else
        echo "Invalid operation selection."
        exit 1
    fi
}

# Function to handle the upload and post-upload operations
function upload_and_process_image() {
    local transport="$1"
    local test_confirm_choice="$2"
    
    # Change to the build directory
    echo "Changing to build directory..."
    cd ../application/build || { echo "Failed to change to build directory"; exit 1; }
    
    # Upload the new image
    echo "Uploading image..."
    mcumgr -c "$transport" image upload zephyr/app_update.bin
    
    # Check if the upload was successful
    if [ $? -ne 0 ]; then
        echo "Image upload failed!"
        exit 1
    fi
    
    echo "Upload completed successfully."
    
    # Get the image list to find the new hash
    echo "Getting image list..."
    image_list_output=$(mcumgr -c "$transport" image list)
    echo "$image_list_output"
    
    # Extract the hash for slot 1 (the newly uploaded image)
    new_hash=$(echo "$image_list_output" | grep -A 3 "image=0 slot=1" | grep "hash:" | awk '{print $2}')
    
    if [ -z "$new_hash" ]; then
        echo "Failed to get new image hash!"
        exit 1
    fi
    
    echo "New image hash: $new_hash"
    
    # Test or confirm based on earlier choice
    if [[ "$test_confirm_choice" == "1" ]]; then
        echo "Testing image..."
        mcumgr -c "$transport" image test "$new_hash"
    elif [[ "$test_confirm_choice" == "2" ]]; then
        echo "Confirming image..."
        mcumgr -c "$transport" image confirm "$new_hash"
    fi
    
    # Automatically reset the device after test/confirm
    echo "Resetting device..."
    mcumgr -c "$transport" reset
    echo "Device reset initiated."
    
    echo "Flash process completed."
}

# Run the main function
get_devices