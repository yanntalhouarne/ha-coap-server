#!/usr/bin/env python3
# update_manager.py - Interface between web app and update script

import os
import subprocess
import threading
import re
import logging
from datetime import datetime

logger = logging.getLogger(__name__)

# Per-run logs written by this manager: update_YYYYmmdd_HHMMSS.log
LOG_FILE_RE = re.compile(r'^update_\d{8}_\d{6}\.log$')


class UpdateManager:
    """Manager class for handling firmware updates"""

    def __init__(self, socketio, log_dir):
        """Initialize update manager with socket.io for real-time updates"""
        self.socketio = socketio
        self.log_dir = log_dir
        os.makedirs(self.log_dir, exist_ok=True)
        self._lock = threading.Lock()
        self.update_in_progress = False
        self.current_status = self._new_status("idle", 0)
        self.devices_list = []

        # Use the script from the parent directory's scripts folder
        self.script_dir = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '../scripts'))
        self.update_script = os.path.join(self.script_dir, 'mcumgr-update-all.sh')

        # Ensure the script directory exists
        if not os.path.exists(self.script_dir):
            logger.warning(f"Script directory not found: {self.script_dir}")

    @staticmethod
    def _new_status(state, total_devices, log_file=None):
        return {
            "state": state,
            "current_device": None,
            "total_devices": total_devices,
            "completed_devices": 0,
            "successful_updates": 0,
            "failed_updates": 0,
            "skipped_updates": 0,
            "upload_progress": 0,
            "log_file": log_file,
            "last_update": datetime.now().isoformat()
        }

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
        """Start the update process for the given (already validated) devices.

        The update script runs in its non-interactive mode; every setting is passed through
        HACOAP_* environment variables, never through a shell command line."""
        with self._lock:
            if self.update_in_progress:
                logger.warning("Update already in progress")
                return {"success": False, "error": "Update already in progress"}
            self.update_in_progress = True

        log_name = datetime.now().strftime('update_%Y%m%d_%H%M%S.log')
        self.current_status = self._new_status("updating", len(devices), log_name)

        logger.info(f"Starting update for {len(devices)} devices with build_dir={build_dir}, mode={update_mode}")
        self.emit_status_update(f"Starting update for {len(devices)} devices")

        env = os.environ.copy()
        env.update({
            "HACOAP_NON_INTERACTIVE": "true",
            "HACOAP_CONNECTION": "UDP",
            "HACOAP_DEVICES": " ".join(f"{d['name']}={d['address']}" for d in devices),
            "HACOAP_BUILD_DIR": build_dir,
            "HACOAP_UPDATE_MODE": update_mode,
            "HACOAP_STALL_TIMEOUT": str(stall_timeout),
        })

        try:
            with open(os.path.join(self.log_dir, log_name), 'w') as log_file:
                process = subprocess.Popen(
                    ["bash", self.update_script],
                    cwd=self.script_dir,
                    env=env,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    bufsize=1
                )

                # Monitor process output for progress updates
                for line in iter(process.stdout.readline, ''):
                    line = line.rstrip()
                    log_file.write(line + '\n')
                    log_file.flush()

                    self._parse_line(line)
                    self.current_status["last_update"] = datetime.now().isoformat()
                    self.emit_status_update(line)
                    logger.debug(line)

                returncode = process.wait()

            # Update final status
            if returncode == 0:
                self.current_status["state"] = "completed"
                self.current_status["upload_progress"] = 100
                self.emit_status_update("Update process completed")
            else:
                self.current_status["state"] = "error"
                self.emit_status_update(f"Update script exited with code {returncode}")

        except Exception as e:
            logger.error(f"Error during update process: {str(e)}")
            self.current_status["state"] = "error"
            self.emit_status_update(f"Error during update: {str(e)}")

        finally:
            self.update_in_progress = False

    def _parse_line(self, line):
        """Update the status from one line of script output"""
        # Track current device being processed
        device_match = re.search(r'===== Processing device: (\S+)', line)
        if device_match:
            self.current_status["current_device"] = device_match.group(1)
            self.current_status["upload_progress"] = 0

        # Track upload progress
        progress_match = re.search(r'(\d+\.\d+) KiB / (\d+\.\d+) KiB .* (\d+\.\d+)%', line)
        if progress_match:
            self.current_status["upload_progress"] = float(progress_match.group(3))

        # One RESULT line per device: success, skipped or failed
        result_match = re.search(r'RESULT (\S+) (success|skipped|failed)\b', line)
        if result_match:
            counter = {
                "success": "successful_updates",
                "skipped": "skipped_updates",
                "failed": "failed_updates",
            }[result_match.group(2)]
            self.current_status[counter] += 1
            self.current_status["completed_devices"] += 1

    def get_status(self):
        """Get the current update status"""
        return self.current_status

    def get_log_files(self):
        """Get list of available log files, newest first"""
        log_files = [f for f in os.listdir(self.log_dir) if LOG_FILE_RE.match(f)]
        return sorted(log_files, key=lambda f: os.path.getmtime(os.path.join(self.log_dir, f)), reverse=True)

    def read_log(self, log_file):
        """Return the contents of one of our log files, or None if it isn't one"""
        if not LOG_FILE_RE.match(os.path.basename(log_file)) or os.path.basename(log_file) != log_file:
            return None
        path = os.path.join(self.log_dir, log_file)
        if not os.path.isfile(path):
            return None
        with open(path, 'r') as f:
            return f.read()

    def emit_status_update(self, message):
        """Emit a status update via socket.io"""
        self.socketio.emit('status_update', {
            'message': message,
            'status': self.current_status
        })
