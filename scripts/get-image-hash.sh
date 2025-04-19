#!/bin/bash
# Copyright (c) 2018 Foundries.io
#
# SPDX-License-Identifier: Apache-2.0

# Change to the appropriate directory
cd ../application/build || {
    echo "Error: Unable to change to directory ../application/build"
    echo "Please ensure the directory exists"
    exit 1
}

# Constants
IMG_HDR_MAGIC=0x96f3b83d
IMAGE_F_RAM_LOAD=0x00000020
TLV_INFO_MAGIC=6907  # Removed 0x prefix for comparison

# Hardcoded path for the image file (path is now relative to ../application/build)
IMAGE_FILE="zephyr/app_update.bin"

# Check if the file exists
if [ ! -f "$IMAGE_FILE" ]; then
    echo "Error: File '$IMAGE_FILE' not found"
    echo "Ensure the image file exists at: $(pwd)/$IMAGE_FILE"
    exit 1
fi

# Function to read little-endian values from binary file
function read_le() {
    local file=$1
    local offset=$2
    local size=$3
    
    local value=0
    local byte
    
    for ((i=0; i<$size; i++)); do
        byte=$(xxd -p -s $(($offset+$i)) -l 1 "$file" | tr -d '\n')
        value=$(( $value | (0x$byte << (8 * $i)) ))
    done
    
    echo $value
}

# Parse image header (needed to find TLV location)
hdr_size=$(read_le "$IMAGE_FILE" 8 2)
img_size=$(read_le "$IMAGE_FILE" 12 4)

# Parse TLV info
tlv_info_offset=$((hdr_size + img_size))
tlv_info_magic=$(read_le "$IMAGE_FILE" $tlv_info_offset 2)
tlv_size=$(read_le "$IMAGE_FILE" $((tlv_info_offset + 2)) 2)

# Check if TLV info is valid - using numeric comparison
if [ $tlv_info_magic -ne $TLV_INFO_MAGIC ]; then
    # Continue anyway - just output what we find
    : # No operation - empty command
fi

# TLV constants
TLV_INFO_SIZE=4
TLV_HDR_SIZE=4

# Process TLVs looking for TLV 0
tlv_end=$((tlv_info_offset + tlv_size))
tlv_off=$((tlv_info_offset + TLV_INFO_SIZE))
tlv_num=0
tlv_hash_found=false

while [ $tlv_off -lt $tlv_end ]; do
    tlv_type=$(read_le "$IMAGE_FILE" $tlv_off 1)
    tlv_len=$(read_le "$IMAGE_FILE" $((tlv_off + 2)) 2)
    
    if [ $tlv_num -eq 0 ]; then
        # Output the hash data without spaces
        hash_data=$(xxd -p -s $((tlv_off + TLV_HDR_SIZE)) -l $tlv_len "$IMAGE_FILE" | tr -d '\n')
        echo "$hash_data"
        
        tlv_hash_found=true
        break
    fi
    
    tlv_off=$((tlv_off + TLV_HDR_SIZE + tlv_len))
    tlv_num=$((tlv_num + 1))
done

# If TLV 0 wasn't found, look for the first hash-like data after the image
if [ "$tlv_hash_found" = false ]; then
    # Let's try extracting what appears to be a hash right after the image
    potential_hash_offset=$((tlv_info_offset + TLV_INFO_SIZE))
    potential_hash=$(xxd -p -s $potential_hash_offset -l 32 "$IMAGE_FILE" | tr -d '\n')
    echo "$potential_hash"
fi