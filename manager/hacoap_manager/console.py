"""A serial console in the browser: shows what a board prints on a USB serial port (the
usb-logging variant's second port, or a USB-to-UART adapter on J4), and sends lines to it."""

import collections
import re
import threading

KEEP_LINES = 2000
ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")  # colour codes in Zephyr's log output


class ConsoleError(Exception):
    pass


class SerialConsole:
    def __init__(self, events):
        self.events = events
        self.port = None
        self.baudrate = None
        self.lines = collections.deque(maxlen=KEEP_LINES)
        self._serial = None
        self._thread = None
        self._loop = None

    def state(self):
        return {"port": self.port, "baudrate": self.baudrate, "open": self._serial is not None,
                "lines": list(self.lines)[-500:]}

    def open(self, loop, port, baudrate=115200):
        import serial  # pyserial

        self.close()
        try:
            self._serial = serial.serial_for_url(port, baudrate, timeout=0.2)  # a port, or loop:// in tests
        except (serial.SerialException, ValueError, OSError) as exc:
            raise ConsoleError(f"Cannot open {port}: {exc}") from exc
        self.port, self.baudrate, self._loop = port, baudrate, loop
        self.lines.clear()
        self._thread = threading.Thread(target=self._read, args=(self._serial,), daemon=True)
        self._thread.start()
        self._publish_state()

    def close(self):
        connection, self._serial = self._serial, None
        if connection is not None:
            try:
                connection.close()
            except Exception:  # noqa: BLE001 - already gone (unplugged)
                pass
            self._publish_state()
        self.port = None

    def send(self, text):
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
            *complete, pending = re.split(rb"\r?\n", pending)
            for raw in complete:
                self._emit(ANSI.sub("", raw.decode("utf-8", errors="replace")))

    def _emit(self, line):
        def publish():
            self.lines.append(line)
            self.events.publish("console", line=line)
        self._loop.call_soon_threadsafe(publish)

    def _publish_state(self):
        self.events.publish("console-state", state={k: v for k, v in self.state().items() if k != "lines"})
