#!/usr/bin/env python3
"""Cross-platform helpers for the mcumgr update scripts (Linux, macOS, Windows).

Usage: hacoap_tools.py <command> [arguments]

  discover [--timeout S]       Find ha-coap devices on the network (mDNS/DNS-SD).
                               Prints "<name><TAB><IPv6 address>" per device.
                               Uses the 'zeroconf' package if installed
                               (pip install zeroconf), else avahi-browse (Linux).
                               Exit code 3 if neither is available.
  serial-ports                 List serial ports, the board's (USB VID 0x1915) first.
                               Prints "<port><TAB><description><TAB><1 if the board's,
                               else 0>" per port. Without pyserial on Linux and macOS,
                               the board can't be told apart and every port reads 0.
                               Uses 'pyserial' if installed, else OS-specific lookups.
  image-hash <image.bin>       Print the SHA-256 hash MCUboot reports for an image.
  stall-monitor <file> <secs>  Watch an mcumgr upload log; when the progress stops
                               changing for <secs> seconds, write <file>.stalled
                               ("<value>|<seconds>") and exit. Exits when <file>
                               is removed or the upload finishes.

Needs Python 3.7 or newer and nothing else.
"""

import glob
import os
import re
import shutil
import struct
import subprocess
import sys
import time

SERVICE_TYPE = "_ot._udp.local."
NAME_PREFIX = "ha-coap"
NORDIC_USB_VID = 0x1915


def _is_usable_ipv6(address):
    """Global or unique-local IPv6 address (not link-local or loopback)."""
    address = address.split("%")[0].lower()
    return ":" in address and not address.startswith("fe80") and address != "::1"


# ---------------------------------------------------------------- discover

def _discover_zeroconf(timeout):
    from zeroconf import IPVersion, ServiceBrowser, Zeroconf  # optional dependency

    names = []

    class Listener:
        def add_service(self, zc, type_, name):
            if name not in names:
                names.append(name)

        def update_service(self, zc, type_, name):
            pass

        def remove_service(self, zc, type_, name):
            pass

    zc = Zeroconf()
    try:
        ServiceBrowser(zc, SERVICE_TYPE, Listener())
        time.sleep(timeout)
        devices = []
        for name in list(names):
            short = name[: -len("." + SERVICE_TYPE)] if name.endswith("." + SERVICE_TYPE) else name
            if not short.startswith(NAME_PREFIX):
                continue
            info = zc.get_service_info(SERVICE_TYPE, name, timeout=2000)
            if info is None:
                continue
            addresses = [a for a in info.parsed_addresses(IPVersion.V6Only) if _is_usable_ipv6(a)]
            if addresses:
                devices.append((short, addresses[0]))
        return devices
    finally:
        zc.close()


def _discover_avahi(timeout):
    try:
        result = subprocess.run(
            ["avahi-browse", "--resolve", "--parsable", "--terminate", "_ot._udp"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=timeout + 5,
            universal_newlines=True)
        output = result.stdout
    except subprocess.TimeoutExpired as exc:
        output = exc.stdout.decode() if isinstance(exc.stdout, bytes) else (exc.stdout or "")
    devices = []
    seen = set()
    for line in output.splitlines():
        # =;interface;protocol;name;type;domain;hostname;address;port;txt
        fields = line.split(";")
        if len(fields) < 9 or fields[0] != "=" or fields[2] != "IPv6":
            continue
        name, address = fields[3], fields[7]
        if not name.startswith(NAME_PREFIX) or name in seen or not _is_usable_ipv6(address):
            continue
        seen.add(name)
        devices.append((name, address))
    return devices


def cmd_discover(args):
    timeout = 3.0
    if len(args) >= 2 and args[0] == "--timeout":
        timeout = float(args[1])
    # For scripts/tests: fixed results, as space-separated "name=address" entries
    if "HACOAP_TEST_DEVICES" in os.environ:
        for entry in os.environ["HACOAP_TEST_DEVICES"].split():
            name, _, address = entry.partition("=")
            print("{}\t{}".format(name, address))
        return 0
    try:
        devices = _discover_zeroconf(timeout)
    except ImportError:
        if shutil.which("avahi-browse"):
            devices = _discover_avahi(timeout)
        else:
            print("No discovery method: install the zeroconf package (pip install zeroconf)"
                  " or, on Linux, avahi-utils.", file=sys.stderr)
            return 3
    for name, address in sorted(devices):
        print("{}\t{}".format(name, address))
    return 0


# ------------------------------------------------------------ serial-ports

def _ports_pyserial():
    from serial.tools import list_ports  # optional dependency

    ports = []
    for port in list_ports.comports():
        board = port.vid == NORDIC_USB_VID
        ports.append((not board, port.device, port.description or ""))
    return ports


def _ports_windows():
    script = ("Get-CimInstance Win32_PnPEntity | Where-Object { $_.Name -match '\\(COM[0-9]+\\)' } | "
              "ForEach-Object { $_.Name + '|' + $_.PNPDeviceID }")
    try:
        output = subprocess.run(["powershell", "-NoProfile", "-Command", script],
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                universal_newlines=True, timeout=20).stdout
    except (OSError, subprocess.TimeoutExpired):
        return []
    ports = []
    for line in output.splitlines():
        if "|" not in line:
            continue
        name, device_id = line.rsplit("|", 1)
        match = re.search(r"\((COM[0-9]+)\)", name)
        if match:
            board = "VID_{:04X}".format(NORDIC_USB_VID) in device_id.upper()
            description = name.replace(match.group(0), "").strip()
            ports.append((not board, match.group(1), description))
    return ports


def _ports_glob(patterns):
    return [(False, path, "") for pattern in patterns for path in sorted(glob.glob(pattern))]


def cmd_serial_ports(args):
    # For scripts/tests: fixed results, as ";"-separated "port,description,board" entries
    if "HACOAP_TEST_SERIAL_PORTS" in os.environ:
        for entry in filter(None, os.environ["HACOAP_TEST_SERIAL_PORTS"].split(";")):
            print("\t".join(entry.split(",")))
        return 0
    try:
        ports = _ports_pyserial()
    except ImportError:
        if sys.platform.startswith("win"):
            ports = _ports_windows()
        elif sys.platform == "darwin":
            ports = _ports_glob(["/dev/cu.usbmodem*", "/dev/cu.usbserial*"])
        else:
            ports = _ports_glob(["/dev/ttyACM*", "/dev/ttyUSB*"])

    def port_key(entry):
        number = re.search(r"([0-9]+)$", entry[1])
        return (entry[0], entry[1].rstrip("0123456789"), int(number.group(1)) if number else -1)

    for not_board, device, description in sorted(ports, key=port_key):
        print("{}\t{}\t{}".format(device, description, 0 if not_board else 1))
    return 0


# -------------------------------------------------------------- image-hash

IMAGE_MAGIC = 0x96F3B83D
TLV_INFO_MAGIC = 0x6907
TLV_PROT_INFO_MAGIC = 0x6908
TLV_SHA256 = 0x10


def image_hash(path):
    with open(path, "rb") as f:
        data = f.read()
    magic, = struct.unpack_from("<I", data, 0)
    if magic != IMAGE_MAGIC:
        raise ValueError("{} is not an MCUboot image".format(path))
    header_size, = struct.unpack_from("<H", data, 8)
    image_size, = struct.unpack_from("<I", data, 12)
    offset = header_size + image_size
    while offset + 4 <= len(data):
        info_magic, total = struct.unpack_from("<HH", data, offset)
        if info_magic not in (TLV_INFO_MAGIC, TLV_PROT_INFO_MAGIC):
            break
        end = offset + total
        tlv = offset + 4
        while tlv + 4 <= end:
            tlv_type, tlv_len = struct.unpack_from("<BxH", data, tlv)
            if tlv_type == TLV_SHA256:
                return data[tlv + 4: tlv + 4 + tlv_len].hex()
            tlv += 4 + tlv_len
        offset = end
    raise ValueError("No SHA-256 TLV in {}".format(path))


def cmd_image_hash(args):
    if len(args) != 1:
        print("Usage: hacoap_tools.py image-hash <image.bin>", file=sys.stderr)
        return 2
    try:
        print(image_hash(args[0]))
    except (OSError, ValueError, struct.error) as exc:
        print("Error: {}".format(exc), file=sys.stderr)
        return 1
    return 0


# ----------------------------------------------------------- stall-monitor

PROGRESS_RE = re.compile(r"([0-9]+\.?[0-9]*)\s*(B|KiB)\s*/\s*[0-9]+\.?[0-9]*\s*KiB")


def cmd_stall_monitor(args):
    if len(args) != 2:
        print("Usage: hacoap_tools.py stall-monitor <file> <seconds>", file=sys.stderr)
        return 2
    path, timeout = args[0], int(args[1])
    last_value = None
    unchanged_for = 0
    while True:
        time.sleep(1)
        if not os.path.exists(path):
            return 0
        try:
            with open(path, "r", errors="replace") as f:
                text = f.read()
        except OSError:
            continue
        if "Done" in text:
            return 0
        # mcumgr redraws its progress line with carriage returns
        matches = PROGRESS_RE.findall(text.replace("\r", "\n"))
        if not matches:
            continue
        value = matches[-1][0] + matches[-1][1]
        if value != last_value:
            last_value = value
            unchanged_for = 0
            continue
        unchanged_for += 1
        if unchanged_for >= timeout:
            with open(path + ".stalled", "w") as f:
                f.write("{}|{}".format(value, unchanged_for))
            return 0


COMMANDS = {
    "discover": cmd_discover,
    "serial-ports": cmd_serial_ports,
    "image-hash": cmd_image_hash,
    "stall-monitor": cmd_stall_monitor,
}


def main(argv):
    # bash reads the output: plain "\n" line endings, also on Windows
    sys.stdout.reconfigure(newline="\n")
    if len(argv) < 2 or argv[1] not in COMMANDS:
        print(__doc__, file=sys.stderr)
        return 2
    return COMMANDS[argv[1]](argv[2:])


if __name__ == "__main__":
    sys.exit(main(sys.argv))
