# HA-CoAP Firmware Updater

A web interface for updating firmware on Thread-based IoT devices using the mcumgr tool.

## Features

- **Device Discovery**: Automatically find HA-CoAP devices on your Thread network
- **Batch Updates**: Update multiple devices in one operation
- **Progress Monitoring**: Track updates in real-time with progress bars and logs
- **Stall Detection**: Automatically detect and handle stalled uploads
- **Update History**: View logs of previous update operations

## Requirements

- Python 3.7+
- Flask and Flask-SocketIO
- mcumgr tool
- avahi-browse (for device discovery)

## Installation

1. Clone this repository:
   ```
   git clone https://github.com/yourusername/ha-coap-firmware-updater.git
   cd ha-coap-firmware-updater
   ```

2. Create a virtual environment and install dependencies:
   ```
   python -m venv venv
   source venv/bin/activate  # On Windows: venv\Scripts\activate
   pip install -r requirements.txt
   ```

3. Copy your update script to the parent directory's `scripts` folder:
   ```
   mkdir -p ../scripts
   cp /path/to/mcumgr-update-all.sh ../scripts/
   ```

4. Make sure the script is executable:
   ```
   chmod +x ../scripts/mcumgr-update-all.sh
   ```

## Usage

1. Start the web server:
   ```
   python app.py
   ```

2. Open your browser and navigate to:
   ```
   http://localhost:5000
   ```

3. Use the interface to discover devices, configure updates, and monitor progress.

## Configuration

- **Build Directory**: Path to the directory containing your firmware image
- **Update Mode**: Choose between "Test" (can revert) or "Confirm" (permanent)
- **Stall Timeout**: Automatically terminate uploads that stall for a specified period

## Project Structure

```
parent-directory/
├── scripts/               # Update scripts go here
│   └── mcumgr-update-all.sh  # Your update script
│
└── firmware-updater/      # Web interface
    ├── app.py             # Main Flask application
    ├── update_manager.py  # Interface between web app and update script
    ├── static/            # Static assets
    │   ├── css/           # CSS styles
    │   └── js/            # JavaScript files
    ├── templates/         # HTML templates
    └── README.md          # Documentation
```

## Modifying the Update Script

This web interface is designed to work with the mcumgr-update-all.sh script. To ensure compatibility, make sure your script:

1. Allows non-interactive mode via environment variables
2. Outputs progress information in a format compatible with the web interface
3. Logs detailed information about the update process

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Acknowledgements

- Thanks to the Zephyr Project for the mcumgr tool
- Built with Flask, Bootstrap, and Socket.IO