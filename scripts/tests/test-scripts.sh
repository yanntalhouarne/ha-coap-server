#!/bin/bash
# Tests for the mcumgr update scripts, with a fake mcumgr standing in for a device.
# Runs on Linux, macOS (bash 3.2) and Windows (Git Bash); CI runs it on all three.
#
# Usage: scripts/tests/test-scripts.sh

SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$SCRIPTS_DIR/hacoap-common.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FAILURES=0
OUTPUT="$TMP/output.txt"

case "$HACOAP_OS" in
    windows) TEST_PORT="COM3" ;;
    macos) TEST_PORT="/dev/cu.usbmodem1101" ;;
    *) TEST_PORT="/dev/ttyACM0" ;;
esac

function pass() { echo "PASS  $1"; }
function fail() {
    echo "FAIL  $1"
    sed 's/^/      | /' "$OUTPUT" | tail -n 25
    FAILURES=$((FAILURES + 1))
}
function expect_output() { # name, pattern...
    local name="$1" pattern
    shift
    for pattern in "$@"; do
        if ! grep -q -- "$pattern" "$OUTPUT" "$FAKE_MCUMGR_STATE/calls.log" 2>/dev/null; then
            fail "$name (missing: $pattern)"
            return
        fi
    done
    pass "$name"
}

# ------------------------------------------------------------------ setup

if ! find_python; then
    echo "Python 3.7+ is required"
    exit 1
fi
echo "OS: $HACOAP_OS   /bin/bash: $(/bin/bash -c 'echo $BASH_VERSION')   Python: ${PYTHON[*]}"

# A minimal signed MCUboot image whose SHA-256 TLV holds a known value
mkdir -p "$TMP/build/zephyr"
EXPECTED_HASH=$("${PYTHON[@]}" - "$TMP/build/zephyr/app_update.bin" <<'EOF'
import hashlib, struct, sys
body = b"\xa5" * 1000
digest = hashlib.sha256(body).digest()
header = struct.pack("<IIHHII", 0x96F3B83D, 0, 32, 0, len(body), 0) + bytes(12)
tlvs = struct.pack("<BxH", 0x10, 32) + digest + struct.pack("<BxH", 0x22, 8) + bytes(8)
image = header + body + struct.pack("<HH", 0x6907, 4 + len(tlvs)) + tlvs
open(sys.argv[1], "wb").write(image)
print(digest.hex())
EOF
)

# Fake mcumgr: logs its calls, prints mcumgr-style output, keeps slot hashes in files
mkdir -p "$TMP/bin"
cat > "$TMP/bin/mcumgr" <<'EOF'
#!/bin/bash
state="$FAKE_MCUMGR_STATE"
echo "$*" >> "$state/calls.log"
[ "$1" = "conn" ] && exit 0
shift 2 # -c <connection>
case "$1 $2" in
    "image list")
        echo "Images:"
        echo " image=0 slot=0"
        echo "    flags: active confirmed"
        echo "    hash: $(cat "$state/slot0")"
        if [ -f "$state/slot1" ]; then
            echo " image=0 slot=1"
            echo "    flags:"
            echo "    hash: $(cat "$state/slot1")"
        fi
        ;;
    "image upload")
        echo $$ > "$state/upload.pid"
        case "$FAKE_MCUMGR_MODE" in
            stall)
                printf '0 B / 100.00 KiB\r12.00 KiB / 100.00 KiB\r'
                # On Windows, hang in a native program, like the real mcumgr.exe
                case "$(uname -s)" in
                    MINGW*|MSYS*|CYGWIN*) ping -n 60 127.0.0.1 > /dev/null ;;
                    *) sleep 60 ;;
                esac
                ;;
            fail)
                echo "Error: NMP timeout"
                exit 1
                ;;
        esac
        for value in 25.00 50.00 75.00 100.00; do
            printf '%s KiB / 100.00 KiB\r' "$value"
            sleep 0.2
        done
        echo ""
        echo "Done"
        cp "$state/new" "$state/slot1"
        ;;
esac
exit 0
EOF
chmod +x "$TMP/bin/mcumgr"
export PATH="$TMP/bin:$PATH"

# Fresh fake device: slot 0 holds another image unless $1 says otherwise
function reset_device() {
    export FAKE_MCUMGR_STATE="$TMP/state"
    rm -rf "$FAKE_MCUMGR_STATE"
    mkdir -p "$FAKE_MCUMGR_STATE"
    echo "${1:-0000000000000000000000000000000000000000000000000000000000000000}" > "$FAKE_MCUMGR_STATE/slot0"
    echo "$EXPECTED_HASH" > "$FAKE_MCUMGR_STATE/new"
    : > "$FAKE_MCUMGR_STATE/calls.log"
    unset FAKE_MCUMGR_MODE
}

function update_all() { # runs mcumgr-update-all.sh non-interactively
    HACOAP_NON_INTERACTIVE=true HACOAP_BUILD_DIR="$TMP/build" "$SCRIPTS_DIR/mcumgr-update-all.sh" > "$OUTPUT" 2>&1
}

cd "$TMP" || exit 1 # the scripts must not depend on the current directory

# ------------------------------------------------------------------ tests

reset_device
"$SCRIPTS_DIR/get-image-hash.sh" "$TMP/build" > "$OUTPUT" 2>&1
expect_output "get-image-hash.sh prints the image's SHA-256" "^${EXPECTED_HASH}\$"

if hacoap_tools serial-ports > "$OUTPUT" 2>&1; then pass "serial-ports runs"; else fail "serial-ports runs"; fi

hacoap_tools discover --timeout 1 > "$OUTPUT" 2>&1
status=$?
if [ $status -eq 0 ] || [ $status -eq 3 ]; then pass "discover runs (exit $status)"; else fail "discover runs (exit $status)"; fi

reset_device
HACOAP_DEVICES="dev1=fd00::1 dev2=fd00::2" update_all
expect_output "update-all over UDP, test mode" "RESULT dev1 success" "RESULT dev2 success" \
    "connstring=\[fd00::1\]:1337" "image test $EXPECTED_HASH" "reset"

reset_device
HACOAP_CONNECTION=USB HACOAP_UPDATE_MODE=confirm HACOAP_DEVICES="board=$TEST_PORT" update_all
expect_output "update-all over USB ($TEST_PORT), confirm mode" "RESULT board success" \
    "connstring=$TEST_PORT,baud=115200" "image confirm $EXPECTED_HASH"

reset_device "$EXPECTED_HASH"
HACOAP_DEVICES="dev1=fd00::1" update_all
expect_output "update-all skips a device that has the image" "RESULT dev1 skipped"

reset_device
export FAKE_MCUMGR_MODE=fail
HACOAP_DEVICES="dev1=fd00::1" HACOAP_MAX_RETRIES=2 update_all
if [ "$(grep -c "image upload" "$FAKE_MCUMGR_STATE/calls.log")" = "2" ]; then
    expect_output "update-all retries a failed upload, then reports it" "RESULT dev1 failed"
else
    fail "update-all retries a failed upload (expected 2 attempts)"
fi

reset_device
export FAKE_MCUMGR_MODE=stall
start=$(date +%s)
HACOAP_DEVICES="dev1=fd00::1" HACOAP_STALL_TIMEOUT=3 HACOAP_MAX_RETRIES=1 update_all
elapsed=$(( $(date +%s) - start ))
sleep 1
upload_pid=$(cat "$FAKE_MCUMGR_STATE/upload.pid" 2>/dev/null)
if [ $elapsed -ge 40 ]; then
    fail "update-all stops a stalled upload (took ${elapsed}s)"
elif [ -n "$upload_pid" ] && kill -0 "$upload_pid" 2>/dev/null; then
    kill -9 "$upload_pid" 2>/dev/null
    fail "update-all stops a stalled upload (mcumgr still running)"
elif [ "$HACOAP_OS" = "windows" ] && tasklist //FI "IMAGENAME eq PING.EXE" 2>/dev/null | grep -qi ping; then
    taskkill //F //IM PING.EXE > /dev/null 2>&1
    fail "update-all stops a stalled upload (native process still running)"
else
    expect_output "update-all stops a stalled upload (${elapsed}s)" "RESULT dev1 failed" "stall timeout"
fi

reset_device
HACOAP_DEVICES="dev1=not-an-address" update_all
expect_output "update-all rejects an invalid address" "Invalid IPv6 address"

reset_device
HACOAP_CONNECTION=USB HACOAP_DEVICES="board=/etc/passwd" update_all
expect_output "update-all rejects an invalid serial port" "Invalid serial port"

# Interactive: over the air, nothing discovered, address typed by hand
reset_device
printf '2\nfd00::7\n1\n\n\n\ny\n' | HACOAP_TEST_DEVICES="" HACOAP_BUILD_DIR="$TMP/build" \
    "$SCRIPTS_DIR/mcumgr-update-all.sh" > "$OUTPUT" 2>&1
expect_output "update-all interactive, typed address" "RESULT fd00::7 success" "image test $EXPECTED_HASH"

# Interactive: USB, the board's port found automatically
reset_device
printf '1\n2\n\n\n\ny\n' | HACOAP_TEST_SERIAL_PORTS="$TEST_PORT,Fake board,1;COM9,Other,0" HACOAP_BUILD_DIR="$TMP/build" \
    "$SCRIPTS_DIR/mcumgr-update-all.sh" > "$OUTPUT" 2>&1
expect_output "update-all interactive, USB board port" "Automatically selected: " "RESULT USB-Device success" \
    "connstring=$TEST_PORT,baud" "image confirm $EXPECTED_HASH"

# Guided script: USB port from the list, upload in test mode
reset_device
printf '1\n1\n1\n1\nxq\n' | HACOAP_TEST_SERIAL_PORTS="$TEST_PORT,Fake board,1" HACOAP_BUILD_DIR="$TMP/build" \
    "$SCRIPTS_DIR/mcumgr-dfu.sh" > "$OUTPUT" 2>&1
expect_output "mcumgr-dfu.sh over USB" "Flash process completed" "connstring=$TEST_PORT,baud" \
    "image test $EXPECTED_HASH" "Goodbye"

# Guided script: discovered device, list images, then quit
reset_device
printf '2\n1\n2\nx3\nq\n' | HACOAP_TEST_DEVICES="ha-coap-1234=fd00::5" HACOAP_BUILD_DIR="$TMP/build" \
    "$SCRIPTS_DIR/mcumgr-dfu.sh" > "$OUTPUT" 2>&1
expect_output "mcumgr-dfu.sh over the air, discovered device" "ha-coap-1234" "connstring=\[fd00::5\]:1337" \
    "image list" "Goodbye"

# Guided script: nothing discovered, address typed by hand
reset_device
printf '2\nfd00::9\n3\nq\n' | HACOAP_TEST_DEVICES="" "$SCRIPTS_DIR/mcumgr-dfu.sh" > "$OUTPUT" 2>&1
expect_output "mcumgr-dfu.sh over the air, typed address" "connstring=\[fd00::9\]:1337" "Goodbye"

echo ""
if [ $FAILURES -eq 0 ]; then
    echo "All tests passed."
else
    echo "$FAILURES test(s) failed."
    exit 1
fi
