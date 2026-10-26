import pytest

from hacoap_manager import discovery
from hacoap_manager.simdevice import announce


def test_device_id_from_instance():
    assert discovery.device_id_from_instance("ha-coap-1a2b3c4d") == "1a2b3c4d"
    assert discovery.device_id_from_instance("ha-coap") == ""


def test_pick_address():
    pick = discovery.pick_address
    assert pick(["fe80::1", "fd11:22::1", "2001:db8::1"]) == "fd11:22::1"
    assert pick(["fe80::1", "::1"]) is None                       # a real board never uses these
    assert pick(["127.0.0.1"]) is None
    assert pick(["127.0.0.1"], {b"sim": b"1"}) == "127.0.0.1"     # the simulator says so
    assert pick(["fd11:22::1", "127.0.0.1"], {b"sim": b"1"}) == "fd11:22::1"
    assert pick(["192.168.1.9"], {b"sim": b"1"}) is None


async def test_finds_the_simulator_over_mdns():
    """A real mDNS round trip on this machine. Skipped where multicast doesn't loop back."""
    announcement = await announce("feedbeef", "127.0.0.1", 5683)
    try:
        found = await discovery.discover(timeout=3)
    finally:
        await announcement.async_close()
    mine = [f for f in found if f.device_id == "feedbeef"]
    if not mine:
        pytest.skip("mDNS multicast doesn't loop back on this machine")
    assert mine[0].address == "127.0.0.1"
    assert mine[0].instance == "ha-coap-feedbeef"
