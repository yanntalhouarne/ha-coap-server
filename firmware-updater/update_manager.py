#!/usr/bin/env python3
# update_manager.py - Interface between web app and update script

import os
import subprocess
import threading
import re
import time
import json
import glob
import logging
import tempfile
from datetime import datetime

logger = logging.getLogger(__name__)

class UpdateManager:
    """Manager class for handling firmware updates"""
    
    def __init__(self, socketio):
        """Initialize update manager with socket.io for real-time updates"""
        self.socketio = socketio
        self.update_in_progress = False
        self.current_status = {
            "state": "idle",
            "current_device": None,
            "total_devices": 0,
            "completed_devices": 0,
            "successful_updates": 0,
            "failed_updates": 0,
            "skipped_updates": 0,
            "upload_progress": 0,
            "log_file": None,
            "last_update": datetime.now().isoformat()
        }
        self.devices_list = []
        
        # Use the script from the parent directory's scripts folder
        self.script_dir = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '../scripts'))
        self.update_script = os.path.join(self.script_dir, 'mcumgr-update-all.sh')
        
        # Ensure the script directory exists
        if not os.path.exists(self.script_dir):
            logger.warning(f"Script directory not found: {self.script_dir}")
        
    def discover_devices(self):
        """Discover available devices using avahi-browse"""
        logger.info("Discovering devices...")
        self.emit_status_update("Discovering devices...")
        
        # Use avahi-browse to discover devices
        try:
            cmd = ["timeout", "3", "avahi-browse", "-r", "_ot._udp"]
            result = subprocess.run(cmd, capture_output=True, text=True)
            output = result.stdout
            
            # Parse the output to extract devices
            devices = []
            seen_devices = set()
            
            lines = output.split('\n')
            i = 0
            while i < len(lines):
                line = lines[i]
                if "= " in line and "ha-coap" in line and "IPv6" in line:
                    # Extract device name
                    parts = line.split()
                    if len(parts) >= 4:
                        device_name = parts[3]
                        
                        # Skip if we've already seen this device
                        if device_name in seen_devices:
                            i += 1
                            continue
                            
                        seen_devices.add(device_name)
                        
                        # Read the next 2 lines to get the address
                        if i + 2 < len(lines):
                            address_line = lines[i + 2]
                            # Extract IPv6 address
                            ipv6_match = re.search(r'\[fd[^\]]*\]', address_line)
                            if ipv6_match:
                                ipv6_address = ipv6_match.group(0).strip('[]')
                                devices.append({
                                    "name": device_name,
                                    "address": ipv6_address,
                                    "selected": True  # Default to selected
                                })
                i += 1
            
            logger.info(f"Discovered {len(devices)} devices")
            self.devices_list = devices
            self.emit_status_update(f"Discovered {len(devices)} devices")
            return devices
            
        except Exception as e:
            logger.error(f"Error discovering devices: {str(e)}")
            self.emit_status_update(f"Error discovering devices: {str(e)}")
            raise
    
    def start_update(self, devices, build_dir, update_mode, stall_timeout):
        """Start the update process for the given devices"""
        if self.update_in_progress:
            logger.warning("Update already in progress")
            return {"success": False, "error": "Update already in progress"}
        
        self.update_in_progress = True
        self.current_status = {
            "state": "updating",
            "current_device": None,
            "total_devices": len(devices),
            "completed_devices": 0,
            "successful_updates": 0,
            "failed_updates": 0,
            "skipped_updates": 0,
            "upload_progress": 0,
            "log_file": None,
            "last_update": datetime.now().isoformat()
        }
        
        logger.info(f"Starting update for {len(devices)} devices with build_dir={build_dir}, mode={update_mode}")
        self.emit_status_update(f"Starting update for {len(devices)} devices")
        
        try:
            # Create a temporary script to run updates in non-interactive mode
            with tempfile.NamedTemporaryFile(delete=False, mode='w', suffix='.sh') as temp_script:
                # Write device addresses to the temp script
                device_addresses = [device['address'] for device in devices]
                addresses_str = " ".join(device_addresses)
                
                # Set script mode
                temp_script.write("#!/bin/bash\n\n")
                temp_script.write(f"export BUILD_DIR=\"{build_dir}\"\n")
                temp_script.write(f"export DEVICE_ADDRESSES=\"{addresses_str}\"\n")
                temp_script.write(f"export UPDATE_MODE=\"{update_mode}\"\n")
                temp_script.write(f"export STALL_TIMEOUT=\"{stall_timeout}\"\n")
                temp_script.write(f"export NON_INTERACTIVE=\"true\"\n\n")
                temp_script.write(f"cd {os.path.dirname(self.update_script)}\n")
                temp_script.write(f"bash {self.update_script}\n")
                
                temp_script_path = temp_script.name
            
            # Make the temporary script executable
            os.chmod(temp_script_path, 0o755)
            
            # Run the update process and capture output
            logger.info(f"Running update script: {temp_script_path}")
            
            # Start process with line buffering to get real-time output
            self.update_process = subprocess.Popen(
                [temp_script_path], 
                stdout=subprocess.PIPE, 
                stderr=subprocess.STDOUT, 
                text=True, 
                bufsize=1
            )
            
            # Monitor process output for progress updates
            log_file = None
            current_device = None
            
            for line in iter(self.update_process.stdout.readline, ''):
                line = line.strip()
                
                # Extract log file name when created
                log_file_match = re.search(r'Log file: (flash_logs_[0-9_]+\.log)', line)
                if log_file_match:
                    log_file = log_file_match.group(1)
                    self.current_status["log_file"] = log_file
                
                # Track current device being processed
                device_match = re.search(r'===== Processing device: ([\w-]+)', line)
                if device_match:
                    current_device = device_match.group(1)
                    self.current_status["current_device"] = current_device
                
                # Track upload progress
                progress_match = re.search(r'(\d+\.\d+) KiB / (\d+\.\d+) KiB .* (\d+\.\d+)%', line)
                if progress_match:
                    current = float(progress_match.group(1))
                    total = float(progress_match.group(2))
                    percent = float(progress_match.group(3))
                    self.current_status["upload_progress"] = percent
                
                # Track completed devices
                if "Flash process completed for" in line or "Device already has the current image" in line:
                    self.current_status["completed_devices"] += 1
                
                # Track successful updates
                if "Upload completed successfully" in line:
                    self.current_status["successful_updates"] += 1
                
                # Track failed updates
                if "Failed to" in line or "Error" in line:
                    self.current_status["failed_updates"] += 1
                
                # Track skipped updates
                if "already has the current image installed" in line:
                    self.current_status["skipped_updates"] += 1
                
                # Update timestamp
                self.current_status["last_update"] = datetime.now().isoformat()
                
                # Emit status update via socket.io
                self.emit_status_update(line)
                
                logger.debug(line)
            
            # Wait for process to complete
            self.update_process.wait()
            
            # Update final status
            self.current_status["state"] = "completed"
            self.current_status["upload_progress"] = 100
            self.emit_status_update("Update process completed")
            
            # Clean up temp script
            os.unlink(temp_script_path)
            
        except Exception as e:
            logger.error(f"Error during update process: {str(e)}")
            self.current_status["state"] = "error"
            self.emit_status_update(f"Error during update: {str(e)}")
        
        finally:
            self.update_in_progress = False
    
    def get_status(self):
        """Get the current update status"""
        return self.current_status
    
    def get_log_files(self):
        """Get list of available log files"""
        log_files = glob.glob("flash_logs_*.log")
        return sorted(log_files, key=os.path.getmtime, reverse=True)
    
    def emit_status_update(self, message):
        """Emit a status update via socket.io"""
        self.socketio.emit('status_update', {
            'message': message,
            'status': self.current_status
        })