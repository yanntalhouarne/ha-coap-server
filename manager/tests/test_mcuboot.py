import hashlib
import struct

import pytest

from hacoap_manager import mcuboot


def test_parse_reads_version_and_hash():
    image = mcuboot.build_image(b"x" * 1000, (1, 2, 3, 0))
    info = mcuboot.parse_image(image)
    assert info.version == "1.2.3+0"
    assert info.mcumgr_version == "1.2.3"
    assert info.hash == hashlib.sha256(image[:mcuboot.HEADER_SIZE + 1000]).hexdigest()
    assert info.size == len(image)
    assert info.image_size == 1000


def test_build_number_shows_like_mcumgr():
    info = mcuboot.parse_image(mcuboot.build_image(b"x", (2, 0, 1, 7)))
    assert info.mcumgr_version == "2.0.1.7"


def test_rejects_other_files():
    with pytest.raises(mcuboot.ImageError, match="not an MCUboot image"):
        mcuboot.parse_image(b"\x00" * 64)
    with pytest.raises(mcuboot.ImageError, match="too short"):
        mcuboot.parse_image(b"\x3d\xb8")


def test_rejects_an_image_without_hash():
    image = mcuboot.build_image(b"x" * 100)
    without_tlvs = image[:mcuboot.HEADER_SIZE + 100] + struct.pack("<HH", mcuboot.TLV_INFO_MAGIC, 4)
    with pytest.raises(mcuboot.ImageError, match="no SHA-256"):
        mcuboot.parse_image(without_tlvs)


def test_finds_the_hash_after_protected_tlvs():
    image = bytearray(mcuboot.build_image(b"x" * 100))
    tlv_start = mcuboot.HEADER_SIZE + 100
    protected = struct.pack("<HH", mcuboot.TLV_PROT_INFO_MAGIC, 4 + 8) + struct.pack("<BxH", 0x50, 4) + b"\x01\x02\x03\x04"
    patched = bytes(image[:tlv_start]) + protected + bytes(image[tlv_start:])
    assert mcuboot.parse_image(patched).hash == mcuboot.parse_image(bytes(image)).hash
