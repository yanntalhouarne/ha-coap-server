import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hacoap_manager import mcuboot  # noqa: E402
from hacoap_manager.simdevice import SimulatedDevice, SimulatedSrpServer, SimulatorServer  # noqa: E402

OLD_IMAGE = mcuboot.build_image(b"old firmware " * 500, (1, 0, 0, 0))
NEW_IMAGE = mcuboot.build_image(b"new firmware " * 3000, (1, 1, 0, 0))
OLD_HASH = mcuboot.parse_image(OLD_IMAGE).hash
NEW_HASH = mcuboot.parse_image(NEW_IMAGE).hash


@pytest.fixture
async def start_sim():
    """Starts simulated devices: await start_sim(host="127.0.0.1", **SimulatedDevice fields)."""
    servers = []

    async def start(host="127.0.0.1", smp_port=0, coap_port=0, **fields):
        # Each test's own border router: the boards of different tests share names, not keys
        fields.setdefault("srp_server", SimulatedSrpServer())
        device = SimulatedDevice.with_image(OLD_IMAGE, **fields)
        server = await SimulatorServer(device, host, smp_port, coap_port).start()
        servers.append(server)
        return server

    yield start
    for server in servers:
        await server.stop()


def fast_settings(settings, server):
    """App settings that point at a simulator and don't wait long."""
    settings.coap_port = server.coap_port
    settings.smp_port = server.smp_port
    settings.mcumgr_timeout_s = 1.0
    settings.coap_timeout_s = 0.3
    settings.reboot_timeout_s = 15.0
    return settings
