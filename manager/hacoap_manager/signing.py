"""Who signed a firmware image. Boards only boot images signed with the key their bootloader
was built with, so the app checks an image's ECDSA P-256 signature against your signing key
before uploading it, rather than finding out from a reverted update.

Your key's public half is kept in the data folder (signing-public-key.pem: it isn't secret),
so the check still works on a computer that doesn't have the private key.
"""

from pathlib import Path

from . import builds, mcuboot

PUBLIC_KEY_FILE = "signing-public-key.pem"
TLV_ECDSA_P256 = 0x22
TLV_OTHER_SIGNATURES = {0x20, 0x21, 0x23, 0x24, 0x25}  # RSA, ECDSA P-224, Ed25519, ...

# The public half of MCUboot's development key (root-ec-p256.pem in MCUboot's repository), which
# builds use when there's no private key. Everyone has it, so your bootloader doesn't trust it.
DEVELOPMENT_KEY = b"""-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEKstAPOj+7VukSZWhqR2u6Nu+GTfN
FPsvJFc35ZU5iNmUudZa69fN1TCK1v5IskpqgQ7l8H2LaDTMOmr8U476wQ==
-----END PUBLIC KEY-----
"""

SIGNERS = {
    "yours": "Signed with your key",
    "development": "Signed with MCUboot's public development key: boards with your bootloader refuse it",
    "other": "Signed with a key that isn't yours: boards with your bootloader refuse it",
    "unsigned": "Not signed: real boards refuse it (the simulator accepts it)",
    "unknown": "Not checked: this computer has no copy of your signing key (build here once, or copy "
               "application/keys/ into the checkout)",
}
REFUSED = {"development", "other", "unsigned"}  # a board with your bootloader won't boot these


def _verifies(public_key, signature, digest):
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec, utils

    if len(signature) > 2 and signature[0] == 0x30:
        signature = signature[:2 + signature[1]]  # older imgtool pads the DER signature with zeros
    try:
        public_key.verify(signature, digest, ec.ECDSA(utils.Prehashed(hashes.SHA256())))
        return True
    except (InvalidSignature, ValueError):
        return False


class SigningCheck:
    def __init__(self, repository, data_dir):
        self.repository = repository
        self.public_file = Path(data_dir) / PUBLIC_KEY_FILE
        self._cache = {}

    def public_key(self):
        """Your key's public half: from the private key in the checkout (keeping a copy), else
        the copy. None if neither is there."""
        from cryptography.hazmat.primitives import serialization

        private = builds.signing_key(self.repository) if self.repository else None
        if private is not None:
            try:
                key = serialization.load_pem_private_key(private.read_bytes(), None).public_key()
            except (OSError, ValueError, TypeError):  # unreadable, or protected by a password
                key = None
            if key is not None:
                pem = key.public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
                try:
                    if not self.public_file.is_file() or self.public_file.read_bytes() != pem:
                        self.public_file.write_bytes(pem)
                except OSError:
                    pass
                return key
        try:
            return serialization.load_pem_public_key(self.public_file.read_bytes())
        except (OSError, ValueError):
            return None

    def signer(self, data, key=None):
        """'yours', 'development', 'other', 'unsigned' or 'unknown' (no key to check against).
        'key' is your public key, if already loaded."""
        from cryptography.hazmat.primitives import serialization

        found = mcuboot.tlvs(data)
        signature, digest = found.get(TLV_ECDSA_P256), found.get(mcuboot.TLV_SHA256)
        mine = key if key is not None else self.public_key()
        if signature is None or digest is None:
            if TLV_OTHER_SIGNATURES & set(found):
                return "other" if mine else "unknown"
            return "unsigned"
        if mine is not None and _verifies(mine, signature, digest):
            return "yours"
        if _verifies(serialization.load_pem_public_key(DEVELOPMENT_KEY), signature, digest):
            return "development"
        return "other" if mine else "unknown"

    def check(self, image_hash, read, key=None):
        """{"signer", "detail"} for an image in the library, remembered per key. 'read' returns
        the image's bytes (only called when it isn't remembered)."""
        key = key if key is not None else self.public_key()
        cache_key = (image_hash, _fingerprint(key))
        if cache_key not in self._cache:
            data = read()
            if data is None:
                return {"signer": "unknown", "detail": "The image file is missing"}
            signer = self.signer(data, key)
            self._cache[cache_key] = {"signer": signer, "detail": SIGNERS[signer]}
        return self._cache[cache_key]


def _fingerprint(key):
    if key is None:
        return None
    from cryptography.hazmat.primitives import serialization
    return key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
