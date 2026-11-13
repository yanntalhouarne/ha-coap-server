#!/usr/bin/env python3
# update_manager.py - Interface between the web app and the update scripts
#
# Works on Linux, macOS and Windows. Updates run scripts/mcumgr-update-all.sh in its
# non-interactive mode (with Git Bash on Windows); discovery, image hashes and the like use
# scripts/hacoap_tools.py, the same helper the scripts use.

import logging
import os
import platform
import re
import shutil
import subprocess
import sys
import threading
from datetime import datetime
from pathlib import Path

logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent
SCRIPTS_DIR = (BASE_DIR / '..' / 'scripts').resolve()
UPDATE_SCRIPT = SCRIPTS_DIR / 'mcumgr-update-all.sh'
TOOLS_SCRIPT = SCRIPTS_DIR / 'hacoap_tools.py'

sys.path.insert(0, str(SCRIPTS_DIR))
import hacoap_tools  # noqa: E402

# Per-run logs written by this manager: update_YYYYmmdd_HHMMSS.log
LOG_FILE_RE = re.compile(r'^update_\d{8}_\d{6}\.log$')
RESULT_RE = re.compile(r'RESULT (\S+) (success|skipped|failed)\b')
DISCOVERY_TIMEOUT_S = 3


def find_bash():
    """Path of the bash that runs the update script, or None.

    On Windows this must be Git Bash: C:\\Windows\\System32\\bash.exe starts WSL instead,
    where mcumgr and the build directory aren't available. HACOAP_BASH overrides it."""
    override = os.environ.get('HACOAP_BASH')
    if override:
        return override
    if os.name != 'nt':
        return shutil.which('bash')

    candidates = []
    git = shutil.which('git')
    if git:
        git_root = Path(git).resolve().parent.parent  # ...\Git\cmd\git.exe -> ...\Git
        candidates.append(git_root / 'bin' / 'bash.exe')
    for base in (os.environ.get('ProgramFiles'), os.environ.get('ProgramW6432'),
                 os.environ.get('ProgramFiles(x86)'),
                 os.path.join(os.environ.get('LOCALAPPDATA', ''), 'Programs')):
        if base:
            candidates.append(Path(base) / 'Git' / 'bin' / 'bash.exe')
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)

    bash = shutil.which('bash')
    if bash and 'system32' not in bash.lower():
        return bash
    return None


def discovery_method():
    """'zeroconf', 'avahi-browse' or None, as used by hacoap_tools.py discover."""
    try:
        import zeroconf  # noqa: F401
        return 'zeroconf'
    except ImportError:
        return 'avahi-browse' if shutil.which('avahi-browse') else None


class UpdateManager:
    """Runs discovery and updates, and tracks the status of the current update"""

    def __init__(self, socketio, log_dir):
        """Initialize update manager with socket.io for real-time updates"""
        self.socketio = socketio
        self.log_dir = log_dir
        os.makedirs(self.log_dir, exist_ok=True)
        self._lock = threading.Lock()
        self.update_in_progress = False
        self.current_status = self._new_status("idle", 0)
        self.update_script = str(UPDATE_SCRIPT)

        if not UPDATE_SCRIPT.is_file():
            logger.warning(f"Update script not found: {UPDATE_SCRIPT}")

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

    # ------------------------------------------------------------ system checks

    def system_status(self):
        """What the updater needs, and whether this computer has it"""
        bash = find_bash()
        return {
            "os": platform.system(),
            "python": platform.python_version(),
            "update_script": UPDATE_SCRIPT.is_file(),
            "bash": bash,
            "mcumgr": shutil.which('mcumgr'),
            "discovery": discovery_method(),
            "ready": bool(UPDATE_SCRIPT.is_file() and bash and shutil.which('mcumgr')),
        }

    @staticmethod
    def image_info(build_dir):
        """Size, hash and build time of the update image in an (already resolved) build directory"""
        image = os.path.join(build_dir, 'zephyr', 'app_update.bin')
        stat = os.stat(image)
        return {
            "path": image,
            "size": stat.st_size,
            "hash": hacoap_tools.image_hash(image),
            "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(timespec='seconds'),
        }

    # ---------------------------------------------------------------- discovery

    def discover_devices(self):
        """Find devices with hacoap_tools.py discover.

        Returns (devices, available): available is False when this computer has no
        discovery method (no zeroconf package, and no avahi-browse)."""
        logger.info("Discovering devices...")
        result = subprocess.run(
            [sys.executable, str(TOOLS_SCRIPT), 'discover', '--timeout', str(DISCOVERY_TIMEOUT_S)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8',
            errors='replace', timeout=DISCOVERY_TIMEOUT_S + 30)
        if result.returncode == 3:
            logger.warning(result.stderr.strip())
            return [], False
        if result.returncode != 0:
            raise RuntimeError(result.stderr.strip() or f"discovery failed ({result.returncode})")

        devices = []
        for line in result.stdout.splitlines():
            name, _, address = line.partition('\t')
            if address:
                devices.append({"name": name, "address": address, "selected": True})
        logger.info(f"Discovered {len(devices)} devices")
        return devices, True

    # ------------------------------------------------------------------ updates

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
            bash = find_bash()
            if bash is None:
                raise RuntimeError("bash not found (on Windows, install Git for Windows)")

            with open(os.path.join(self.log_dir, log_name), 'w', encoding='utf-8') as log_file:
                process = subprocess.Popen(
                    [bash, str(UPDATE_SCRIPT)],
                    cwd=str(SCRIPTS_DIR),
                    env=env,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    encoding='utf-8',
                    errors='replace',
                    bufsize=1
                )

                # Monitor process output for progress updates. Text mode also splits on the
                # carriage returns the script uses to redraw its progress bar.
                for line in iter(process.stdout.readline, ''):
                    line = line.rstrip()
                    if not line:
                        continue
                    log_file.write(line + '\n')
                    log_file.flush()

                    self._parse_line(line)
                    self.current_status["last_update"] = datetime.now().isoformat()
                    self.emit_status_update(line)

                returncode = process.wait()

            # Update final status
            if returncode == 0:
                self.current_status["state"] = "completed"
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

        # Track upload progress ("[PROGRESS] Upload progress: 42%")
        progress_match = re.search(r'Upload progress: (\d+)%', line)
        if progress_match:
            self.current_status["upload_progress"] = min(100, int(progress_match.group(1)))
        if 'Upload completed successfully' in line:
            self.current_status["upload_progress"] = 100

        # One RESULT line per device: success, skipped or failed
        result_match = RESULT_RE.search(line)
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

    # --------------------------------------------------------------------- logs

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
        with open(path, 'r', encoding='utf-8', errors='replace') as f:
            return f.read()

    def statistics(self):
        """Totals over all update logs: one RESULT line per device update"""
        stats = {"runs": 0, "devices": 0, "success": 0, "skipped": 0, "failed": 0, "last_run": None}
        for log_file in self.get_log_files():
            stats["runs"] += 1
            for match in RESULT_RE.finditer(self.read_log(log_file) or ''):
                stats["devices"] += 1
                stats[match.group(2)] += 1
        log_files = self.get_log_files()
        if log_files:
            mtime = os.path.getmtime(os.path.join(self.log_dir, log_files[0]))
            stats["last_run"] = datetime.fromtimestamp(mtime).isoformat(timespec='seconds')
        return stats

    def emit_status_update(self, message):
        """Emit a status update via socket.io"""
        self.socketio.emit('status_update', {
            'message': message,
            'status': self.current_status
        })
