"""Pictures people add: the floor plan, and a photo of each device's plant. Only PNG, JPEG and
WebP are accepted (checked from the file's first bytes, not its name), never SVG, which can
carry scripts."""

import re
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
    """One photo per device, in the data folder's photos/, named by device ID."""

    def __init__(self, data_dir):
        self.folder = Path(data_dir) / "photos"

    def path(self, device_id):
        if not DEVICE_ID.fullmatch(device_id):  # the ID becomes a file name
            raise PictureError("Invalid device ID")
        return self.folder / device_id

    def save(self, device_id, data):
        picture_type(data)
        path = self.path(device_id)
        self.folder.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def read(self, device_id):
        """(bytes, media type), or None."""
        try:
            data = self.path(device_id).read_bytes()
            return data, picture_type(data)
        except (OSError, PictureError):
            return None

    def delete(self, device_id):
        try:
            self.path(device_id).unlink(missing_ok=True)
        except PictureError:
            pass
