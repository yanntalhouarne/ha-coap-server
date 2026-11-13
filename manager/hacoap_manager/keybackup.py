"""Your private signing key, encrypted with a passphrase, in the app's backups: the boards whose
bootloader was made with your key only take updates signed with it, so losing every copy of it
would mean reflashing each board over SWD.

The key is encrypted once, when you choose a passphrase (scrypt, then AES-256-GCM), and the
passphrase is never kept: the backups (and wherever they're copied) only hold what it opens.
Putting the key back asks for the passphrase and writes the key where the builds look for it
(application/keys/mcuboot-signing-key.pem). Without the app, on any computer with Python and the
`cryptography` package:

    python -m hacoap_manager.keybackup <signing-key.enc, or a backup .zip> <where to write the key>
"""

import base64
import hashlib
import io
import json
import os
import sys
import time
import zipfile
from pathlib import Path

FILE = "signing-key.enc"          # in the data folder, and in each backup
FORMAT = "hacoap-signing-key/1"
MIN_PASSPHRASE = 12
SCRYPT_N, SCRYPT_R, SCRYPT_P = 2 ** 15, 8, 1  # 32 MB, a fraction of a second


class KeyBackupError(Exception):
    pass


def key_path(repository):
    """Where the builds look for your private key (application/keys/mcuboot-signing-key.pem)."""
    return Path(repository) / "application" / "keys" / "mcuboot-signing-key.pem"


def fingerprint(pem):
    """The start of the SHA-256 of a private key's public half (as `ede472ba…`), or None."""
    from cryptography.hazmat.primitives import serialization

    try:
        key = serialization.load_pem_private_key(pem, None)
    except (ValueError, TypeError):
        return None
    public = key.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    return hashlib.sha256(public).hexdigest()[:16]


def _derive(passphrase, salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P):
    from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

    return Scrypt(salt=salt, length=32, n=n, r=r, p=p).derive(passphrase.encode("utf-8"))


def encrypt(pem, passphrase):
    """The key, encrypted with the passphrase: a small JSON document."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    if len(passphrase or "") < MIN_PASSPHRASE:
        raise KeyBackupError(f"Choose a passphrase of {MIN_PASSPHRASE} characters or more")
    print_ = fingerprint(pem)
    if print_ is None:
        raise KeyBackupError("That isn't a private key (or it's protected by a password already)")
    salt, nonce = os.urandom(16), os.urandom(12)
    data = AESGCM(_derive(passphrase, salt)).encrypt(nonce, pem, print_.encode())
    b64 = lambda raw: base64.b64encode(raw).decode()  # noqa: E731
    return json.dumps({"format": FORMAT, "fingerprint": print_, "created": time.time(),
                       "kdf": {"name": "scrypt", "n": SCRYPT_N, "r": SCRYPT_R, "p": SCRYPT_P, "salt": b64(salt)},
                       "cipher": "AES-256-GCM", "nonce": b64(nonce), "data": b64(data)}, indent=2).encode()


def read(blob):
    """The encrypted copy's description: {fingerprint, created}. Raises KeyBackupError."""
    try:
        doc = json.loads(blob)
        if doc.get("format") != FORMAT:
            raise ValueError("not this format")
        return doc
    except (ValueError, TypeError, AttributeError) as exc:
        raise KeyBackupError(f"Not an encrypted signing key ({exc})") from exc


def decrypt(blob, passphrase):
    """The key (PEM) from its encrypted copy. Raises KeyBackupError (a wrong passphrase too)."""
    from cryptography.exceptions import InvalidTag
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    doc = read(blob)
    kdf = doc["kdf"]
    try:
        key = _derive(passphrase or "", base64.b64decode(kdf["salt"]), kdf["n"], kdf["r"], kdf["p"])
        pem = AESGCM(key).decrypt(base64.b64decode(doc["nonce"]), base64.b64decode(doc["data"]),
                                  doc["fingerprint"].encode())
    except InvalidTag as exc:
        raise KeyBackupError("Wrong passphrase") from exc
    except (KeyError, ValueError, TypeError) as exc:
        raise KeyBackupError(f"The encrypted key is damaged ({exc})") from exc
    if fingerprint(pem) != doc["fingerprint"]:
        raise KeyBackupError("The encrypted key is damaged")
    return pem


def from_file(data):
    """The encrypted copy from a signing-key.enc file or from a backup (.zip)."""
    if data[:2] == b"PK":
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                return archive.read(FILE)
        except KeyError as exc:
            raise KeyBackupError("This backup has no signing key in it") from exc
        except zipfile.BadZipFile as exc:
            raise KeyBackupError(f"Not a backup ({exc})") from exc
    return data


def status(repository, data_dir):
    """{here: your key in the checkout, its fingerprint; saved: the encrypted copy in the backups,
    its fingerprint and when it was made; matches: the copy is of the key here}."""
    path = key_path(repository) if repository else None
    here = None
    if path is not None and path.is_file():
        try:
            here = fingerprint(path.read_bytes())
        except OSError:
            here = None
    saved = None
    file = Path(data_dir) / FILE
    if file.is_file():
        try:
            doc = read(file.read_bytes())
            saved = {"fingerprint": doc["fingerprint"], "created": doc.get("created")}
        except (OSError, KeyBackupError, KeyError):
            saved = None
    return {"here": here, "saved": saved, "matches": bool(here and saved and saved["fingerprint"] == here),
            "can_restore": bool(saved and repository and not (path and path.is_file()))}


def save(repository, data_dir, passphrase):
    """Encrypts the key in the checkout into the data folder (the backups then carry it)."""
    path = key_path(repository) if repository else None
    if path is None or not path.is_file():
        raise KeyBackupError("There's no private signing key on this computer (application/keys/)")
    blob = encrypt(path.read_bytes(), passphrase)
    target = Path(data_dir) / FILE
    partial = target.with_name(FILE + ".part")
    partial.write_bytes(blob)
    partial.replace(target)
    return status(repository, data_dir)


def remove(data_dir):
    (Path(data_dir) / FILE).unlink(missing_ok=True)


def write_key(pem, path):
    """Writes a private key readable by this user only. Refuses to replace a different key."""
    path = Path(path)
    if path.is_file():
        if fingerprint(path.read_bytes()) == fingerprint(pem):
            return path  # the same key: nothing to do
        raise KeyBackupError(f"A different key is at {path} already: move it away first")
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(pem)
    return path


def restore(repository, data_dir, passphrase):
    """Puts the key back from its encrypted copy, where the builds look for it."""
    if not repository:
        raise KeyBackupError("There's no firmware checkout on this computer to put the key in")
    file = Path(data_dir) / FILE
    if not file.is_file():
        raise KeyBackupError("There's no encrypted signing key here: restore a backup that has one first")
    write_key(decrypt(file.read_bytes(), passphrase), key_path(repository))
    return status(repository, data_dir)


def main(argv=None):
    """python -m hacoap_manager.keybackup <signing-key.enc or backup.zip> <key.pem>"""
    import getpass

    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) != 2:
        print(__doc__.strip().splitlines()[-1].strip(), file=sys.stderr)
        return 2
    try:
        blob = from_file(Path(args[0]).read_bytes())
        doc = read(blob)
        pem = decrypt(blob, getpass.getpass(f"Passphrase for the signing key {doc['fingerprint']}: "))
        path = write_key(pem, args[1])
    except (OSError, KeyBackupError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    print(f"The signing key {doc['fingerprint']} is in {path} (readable by you only). Keep it private.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
