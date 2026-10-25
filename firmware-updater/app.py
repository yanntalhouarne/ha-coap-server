#!/usr/bin/env python3
# app.py - Web interface for over-the-air firmware updates (Linux, macOS and Windows)
#
# Run: python app.py, then open http://127.0.0.1:5000. See README.md.

from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO
import ipaddress
import os
import re
import logging
import secrets
import threading
from update_manager import UpdateManager

# Server settings. The updater can flash firmware onto every device it can reach, so it
# only listens on localhost unless HACOAP_UPDATER_HOST says otherwise (e.g. 0.0.0.0).
HOST = os.environ.get('HACOAP_UPDATER_HOST', '127.0.0.1')
PORT = int(os.environ.get('HACOAP_UPDATER_PORT', '5000'))
DEBUG = os.environ.get('HACOAP_UPDATER_DEBUG', '').lower() in ('1', 'true', 'yes')

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_DIR = os.environ.get('HACOAP_UPDATER_LOG_DIR') or os.path.join(BASE_DIR, 'logs')
DEFAULT_BUILD_DIR = '../application/build'

# Request validation
DEVICE_NAME_RE = re.compile(r'^[A-Za-z0-9._-]+$')
UPDATE_MODES = ('test', 'confirm')
MAX_STALL_TIMEOUT_S = 3600

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler(os.path.join(BASE_DIR, 'web_updater.log')),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

# Initialize Flask app. Socket.IO runs on plain threads (no eventlet/gevent), which works
# on every OS and Python version, and is plenty for a single-user local tool.
app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ.get('HACOAP_UPDATER_SECRET_KEY') or secrets.token_hex(32)
socketio = SocketIO(app, async_mode='threading')

# Create update manager
update_manager = UpdateManager(socketio, LOG_DIR)


def resolve_build_dir(build_dir):
    """Return the absolute build directory, or raise ValueError if it has no update image.

    Relative paths are resolved against this directory, not the server's working directory."""
    path = os.path.realpath(os.path.join(BASE_DIR, build_dir))
    if not os.path.isdir(path):
        raise ValueError(f"Build directory not found: {build_dir}")
    if not os.path.isfile(os.path.join(path, 'zephyr', 'app_update.bin')):
        raise ValueError(f"Firmware image not found: {os.path.join(build_dir, 'zephyr', 'app_update.bin')}")
    return path


def validate_devices(device_list):
    """Return [{'name', 'address'}] for the requested devices, or raise ValueError."""
    if not isinstance(device_list, list) or not device_list:
        raise ValueError("No devices selected")

    devices = []
    for device in device_list:
        if not isinstance(device, dict):
            raise ValueError("Invalid device entry")
        name = str(device.get('name', ''))
        address = str(device.get('address', ''))
        if not DEVICE_NAME_RE.match(name):
            raise ValueError(f"Invalid device name: {name!r}")
        try:
            address = str(ipaddress.IPv6Address(address))
        except ValueError:
            raise ValueError(f"Invalid IPv6 address: {address!r}")
        if not re.fullmatch(r'[0-9a-f:]+', address):
            raise ValueError(f"Unsupported IPv6 address: {address!r}")
        devices.append({"name": name, "address": address})
    return devices


def validate_stall_timeout(value):
    """Return the stall timeout in seconds, or raise ValueError."""
    try:
        timeout = int(value)
    except (TypeError, ValueError):
        raise ValueError(f"Invalid stall timeout: {value!r}")
    if not 0 <= timeout <= MAX_STALL_TIMEOUT_S:
        raise ValueError(f"Stall timeout must be between 0 and {MAX_STALL_TIMEOUT_S} seconds")
    return timeout


# Routes
@app.route('/')
def index():
    """Render the dashboard page"""
    return render_template('index.html')

@app.route('/devices')
def devices():
    """Render the device management page"""
    return render_template('devices.html')

@app.route('/update')
def update():
    """Render the update page"""
    build_dir = request.args.get('build_dir', DEFAULT_BUILD_DIR)
    return render_template('update.html', build_dir=build_dir)

# API Endpoints
@app.route('/api/system_status', methods=['GET'])
def system_status():
    """API endpoint for what the updater needs (bash, mcumgr, discovery) and what's found"""
    return jsonify(update_manager.system_status())

@app.route('/api/check_build_dir', methods=['GET'])
def check_build_dir():
    """API endpoint to check a build directory and describe its update image"""
    build_dir = request.args.get('build_dir', DEFAULT_BUILD_DIR)
    try:
        info = update_manager.image_info(resolve_build_dir(build_dir))
    except (OSError, ValueError) as e:
        return jsonify({"success": False, "error": str(e)})
    return jsonify({"success": True, "image": info})

@app.route('/api/stats', methods=['GET'])
def stats():
    """API endpoint for update statistics, counted from the update logs"""
    return jsonify(update_manager.statistics())

@app.route('/api/discover', methods=['POST'])
def discover_devices():
    """API endpoint to discover devices"""
    try:
        devices, available = update_manager.discover_devices()
        return jsonify({"success": True, "devices": devices, "discovery_available": available})
    except Exception as e:
        logger.error(f"Error discovering devices: {str(e)}")
        return jsonify({"success": False, "error": str(e)})

@app.route('/api/start_update', methods=['POST'])
def start_update():
    """API endpoint to start the update process"""
    try:
        data = request.get_json(silent=True) or {}
        device_list = validate_devices(data.get('devices', []))
        build_dir = resolve_build_dir(data.get('build_dir', DEFAULT_BUILD_DIR))
        update_mode = data.get('update_mode', 'test')
        if update_mode not in UPDATE_MODES:
            raise ValueError(f"Invalid update mode: {update_mode!r}")
        stall_timeout = validate_stall_timeout(data.get('stall_timeout', 300))
    except ValueError as e:
        return jsonify({"success": False, "error": str(e)})

    if update_manager.update_in_progress:
        return jsonify({"success": False, "error": "Update already in progress"})

    # Start update in a background thread
    update_thread = threading.Thread(
        target=update_manager.start_update,
        args=(device_list, build_dir, update_mode, stall_timeout)
    )
    update_thread.daemon = True
    update_thread.start()

    return jsonify({"success": True, "message": "Update process started"})

@app.route('/api/update_status', methods=['GET'])
def update_status():
    """API endpoint to get the current update status"""
    status = update_manager.get_status()
    return jsonify(status)

@app.route('/api/logs', methods=['GET'])
def get_logs():
    """API endpoint to retrieve update logs (only files from the updater's log directory)"""
    try:
        log_file = request.args.get('log_file')
        if not log_file:
            log_files = update_manager.get_log_files()
            if not log_files:
                return jsonify({"success": False, "error": "No log files found"})
            log_file = log_files[0]

        logs = update_manager.read_log(log_file)
        if logs is None:
            return jsonify({"success": False, "error": "Log file not found"})
        return jsonify({"success": True, "logs": logs, "log_file": log_file})
    except Exception as e:
        logger.error(f"Error retrieving logs: {str(e)}")
        return jsonify({"success": False, "error": str(e)})

@app.route('/api/log_files', methods=['GET'])
def get_log_files():
    """API endpoint to get a list of available log files"""
    try:
        log_files = update_manager.get_log_files()
        return jsonify({"success": True, "log_files": log_files})
    except Exception as e:
        logger.error(f"Error retrieving log files: {str(e)}")
        return jsonify({"success": False, "error": str(e)})

# WebSocket events
@socketio.on('connect')
def handle_connect():
    logger.info("Client connected")

@socketio.on('disconnect')
def handle_disconnect():
    logger.info("Client disconnected")

# Main execution
if __name__ == '__main__':
    script_path = update_manager.update_script
    if os.path.exists(script_path):
        logger.info(f"Found update script: {script_path}")
    else:
        logger.warning(f"Update script not found: {script_path}")

    if HOST not in ('127.0.0.1', 'localhost', '::1'):
        logger.warning(f"Listening on {HOST}: anyone who can reach this port can flash your devices")

    # Start the app. Werkzeug's server is fine for this local, single-user tool.
    logger.info(f"Starting Firmware Update Web Interface on http://{HOST}:{PORT}")
    socketio.run(app, host=HOST, port=PORT, debug=DEBUG, allow_unsafe_werkzeug=True)
