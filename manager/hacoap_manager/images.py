"""The image library: firmware images (app_update.bin) kept in the data folder by hash, and
what changed between two firmware versions (from the repository's git history)."""

import re
import subprocess
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

    def add(self, data, filename, notes="", git_commit=""):
        """Checks and stores an image. Raises mcuboot.ImageError if it isn't one."""
        if len(data) > MAX_IMAGE_SIZE:
            raise mcuboot.ImageError(f"{len(data)} bytes: larger than the application slot ({MAX_IMAGE_SIZE} bytes)")
        info = mcuboot.parse_image(data)
        self._path(info.hash).write_bytes(data)
        return self.db.add_image(info.hash, info.mcumgr_version, Path(filename).name or "app_update.bin",
                                 len(data), notes, git_commit)

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


def build_commit(build_dir):
    """The git commit a build was made from (its generated include/version.h), or ""."""
    try:
        text = (Path(build_dir) / "include" / "version.h").read_text(encoding="utf-8")
    except OSError:
        return ""
    match = re.search(r'GIT_COMMIT_HASH "([0-9a-f]{7,40})"', text)
    return match.group(1) if match else ""


COMMIT = re.compile(r"[0-9a-f]{7,40}")


def changes(repository, old, new, limit=100):
    """The commits between two firmware versions: {"added": [...], "removed": [...]}, each
    {commit, subject, date}. 'removed' is non-empty when going back to an older version."""
    if repository is None:
        raise ValueError("No firmware checkout: start the app from the ha-coap-server folder")
    if not (COMMIT.fullmatch(old or "") and COMMIT.fullmatch(new or "")):
        raise ValueError("Unknown firmware commit (images added as files have none)")

    def log(spec):
        result = subprocess.run(["git", "-C", str(repository), "log", f"--max-count={limit}",
                                 "--format=%h%x09%ad%x09%s", "--date=short", spec],
                                capture_output=True, text=True, encoding="utf-8", errors="replace")
        if result.returncode != 0:
            raise ValueError(f"git doesn't know one of these commits ({result.stderr.strip().splitlines()[-1:]})")
        entries = []
        for line in result.stdout.splitlines():
            commit, date, subject = (line.split("\t", 2) + ["", ""])[:3]
            entries.append({"commit": commit, "date": date, "subject": subject})
        return entries

    return {"added": log(f"{old}..{new}"), "removed": log(f"{new}..{old}")}


def build_images(repository):
    """The update images of the firmware builds in a checkout: [(variant, path)]."""
    if repository is None:
        return []
    found = []
    for build in sorted((repository / "application").glob("build*")):
        image = build / "zephyr" / "app_update.bin"
        if image.exists():
            variant = "battery" if build.name == "build" else build.name[len("build_"):].replace("_", "-")
            found.append((variant, image))  # its commit: build_commit(build)
    return found
