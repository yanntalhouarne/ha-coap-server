import pytest

from hacoap_manager import mcuboot
from hacoap_manager.mcumgr import DeviceLink, LinkSettings, McumgrError

from conftest import NEW_HASH, NEW_IMAGE, OLD_HASH


def settings_for(server, **overrides):
    return LinkSettings(**{"udp_port": server.smp_port, "timeout_s": 0.5, **overrides})


async def test_reads_the_slots(start_sim):
    server = await start_sim()
    async with DeviceLink("udp", "127.0.0.1", settings_for(server)) as link:
        slots = await link.image_states()
    assert len(slots) == 1
    assert (slots[0].slot, slots[0].version, slots[0].hash) == (0, "1.0.0", OLD_HASH)
    assert slots[0].active and slots[0].confirmed


async def test_upload_test_reset_confirm(start_sim):
    server = await start_sim()
    settings = settings_for(server)
    offsets = []
    async with DeviceLink("udp", "127.0.0.1", settings) as link:
        await link.upload(NEW_IMAGE, lambda offset, size: offsets.append(offset))
        slots = {s.slot: s for s in await link.image_states()}
        assert slots[1].hash == NEW_HASH and not slots[1].pending
        slots = {s.slot: s for s in await link.test(NEW_HASH)}
        assert slots[1].pending
        await link.reset()
    assert offsets[-1] == len(NEW_IMAGE)
    assert offsets == sorted(offsets)

    import asyncio
    await asyncio.sleep(0.5)  # the simulator's reboot
    async with DeviceLink("udp", "127.0.0.1", settings) as link:
        slots = {s.slot: s for s in await link.image_states()}
        assert slots[0].hash == NEW_HASH and not slots[0].confirmed
        slots = {s.slot: s for s in await link.confirm()}
        assert slots[0].confirmed


async def test_upload_resumes_after_lost_packets(start_sim):
    server = await start_sim(drop_smp_every=4)
    async with DeviceLink("udp", "127.0.0.1", settings_for(server, timeout_s=0.3)) as link:
        await link.upload(NEW_IMAGE)
    assert server.device.slots[1].info.hash == NEW_HASH


async def test_upload_gives_up_when_the_device_is_gone(start_sim):
    server = await start_sim()
    async with DeviceLink("udp", "127.0.0.1", settings_for(server, timeout_s=0.2, first_upload_timeout_s=0.2,
                                                                 upload_retries=1)) as link:
        server.device.drop_smp_every = 1  # everything is lost from now on
        with pytest.raises(McumgrError, match="no answer"):
            await link.upload(NEW_IMAGE)


async def test_refused_upload_is_an_error(start_sim):
    server = await start_sim()
    not_an_image = b"\x00" * 4000
    async with DeviceLink("udp", "127.0.0.1", settings_for(server)) as link:
        with pytest.raises(McumgrError, match="refused"):
            await link.upload(not_an_image)


async def test_test_with_an_unknown_hash_is_an_error(start_sim):
    server = await start_sim()
    async with DeviceLink("udp", "127.0.0.1", settings_for(server)) as link:
        with pytest.raises(McumgrError):
            await link.test("00" * 32)


def test_unknown_transport():
    with pytest.raises(ValueError):
        DeviceLink("ble", "x")


async def test_upload_chunks_fit_the_mtu(start_sim):
    server = await start_sim()
    sizes = []
    original = server.device.handle_smp

    def record(frame):
        sizes.append(len(frame))
        return original(frame)

    server.device.handle_smp = record
    async with DeviceLink("udp", "127.0.0.1", settings_for(server, udp_mtu=600)) as link:
        await link.upload(mcuboot.build_image(b"y" * 5000))
    assert max(sizes) <= 600 - 28  # IPv4 + UDP headers (IPv6 would be 48)
    assert max(sizes) > 400       # and they're not needlessly small
