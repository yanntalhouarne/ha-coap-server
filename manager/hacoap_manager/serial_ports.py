"""USB serial ports, with the boards (Nordic's USB vendor ID) first."""

NORDIC_USB_VID = 0x1915


def list_ports():
    from serial.tools import list_ports as pyserial_ports

    ports = []
    for port in pyserial_ports.comports():
        ports.append({
            "port": port.device,
            "description": port.description or "",
            "serial_number": port.serial_number or "",
            "board": port.vid == NORDIC_USB_VID,
        })
    ports.sort(key=lambda p: (not p["board"], p["port"]))
    return ports
