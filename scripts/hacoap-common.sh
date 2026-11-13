# Shared helpers for the mcumgr scripts. Sourced, not run.
#
# Works with bash 3.2 (macOS), bash 4+/5 (Linux) and Git Bash (Windows): no associative
# arrays, and no GNU-only tools (timeout, stat -c, bc, pgrep). OS-specific work (device
# discovery, serial ports, image hashes, stall detection) is in hacoap_tools.py.

HACOAP_SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HACOAP_DEFAULT_BUILD_DIR="$HACOAP_SCRIPTS_DIR/../application/build"

case "$(uname -s)" in
    Darwin) HACOAP_OS="macos" ;;
    MINGW*|MSYS*|CYGWIN*) HACOAP_OS="windows" ;;
    *) HACOAP_OS="linux" ;;
esac

# Finds a Python 3.7+ interpreter and stores the command in the PYTHON array.
# On Windows, 'python3' can be the Microsoft Store placeholder, so every candidate is run.
PYTHON=()
function find_python() {
    local candidate
    for candidate in python3 python "py -3"; do
        # shellcheck disable=SC2086
        if command -v ${candidate%% *} > /dev/null 2>&1 &&
           $candidate -c 'import sys; sys.exit(0 if sys.version_info >= (3, 7) else 1)' > /dev/null 2>&1; then
            # shellcheck disable=SC2206
            PYTHON=($candidate)
            return 0
        fi
    done
    return 1
}

# Runs hacoap_tools.py (see its --help) with the interpreter found by find_python.
function hacoap_tools() {
    "${PYTHON[@]}" "$HACOAP_SCRIPTS_DIR/hacoap_tools.py" "$@"
}

# Stops a background process this shell started, and its children. On Windows, 'kill'
# only stops Git Bash's handle on a native program such as mcumgr.exe or python.exe,
# and the program keeps running, so it's stopped through its Windows process ID.
function stop_process() {
    local pid="$1" winpid
    [ -n "$pid" ] || return 0
    if [ "$HACOAP_OS" = "windows" ] && winpid=$(cat "/proc/$pid/winpid" 2> /dev/null); then
        taskkill //F //T //PID "$winpid" > /dev/null 2>&1
    fi
    kill -9 "$pid" 2> /dev/null
    wait "$pid" 2> /dev/null
    return 0
}

# Prints the size of a file in bytes.
function file_size() {
    local size
    size=$(wc -c < "$1" 2> /dev/null) || return 1
    echo $((size))
}

# Prints "<bytes> / 1024" with two decimals.
function format_kib() {
    awk -v bytes="$1" 'BEGIN { printf "%.2f", bytes / 1024 }'
}

# Serial port names mcumgr accepts: COM7 (Windows), /dev/ttyACM0 (Linux), /dev/cu.usbmodem1101 (macOS).
function is_valid_serial_port() {
    [[ "$1" =~ ^COM[0-9]+$ ]] || [[ "$1" =~ ^/dev/(tty|cu)[A-Za-z0-9._-]+$ ]]
}

# IPv6 address, without brackets or zone.
function is_valid_ipv6() {
    [[ "$1" =~ ^[0-9A-Fa-f:]+$ ]] && [[ "$1" == *:* ]]
}

# Prints how to install a dependency on this OS.
function install_hint() {
    case "$1:$HACOAP_OS" in
        mcumgr:*) echo "Install Go (https://go.dev/dl/), then: go install github.com/apache/mynewt-mcumgr-cli/mcumgr@latest (and add Go's bin directory to PATH)" ;;
        python:windows) echo "winget install Python.Python.3.12 (or https://www.python.org/downloads/)" ;;
        python:macos) echo "xcode-select --install, or brew install python" ;;
        python:*) echo "sudo apt install python3 (or your distribution's package)" ;;
        discovery:linux) echo "sudo apt install avahi-utils (or python3-zeroconf)" ;;
        discovery:macos) echo "python3 -m pip install --user zeroconf" ;;
        discovery:windows) echo "py -m pip install zeroconf" ;;
    esac
}
