"""Where the app keeps its data, and its settings (settings.json in that folder)."""

import json
import os
from dataclasses import asdict, dataclass, fields
from pathlib import Path

import platformdirs

from .mcumgr import LinkSettings


def default_data_dir():
    """The per-user data folder, or $HACOAP_MANAGER_DATA."""
    if os.environ.get("HACOAP_MANAGER_DATA"):
        return Path(os.environ["HACOAP_MANAGER_DATA"])
    return Path(platformdirs.user_data_dir("hacoap-manager", appauthor=False))


@dataclass
class Settings:
    coap_port: int = 5683
    smp_port: int = 1337
    udp_mtu: int = 1280
    serial_buffer: int = 512
    mcumgr_timeout_s: float = 10.0
    coap_timeout_s: float = 4.0     # before the first retransmission; then 8 s more
    discovery_timeout_s: float = 4.0
    online_minutes: int = 30        # a device that answered within this time is online
    auto_refresh_minutes: int = 15  # refresh every device's status while the app runs (0: never)
    reboot_timeout_s: float = 180.0  # how long an updated device has to come back
    border_router_url: str = ""     # the border router's REST API, such as http://192.168.1.20:8081

    def link_settings(self):
        return LinkSettings(udp_port=self.smp_port, udp_mtu=self.udp_mtu, serial_buffer=self.serial_buffer,
                            timeout_s=self.mcumgr_timeout_s)

    def as_dict(self):
        return asdict(self)

    def update(self, values):
        """Sets the known fields from 'values', converted to each field's type."""
        for f in fields(self):
            if f.name in values:
                setattr(self, f.name, type(getattr(self, f.name))(values[f.name]))


def load_settings(data_dir):
    settings = Settings()
    path = Path(data_dir) / "settings.json"
    if path.exists():
        try:
            settings.update(json.loads(path.read_text(encoding="utf-8")))
        except (ValueError, TypeError):
            pass  # a damaged file: defaults
    return settings


def save_settings(data_dir, settings):
    path = Path(data_dir) / "settings.json"
    path.write_text(json.dumps(settings.as_dict(), indent=2), encoding="utf-8")
