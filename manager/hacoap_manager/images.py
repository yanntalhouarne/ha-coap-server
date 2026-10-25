"""The image library: firmware images (app_update.bin) kept in the data folder by hash."""

from pathlib import Path

from . import mcuboot

MAX_IMAGE_SIZE = 0x79000  # the application slot (application/pm_static.yml)


class ImageLibrary:
    def __init__(self, data_dir, db):
        self.folder = Path(data_dir) / "images"
        self.folder.mkdir(parents=True, exist_ok=True)
        self.db = db

    def _path(self, image_hash):
        return self.folder / f"{image_hash}.bin"

    def add(self, data, filename, notes=""):
        """Checks and stores an image. Raises mcuboot.ImageError if it isn't one."""
        if len(data) > MAX_IMAGE_SIZE:
            raise mcuboot.ImageError(f"{len(data)} bytes: larger than the application slot ({MAX_IMAGE_SIZE} bytes)")
        info = mcuboot.parse_image(data)
        self._path(info.hash).write_bytes(data)
        return self.db.add_image(info.hash, info.mcumgr_version, Path(filename).name or "app_update.bin",
                                 len(data), notes)

    def data(self, image_hash):
        path = self._path(image_hash)
        if self.db.image(image_hash) is None or not path.exists():
            return None
        return path.read_bytes()

    def delete(self, image_hash):
        self._path(image_hash).unlink(missing_ok=True)
        return self.db.delete_image(image_hash)


def find_repository(start=None):
    """The ha-coap-server checkout this app runs from, or is started in, if any (for its
    build output)."""
    for here in ([Path(start)] if start else [Path(__file__), Path.cwd()]):
        here = here.resolve()
        for folder in [here, *here.parents]:
            if (folder / "application" / "prj.conf").exists():
                return folder
    return None


def build_images(repository):
    """The update images of the firmware builds in a checkout: [(variant, path)]."""
    if repository is None:
        return []
    found = []
    for build in sorted((repository / "application").glob("build*")):
        image = build / "zephyr" / "app_update.bin"
        if image.exists():
            variant = "battery" if build.name == "build" else build.name[len("build_"):].replace("_", "-")
            found.append((variant, image))
    return found
