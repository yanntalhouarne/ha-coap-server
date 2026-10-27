"""Pictures people add: the floor plan, and a photo of each device's plant. Only PNG, JPEG and
WebP are accepted (checked from the file's first bytes, not its name), never SVG, which can
carry scripts."""

import re
import time
from pathlib import Path

MAX_SIZE = 10 * 1024 * 1024
TYPES = {b"\x89PNG": "image/png", b"\xff\xd8\xff": "image/jpeg", b"RIFF": "image/webp"}
DEVICE_ID = re.compile(r"[A-Za-z0-9_-]{1,32}")


class PictureError(Exception):
    pass


def picture_type(data):
    """The picture's media type. Raises PictureError if it isn't a PNG, JPEG or WebP picture."""
    if len(data) > MAX_SIZE:
        raise PictureError("The picture is larger than 10 MB")
    content_type = next((t for magic, t in TYPES.items() if data.startswith(magic)), None)
    if content_type is None or (content_type == "image/webp" and data[8:12] != b"WEBP"):
        raise PictureError("Use a PNG, JPEG or WebP picture")
    return content_type


class PhotoStore:
    """A timeline of photos per device, in the data folder's photos/: <device ID>.<when taken>
    (Unix time). The newest is also kept as photos/<device ID>, the device's current photo."""

    def __init__(self, data_dir):
        self.folder = Path(data_dir) / "photos"

    def path(self, device_id):
        if not DEVICE_ID.fullmatch(device_id):  # the ID becomes a file name
            raise PictureError("Invalid device ID")
        return self.folder / device_id

    def _dated(self, device_id, taken):
        return self.folder / f"{self.path(device_id).name}.{int(taken)}"

    def timeline(self, device_id):
        """When each photo was taken, oldest first. A photo from before the timeline (only the
        current one) joins it, dated by its file."""
        current = self.path(device_id)
        taken = sorted(int(p.suffix[1:]) for p in self.folder.glob(f"{current.name}.*") if p.suffix[1:].isdigit())
        if not taken and current.is_file():
            when = int(current.stat().st_mtime)
            self._dated(device_id, when).write_bytes(current.read_bytes())
            taken = [when]
        return taken

    def add(self, device_id, data, taken=None):
        """Adds a photo taken at 'taken' (Unix time; now if None). Returns its time."""
        picture_type(data)
        self.folder.mkdir(parents=True, exist_ok=True)
        self.timeline(device_id)  # an older current photo joins first
        taken = int(taken or time.time())
        while self._dated(device_id, taken).exists():
            taken += 1
        self._dated(device_id, taken).write_bytes(data)
        self._sync_current(device_id)
        return taken

    save = add

    def _sync_current(self, device_id):
        """The current photo: the newest of the timeline, or none."""
        taken = self.timeline(device_id)
        current = self.path(device_id)
        if taken:
            current.write_bytes(self._dated(device_id, taken[-1]).read_bytes())
        else:
            current.unlink(missing_ok=True)

    def read(self, device_id, taken=None):
        """(bytes, media type) of the current photo, or of the one taken at 'taken'; or None."""
        try:
            path = self.path(device_id) if taken is None else self._dated(device_id, taken)
            data = path.read_bytes()
            return data, picture_type(data)
        except (OSError, PictureError, ValueError):
            return None

    def remove(self, device_id, taken):
        """Removes one photo of the timeline. Returns how many are left."""
        self._dated(device_id, taken).unlink(missing_ok=True)
        self._sync_current(device_id)
        return len(self.timeline(device_id))

    def delete(self, device_id):
        """Removes all of a device's photos."""
        try:
            current = self.path(device_id)
        except PictureError:
            return
        for path in self.folder.glob(f"{current.name}.*"):
            path.unlink(missing_ok=True)
        current.unlink(missing_ok=True)
