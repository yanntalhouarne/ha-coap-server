import asyncio

import pytest

from hacoap_manager import config
from hacoap_manager.db import Database
from hacoap_manager.events import EventBus
from hacoap_manager.images import ImageLibrary
from hacoap_manager.inventory import Inventory
from hacoap_manager.updates import UpdateError, UpdateManager

from conftest import NEW_HASH, NEW_IMAGE, OLD_HASH, fast_settings


@pytest.fixture
def fleet(tmp_path):
    """An update manager with an empty inventory and NEW_IMAGE in the library."""
    class Fleet:
        pass

    f = Fleet()
    f.settings = config.Settings()
    f.db = Database(tmp_path / "test.db")
    f.events = EventBus()
    f.inventory = Inventory(f.db, f.settings, f.events, discover=None)
    f.images = ImageLibrary(tmp_path, f.db)
    f.images.add(NEW_IMAGE, "app_update.bin")
    f.updates = UpdateManager(f.db, f.images, f.inventory, f.settings, f.events)
    yield f
    f.db.close()


async def run(fleet, targets, **kwargs):
    job = fleet.updates.start(NEW_HASH, targets, **kwargs)
    return await asyncio.wait_for(fleet.updates.wait(job.id), 60)


async def test_updates_one_device(fleet, start_sim):
    server = await start_sim()
    fast_settings(fleet.settings, server)
    fleet.db.upsert_device("1a2b3c4d", address="127.0.0.1", name="tomatoes")
    events = []
    with fleet.events.subscribe() as queue:
        job = await run(fleet, [{"device_id": "1a2b3c4d"}])
        while not queue.empty():
            events.append(queue.get_nowait())

    target = job.targets[0]
    assert (job.state, target.status) == ("done", "updated"), target.message
    assert target.label == "tomatoes"
    slot0 = server.device.slots[0]
    assert slot0.info.hash == NEW_HASH and slot0.confirmed
    assert server.device.resets == 1

    device = fleet.db.device("1a2b3c4d")
    assert device["image_hash"] == NEW_HASH
    assert device["fw_version"] == NEW_HASH[:7]  # refreshed over CoAP after the update
    history = fleet.db.updates()
    assert [(h["device_id"], h["result"]) for h in history] == [("1a2b3c4d", "updated")]

    steps = [e["job"]["targets"][0]["step"] for e in events if e["type"] == "job"]
    for step in ("connecting", "uploading", "testing", "rebooting", "waiting for the device", "confirming"):
        assert step in steps


async def test_a_device_already_running_the_image_is_left_alone(fleet, start_sim):
    server = await start_sim()
    fast_settings(fleet.settings, server)
    fleet.db.upsert_device("1a2b3c4d", address="127.0.0.1")
    await run(fleet, [{"device_id": "1a2b3c4d"}])
    job = await run(fleet, [{"device_id": "1a2b3c4d"}])
    assert job.targets[0].status == "already-current"
    assert server.device.resets == 1


async def test_a_reverted_update_fails_and_stops_the_rollout(fleet, start_sim):
    first = await start_sim(fail_boot=True)
    fast_settings(fleet.settings, first)
    try:
        second = await start_sim("::1", smp_port=first.smp_port, coap_port=first.coap_port)
    except OSError:
        pytest.skip("no IPv6 loopback")
    fleet.db.upsert_device("aaaa", address="127.0.0.1")
    fleet.db.upsert_device("bbbb", address="::1")

    job = await run(fleet, [{"device_id": "aaaa"}, {"device_id": "bbbb"}])
    assert job.state == "failed"
    assert job.targets[0].status == "failed"
    assert "reverted" in job.targets[0].message
    assert job.targets[1].status == "skipped"
    assert first.device.slots[0].info.hash == OLD_HASH  # still runs the old image
    assert second.device.resets == 0
    assert [h["result"] for h in fleet.db.updates()] == ["skipped", "failed"]


async def test_two_devices_one_after_the_other(fleet, start_sim):
    first = await start_sim()
    fast_settings(fleet.settings, first)
    try:
        second = await start_sim("::1", smp_port=first.smp_port, coap_port=first.coap_port)
    except OSError:
        pytest.skip("no IPv6 loopback")
    fleet.db.upsert_device("aaaa", address="127.0.0.1")
    fleet.db.upsert_device("bbbb", address="::1")

    job = await run(fleet, [{"device_id": "aaaa"}, {"device_id": "bbbb"}])
    assert [t.status for t in job.targets] == ["updated", "updated"], [t.message for t in job.targets]
    assert second.device.slots[0].info.hash == NEW_HASH


async def test_going_on_after_a_failure_when_asked(fleet, start_sim):
    first = await start_sim(fail_boot=True)
    fast_settings(fleet.settings, first)
    try:
        await start_sim("::1", smp_port=first.smp_port, coap_port=first.coap_port)
    except OSError:
        pytest.skip("no IPv6 loopback")
    fleet.db.upsert_device("aaaa", address="127.0.0.1")
    fleet.db.upsert_device("bbbb", address="::1")
    job = await run(fleet, [{"device_id": "aaaa"}, {"device_id": "bbbb"}], stop_on_failure=False)
    assert [t.status for t in job.targets] == ["failed", "updated"]


async def test_an_unreachable_device_fails(fleet, start_sim):
    server = await start_sim(drop_smp_every=1)
    fast_settings(fleet.settings, server)
    fleet.db.upsert_device("1a2b3c4d", address="127.0.0.1")
    job = await run(fleet, [{"device_id": "1a2b3c4d"}])
    assert job.targets[0].status == "failed"
    assert "cannot connect" in job.targets[0].message or "no answer" in job.targets[0].message


async def test_cancel_skips_devices_not_started(fleet, start_sim):
    server = await start_sim()
    fast_settings(fleet.settings, server)
    fleet.db.upsert_device("aaaa", address="127.0.0.1")
    fleet.db.upsert_device("bbbb", address="127.0.0.1")
    job = fleet.updates.start(NEW_HASH, [{"device_id": "aaaa"}, {"device_id": "bbbb"}])
    while job.targets[0].status != "running":
        await asyncio.sleep(0.01)
    fleet.updates.cancel(job.id)
    job = await asyncio.wait_for(fleet.updates.wait(job.id), 60)
    assert job.state == "cancelled"
    assert job.targets[0].status == "updated"  # the one in progress finishes
    assert job.targets[1].status == "cancelled"


async def test_start_checks_its_input(fleet):
    fleet.db.upsert_device("noaddr")
    with pytest.raises(UpdateError, match="Unknown image"):
        fleet.updates.start("00" * 32, [{"device_id": "noaddr"}])
    with pytest.raises(UpdateError, match="No devices"):
        fleet.updates.start(NEW_HASH, [])
    with pytest.raises(UpdateError, match="no network address"):
        fleet.updates.start(NEW_HASH, [{"device_id": "noaddr"}])
    with pytest.raises(UpdateError, match="serial port"):
        fleet.updates.start(NEW_HASH, [{"transport": "serial"}])
    with pytest.raises(UpdateError, match="Unknown transport"):
        fleet.updates.start(NEW_HASH, [{"device_id": "noaddr", "transport": "ble"}])


async def test_one_job_at_a_time(fleet, start_sim):
    server = await start_sim()
    fast_settings(fleet.settings, server)
    fleet.db.upsert_device("1a2b3c4d", address="127.0.0.1")
    job = fleet.updates.start(NEW_HASH, [{"device_id": "1a2b3c4d"}])
    with pytest.raises(UpdateError, match="already running"):
        fleet.updates.start(NEW_HASH, [{"device_id": "1a2b3c4d"}])
    await fleet.updates.wait(job.id)
