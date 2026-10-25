"""MCUboot image files: the version in the header and the SHA-256 hash that mcumgr reports.

An image is a 32-byte (or larger) header, the application, then TLVs (type-length-value
records): the SHA-256 hash of the header and application, and the signature.
"""

import hashlib
import struct
from dataclasses import dataclass

IMAGE_MAGIC = 0x96F3B83D
TLV_INFO_MAGIC = 0x6907
TLV_PROT_INFO_MAGIC = 0x6908
TLV_SHA256 = 0x10

HEADER_FORMAT = "<IIHHIIBBHII"  # magic, load address, header size, protected TLV size,
                                # image size, flags, version (major, minor, revision, build), pad
HEADER_SIZE = struct.calcsize(HEADER_FORMAT)


class ImageError(ValueError):
    pass


@dataclass(frozen=True)
class ImageInfo:
    version: str      # "major.minor.revision+build"
    hash: str         # SHA-256, hex: what mcumgr's image list shows
    size: int         # file size in bytes
    image_size: int   # application size, without header and TLVs

    @property
    def mcumgr_version(self):
        """The version as mcumgr's image list shows it: "1.2.3", or "1.2.3.4" with a build number."""
        numbers, _, build = self.version.partition("+")
        return numbers if build in ("", "0") else f"{numbers}.{build}"


def format_version(major, minor, revision, build):
    return f"{major}.{minor}.{revision}+{build}"


def parse_image(data: bytes) -> ImageInfo:
    """Reads the version and hash of an MCUboot image (app_update.bin)."""
    if len(data) < HEADER_SIZE:
        raise ImageError("too short to be an MCUboot image")
    magic, _, header_size, _, image_size, _, major, minor, revision, build, _ = struct.unpack_from(HEADER_FORMAT, data)
    if magic != IMAGE_MAGIC:
        raise ImageError("not an MCUboot image (use app_update.bin, not zephyr.bin or a .hex file)")

    offset = header_size + image_size
    while offset + 4 <= len(data):
        info_magic, total = struct.unpack_from("<HH", data, offset)
        if info_magic not in (TLV_INFO_MAGIC, TLV_PROT_INFO_MAGIC):
            break
        end = offset + total
        tlv = offset + 4
        while tlv + 4 <= end:
            tlv_type, tlv_len = struct.unpack_from("<BxH", data, tlv)
            if tlv_type == TLV_SHA256:
                return ImageInfo(
                    version=format_version(major, minor, revision, build),
                    hash=data[tlv + 4: tlv + 4 + tlv_len].hex(),
                    size=len(data),
                    image_size=image_size,
                )
            tlv += 4 + tlv_len
        offset = end
    raise ImageError("no SHA-256 hash in the image (is it signed?)")


def build_image(payload: bytes, version=(0, 0, 0, 0)) -> bytes:
    """Builds a minimal unsigned MCUboot image around 'payload'. For tests and the simulator."""
    major, minor, revision, build = version
    header = struct.pack(HEADER_FORMAT, IMAGE_MAGIC, 0, HEADER_SIZE, 0, len(payload), 0,
                         major, minor, revision, build, 0)
    digest = hashlib.sha256(header + payload).digest()
    tlvs = struct.pack("<BxH", TLV_SHA256, len(digest)) + digest
    return header + payload + struct.pack("<HH", TLV_INFO_MAGIC, 4 + len(tlvs)) + tlvs
