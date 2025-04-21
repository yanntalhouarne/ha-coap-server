#!/usr/bin/env python3
# app.py - Main Flask application for firmware updates

from flask import Flask, render_template, request, jsonify, redirect, url_for
from flask_socketio import SocketIO, emit
import os
import subprocess
import logging
import threading
from update_manager import UpdateManager
import time
import json

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler("web_updater.log"),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

# Initialize Flask app
app = Flask(__name__)
app.config['SECRET_KEY'] = 'firmware-updater-secret-key'
socketio = SocketIO(app)

# Create update manager
update_manager = UpdateManager(socketio)

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
    build_dir = request.args.get('build_dir', '../application/build')
    return render_template('update.html', build_dir=build_dir)

# API Endpoints
@app.route('/api/discover', methods=['POST'])
def discover_devices():
    """API endpoint to discover devices"""
    try:
        devices = update_manager.discover_devices()
        return jsonify({"success": True, "devices": devices})
    except Exception as e:
        logger.error(f"Error discovering devices: {str(e)}")
        return jsonify({"success": False, "error": str(e)})

@app.route('/api/start_update', methods=['POST'])
def start_update():
    """API endpoint to start the update process"""
    try:
        data = request.json
        device_list = data.get('devices', [])
        build_dir = data.get('build_dir', '../application/build')
        update_mode = data.get('update_mode', 'confirm')
        stall_timeout = data.get('stall_timeout', 300)
        
        # Validate inputs
        if not device_list:
            return jsonify({"success": False, "error": "No devices selected"})
        
        if not os.path.isdir(build_dir):
            return jsonify({"success": False, "error": f"Build directory not found: {build_dir}"})
            
        image_path = os.path.join(build_dir, "zephyr/app_update.bin")
        if not os.path.isfile(image_path):
            return jsonify({"success": False, "error": f"Firmware image not found: {image_path}"})
        
        # Start update in a background thread
        update_thread = threading.Thread(
            target=update_manager.start_update,
            args=(device_list, build_dir, update_mode, stall_timeout)
        )
        update_thread.daemon = True
        update_thread.start()
        
        return jsonify({"success": True, "message": "Update process started"})
    except Exception as e:
        logger.error(f"Error starting update: {str(e)}")
        return jsonify({"success": False, "error": str(e)})

@app.route('/api/update_status', methods=['GET'])
def update_status():
    """API endpoint to get the current update status"""
    status = update_manager.get_status()
    return jsonify(status)

@app.route('/api/logs', methods=['GET'])
def get_logs():
    """API endpoint to retrieve update logs"""
    try:
        log_file = request.args.get('log_file')
        if log_file and os.path.isfile(log_file):
            with open(log_file, 'r') as f:
                logs = f.read()
            return jsonify({"success": True, "logs": logs})
        else:
            # Get the most recent log file
            log_files = update_manager.get_log_files()
            if log_files:
                with open(log_files[0], 'r') as f:
                    logs = f.read()
                return jsonify({"success": True, "logs": logs, "log_file": log_files[0]})
            else:
                return jsonify({"success": False, "error": "No log files found"})
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
    # Define script directory path (in parent directory)
    script_dir = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '../scripts'))
    
    # Make sure script directory exists
    if not os.path.exists(script_dir):
        logger.warning(f"Script directory not found: {script_dir}")
        os.makedirs(script_dir, exist_ok=True)
        logger.info(f"Created script directory: {script_dir}")
    
    # Check if update script exists
    script_path = os.path.join(script_dir, 'mcumgr-update-all.sh')
    if os.path.exists(script_path):
        # Ensure the update script is executable
        os.chmod(script_path, 0o755)  # Set executable permission
        logger.info(f"Found update script: {script_path}")
    else:
        logger.warning(f"Update script not found: {script_path}")
        logger.info("Please copy your update script to the ../scripts directory")
    
    # Start the app
    logger.info("Starting Firmware Update Web Interface")
    socketio.run(app, host='0.0.0.0', port=5000, debug=True)