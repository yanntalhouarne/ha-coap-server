"""A console in the browser: shows what a board prints, over USB or over the air.

Over USB, it reads a serial port (the usb-logging variant's second port, or a USB-to-UART
adapter on J4) and sends lines to it. Over the air, it reads a board's 'log' CoAP resource
(firmware built with "Log over the air", CONFIG_HACOAP_REMOTE_LOG) every second: the board
keeps its last few KB of log output, and polls fast while someone reads it.
"""

import asyncio
import collections
import re
import threading

from . import coap

KEEP_LINES = 2000
ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")  # colour codes in Zephyr's log output
POLL_S = 1.0    # over the air: how often the console asks the board for new output
RETRY_S = 5.0   # and after the board didn't answer


class ConsoleError(Exception):
    pass


def _current_task():
    """The asyncio task running this code, or None (another thread, or no event loop)."""
    try:
        return asyncio.current_task()
    except RuntimeError:
        return None


class SerialConsole:
    def __init__(self, events):
        self.events = events
        self.source = None       # "usb" or "air" while open
        self.port = None
        self.baudrate = None
        self.device_id = None    # over the air
        self.device_name = None
        self.lines = collections.deque(maxlen=KEEP_LINES)
        self._serial = None
        self._thread = None
        self._task = None
        self._loop = None

    def state(self):
        return {"source": self.source, "port": self.port, "baudrate": self.baudrate, "device_id": self.device_id,
                "device_name": self.device_name, "open": self._serial is not None or self._task is not None,
                "lines": list(self.lines)[-500:]}

    def open(self, loop, port, baudrate=115200):
        import serial  # pyserial

        self.close()
        try:
            self._serial = serial.serial_for_url(port, baudrate, timeout=0.2)  # a port, or loop:// in tests
        except (serial.SerialException, ValueError, OSError) as exc:
            raise ConsoleError(f"Cannot open {port}: {exc}") from exc
        self.source, self.port, self.baudrate, self._loop = "usb", port, baudrate, loop
        self.lines.clear()
        self._thread = threading.Thread(target=self._read, args=(self._serial,), daemon=True)
        self._thread.start()
        self._publish_state()

    def open_air(self, device, coap_options):
        """Shows a board's log over the air. 'device' is its row in the database."""
        if not device["address"]:
            raise ConsoleError("This device has no network address yet")
        self.close()
        self.source, self.device_id, self.device_name = "air", device["device_id"], device["name"] or device["device_id"]
        self._loop = asyncio.get_running_loop()
        self.lines.clear()
        self._task = self._loop.create_task(self._poll(device["address"], coap_options))
        self._publish_state()

    def close(self):
        connection, self._serial = self._serial, None
        task, self._task = self._task, None
        if connection is not None:
            try:
                connection.close()
            except Exception:  # noqa: BLE001 - already gone (unplugged)
                pass
        if task is not None and task is not _current_task():
            try:
                task.cancel()
            except RuntimeError:  # its event loop is closed (the app is stopping)
                pass
        self.source = self.port = self.device_id = self.device_name = None
        if connection is not None or task is not None:
            self._publish_state()

    def send(self, text):
        if self.source == "air":
            raise ConsoleError("Over the air, the console only shows the board's log")
        if self._serial is None:
            raise ConsoleError("No port is open")
        try:
            self._serial.write(text.encode("utf-8") + b"\r\n")
        except Exception as exc:  # noqa: BLE001
            raise ConsoleError(f"Cannot write: {exc}") from exc

    def _read(self, connection):
        """In a thread: reads lines until the port is closed or unplugged."""
        pending = b""
        while self._serial is connection:
            try:
                chunk = connection.read(256)
            except Exception as exc:  # noqa: BLE001 - unplugged, or closed under us
                if self._serial is connection:
                    self._emit(f"[console: {exc}]")
                    self._loop.call_soon_threadsafe(self.close)
                return
            if not chunk:
                continue
            pending += chunk
            pending = self._emit_lines(pending)

    async def _poll(self, address, options):
        try:
            await self._poll_log(address, options)
        except Exception as exc:  # noqa: BLE001 - shown, rather than a console that stays open and silent
            self._emit(f"[console: {exc}]")
            self.close()

    async def _poll_log(self, address, options):
        """Reads the board's log from where the last answer ended, until closed."""
        offset, boot, pending, failing = 0, None, b"", False
        while True:
            try:
                chunk = await coap.get_log(address, offset, **options)
            except coap.NoLog:
                self._emit("[console: this board's firmware keeps no log over the air. Build it with "
                           "\"Log over the air\" (a build profile on the Builds tab), and update it.]")
                self.close()
                return
            except (TimeoutError, coap.CoapError, OSError) as exc:
                if not failing:
                    self._emit(f"[console: the board doesn't answer ({exc}); still trying]")
                    failing = True
                await asyncio.sleep(RETRY_S)
                continue
            if failing:
                self._emit("[console: the board answers again]")
                failing = False
            if chunk.boot_id != boot:
                if boot is not None:
                    # Its log started again: ask for it from its first byte.
                    self._emit_lines(pending + b"\n")
                    self._emit("[console: the board restarted]")
                    boot, offset, pending = chunk.boot_id, 0, b""
                    continue
                boot = chunk.boot_id
                if chunk.start > 0:
                    self._emit("[console: the board keeps only its latest log; older lines are gone]")
            elif chunk.start > offset:
                self._emit(f"[console: {chunk.start - offset} bytes of log were missed]")
            pending = self._emit_lines(pending + chunk.text)
            offset = chunk.start + len(chunk.text)
            if not chunk.full:
                await asyncio.sleep(POLL_S)

    def _emit_lines(self, pending):
        """Shows the complete lines of 'pending', and returns the rest."""
        *complete, rest = re.split(rb"\r?\n", pending)
        for raw in complete:
            self._emit(ANSI.sub("", raw.decode("utf-8", errors="replace")))
        return rest

    def _emit(self, line):
        def publish():
            self.lines.append(line)
            self.events.publish("console", line=line)
        if _current_task() is not None:
            publish()  # over the air: already in the event loop, so in order with the state
        else:
            self._loop.call_soon_threadsafe(publish)

    def _publish_state(self):
        self.events.publish("console-state", state={k: v for k, v in self.state().items() if k != "lines"})
