"""Firmware updates: upload, trial boot, check, confirm, one device after the other.

Each device goes through:
  1. connect, read its slots (already running this image: nothing to do)
  2. upload the image to slot 1 (skipped if it's already there)
  3. mark it for test, and reset: MCUboot swaps the images
  4. wait for the device to come back running the new image. If it comes back running the
     old one, MCUboot reverted it: the update failed and the device is as it was
  5. confirm the new image, so it stays

An update job stops at the first failure unless asked to go on, so a bad image reaches
one device, not the whole fleet. A staged job also pauses after the first device, until
asked to continue. Cancelling skips the devices not started yet; the one in progress
finishes, so it's never left half-way.
"""

import asyncio
import logging
import time
import uuid
from dataclasses import asdict, dataclass, field, fields

from .mcumgr import DeviceLink, McumgrError

log = logging.getLogger(__name__)


class UpdateError(Exception):
    pass


@dataclass
class Target:
    device_id: str    # "" for a board on USB that isn't in the inventory
    transport: str    # "udp" or "serial"
    address: str      # IPv6 address or serial port
    label: str = ""
    status: str = "queued"   # queued, running, updated, already-current, failed, skipped, cancelled
    step: str = ""
    progress: float = 0.0    # upload, 0 to 1
    message: str = ""
    started: float = None
    finished: float = None


@dataclass
class UpdateJob:
    id: str
    image_hash: str
    image_version: str
    targets: list
    stop_on_failure: bool = True
    staged: bool = False     # pause after the first device
    state: str = "running"   # running, paused, done, failed, cancelled
    created: float = field(default_factory=time.time)
    cancel_requested: bool = False
    resume: asyncio.Event = field(default_factory=asyncio.Event)

    def as_dict(self):
        data = {f.name: getattr(self, f.name) for f in fields(self) if f.name not in ("cancel_requested", "resume")}
        data["targets"] = [asdict(t) for t in self.targets]
        return data


class UpdateManager:
    def __init__(self, db, images, inventory, settings, events):
        self.db = db
        self.images = images
        self.inventory = inventory
        self.settings = settings
        self.events = events
        self.jobs = {}
        self._tasks = {}

    def running_job(self):
        return next((j for j in self.jobs.values() if j.state in ("running", "paused")), None)

    def start(self, image_hash, targets, stop_on_failure=True, staged=False, console=None):
        """Starts an update job. 'targets' are dicts with device_id, and transport ("udp" by
        default) or serial_port."""
        if self.running_job() is not None:
            raise UpdateError("An update is already running")
        image = self.db.image(image_hash)
        data = self.images.data(image_hash)
        if image is None or data is None:
            raise UpdateError("Unknown image")
        if not targets:
            raise UpdateError("No devices selected")

        job_targets = []
        for item in targets:
            device_id = item.get("device_id", "")
            transport = item.get("transport", "udp")
            if transport == "serial":
                address = item.get("serial_port", "")
                if not address:
                    raise UpdateError("A USB update needs a serial port")
                if console is not None and console.port == address:
                    raise UpdateError(f"The console has {address} open: close it first")
            elif transport == "udp":
                device = self.db.device(device_id)
                if device is None or not device["address"]:
                    raise UpdateError(f"{device_id or 'Device'} has no network address")
                address = device["address"]
            else:
                raise UpdateError(f"Unknown transport {transport!r}")
            device = self.db.device(device_id) if device_id else None
            label = (device["name"] if device and device["name"] else device_id) or f"USB {address}"
            job_targets.append(Target(device_id, transport, address, label=label))

        job = UpdateJob(uuid.uuid4().hex[:12], image_hash, image["version"], job_targets, stop_on_failure,
                        staged=staged and len(job_targets) > 1)
        self.jobs[job.id] = job
        self._tasks[job.id] = asyncio.create_task(self._run(job, data))
        self._publish(job)
        return job

    def cancel(self, job_id):
        job = self.jobs.get(job_id)
        if job is None:
            raise UpdateError("Unknown job")
        job.cancel_requested = True
        job.resume.set()
        self._publish(job)
        return job

    def resume(self, job_id):
        """Lets a staged job go on with the rest of the devices."""
        job = self.jobs.get(job_id)
        if job is None or job.state != "paused":
            raise UpdateError("This update isn't waiting")
        job.resume.set()
        return job

    async def wait(self, job_id):
        task = self._tasks.get(job_id)
        if task is not None:
            await task
        return self.jobs[job_id]

    def _publish(self, job):
        self.events.publish("job", job=job.as_dict())

    async def _run(self, job, data):
        failed = False
        for target in job.targets:
            if job.cancel_requested:
                target.status, target.message = "cancelled", "Cancelled before it started"
            elif failed and job.stop_on_failure:
                target.status, target.message = "skipped", "Skipped: an earlier device failed"
            else:
                await self._update_target(job, target, data)
                failed = failed or target.status == "failed"
            if target.status in ("cancelled", "skipped"):
                self._record(job, target)
            self._publish(job)
            if job.staged and target is job.targets[0] and not failed and not job.cancel_requested:
                job.state = "paused"  # check the first device, then continue
                self._publish(job)
                await job.resume.wait()
                job.state = "running"
                self._publish(job)
        job.state = "cancelled" if job.cancel_requested else ("failed" if failed else "done")
        self._publish(job)

    def _record(self, job, target):
        self.db.add_update(job.id, target.device_id or f"usb:{target.address}", target.transport, job.image_hash,
                           job.image_version, target.started or time.time(), target.finished or time.time(),
                           target.status, target.message)

    def _step(self, job, target, step):
        target.step = step
        self._publish(job)

    async def _update_target(self, job, target, data):
        target.status = "running"
        target.started = time.time()
        try:
            target.status, target.message = await self._update_steps(job, target, data)
        except (McumgrError, UpdateError, OSError) as exc:
            target.status, target.message = "failed", str(exc)
        except Exception as exc:  # noqa: BLE001 - reported, and the next device can go on
            log.exception("update of %s", target.label)
            target.status, target.message = "failed", f"Unexpected error: {exc}"
        target.step = ""
        target.finished = time.time()
        self._record(job, target)
        if target.device_id and target.status in ("updated", "already-current"):
            self.db.upsert_device(target.device_id, image_hash=job.image_hash, image_version=job.image_version,
                                  last_seen=time.time())
            if target.transport == "udp":
                try:
                    await self.inventory.refresh(target.device_id)  # the new firmware version
                except Exception:  # noqa: BLE001 - best effort
                    pass

    async def _update_steps(self, job, target, data):
        settings = self.settings.link_settings()
        self._step(job, target, "connecting")
        async with DeviceLink(target.transport, target.address, settings) as link:
            slots = {s.slot: s for s in await link.image_states()}
            running = slots.get(0)
            if running is not None and running.hash == job.image_hash and running.confirmed:
                return "already-current", "Already running this image"
            old_hash = running.hash if running is not None else ""

            staged = slots.get(1)
            if staged is None or staged.hash != job.image_hash:
                self._step(job, target, "uploading")
                last = [0.0]

                def progress(offset, size):
                    target.progress = offset / size
                    if target.progress - last[0] >= 0.01 or offset == size:
                        last[0] = target.progress
                        self._publish(job)

                await link.upload(data, progress)
                slots = {s.slot: s for s in await link.image_states()}
                if slots.get(1) is None or slots[1].hash != job.image_hash:
                    raise UpdateError("The image isn't in slot 1 after the upload")
            target.progress = 1.0

            self._step(job, target, "testing")
            await link.test(job.image_hash)
            self._step(job, target, "rebooting")
            await link.reset()

        self._step(job, target, "waiting for the device")
        await self._wait_for_new_image(target, job.image_hash, old_hash, settings)

        self._step(job, target, "confirming")
        async with DeviceLink(target.transport, target.address, settings) as link:
            slots = {s.slot: s for s in await link.confirm()}
        if slots.get(0) is None or slots[0].hash != job.image_hash or not slots[0].confirmed:
            raise UpdateError("The device didn't confirm the new image")
        return "updated", "Updated and confirmed"

    async def _wait_for_new_image(self, target, image_hash, old_hash, settings):
        """Waits until the device runs the new image (slot 0) after the reset."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self.settings.reboot_timeout_s
        await asyncio.sleep(1.0)  # the device takes a moment to reset
        last_error = "no answer"
        while loop.time() < deadline:
            try:
                async with DeviceLink(target.transport, target.address, settings) as link:
                    slots = {s.slot: s for s in await link.image_states()}
            except McumgrError as exc:
                last_error = str(exc)
                await asyncio.sleep(2.0)
                continue
            running, staged = slots.get(0), slots.get(1)
            if running is not None and running.hash == image_hash:
                return
            if staged is not None and staged.hash == image_hash and staged.pending:
                await asyncio.sleep(1.0)  # hasn't reset yet
                continue
            raise UpdateError("The device came back running its previous image: MCUboot reverted the update "
                              "(the new image failed to start, or isn't signed with this board's key)")
        raise UpdateError(f"The device didn't come back within {self.settings.reboot_timeout_s:.0f} s ({last_error})")
