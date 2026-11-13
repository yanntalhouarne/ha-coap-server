"""Your signing key in the backups, encrypted with a passphrase: saved, carried by a backup, put
back on another computer, and decrypted without the app. Always with a made-up key."""

import io
import zipfile

import httpx
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from hacoap_manager import backup, keybackup
from hacoap_manager.app import create_app, create_services
from hacoap_manager.signing import SigningCheck

CHANGE = {"X-HACoap": "1"}
PASSPHRASE = "correct horse battery staple"


def made_up_key():
    key = ec.generate_private_key(ec.SECP256R1())
    return key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())


@pytest.fixture
def repo(tmp_path):
    """A firmware checkout with a made-up key (never the real one)."""
    path = keybackup.key_path(tmp_path / "repo")
    path.parent.mkdir(parents=True)
    path.write_bytes(made_up_key())
    return tmp_path / "repo"


@pytest.fixture
def services(tmp_path, repo):
    services = create_services(tmp_path / "data", discover=None)
    services.repository = repo
    services.signing = SigningCheck(None, tmp_path / "data")
    yield services
    services.console.close()
    services.db.close()


@pytest.fixture
async def client(services):
    app = create_app(services, background_tasks=False)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8710") as client:
        yield client


def test_encrypted_and_opened_with_its_passphrase_only():
    pem = made_up_key()
    blob = keybackup.encrypt(pem, PASSPHRASE)
    assert b"PRIVATE KEY" not in blob and keybackup.read(blob)["fingerprint"] == keybackup.fingerprint(pem)
    assert keybackup.decrypt(blob, PASSPHRASE) == pem
    with pytest.raises(keybackup.KeyBackupError, match="Wrong passphrase"):
        keybackup.decrypt(blob, PASSPHRASE + "!")
    with pytest.raises(keybackup.KeyBackupError, match="12 characters"):
        keybackup.encrypt(pem, "short")
    tampered = blob.replace(b'"data": "', b'"data": "AAAA')
    with pytest.raises(keybackup.KeyBackupError):
        keybackup.decrypt(tampered, PASSPHRASE)


async def test_the_key_goes_in_the_backups_and_comes_back(client, services, repo, tmp_path):
    key_file = keybackup.key_path(repo)
    here = keybackup.fingerprint(key_file.read_bytes())
    state = (await client.get("/api/signing-key/backup")).json()
    assert state == {"here": here, "saved": None, "matches": False, "can_restore": False}
    differ = await client.post("/api/signing-key/backup", json={"passphrase": PASSPHRASE, "again": "other"}, headers=CHANGE)
    assert differ.status_code == 400 and "differ" in differ.json()["detail"]
    short = await client.post("/api/signing-key/backup", json={"passphrase": "short", "again": "short"}, headers=CHANGE)
    assert short.status_code == 400
    saved = await client.post("/api/signing-key/backup", json={"passphrase": PASSPHRASE, "again": PASSPHRASE}, headers=CHANGE)
    assert saved.status_code == 200 and saved.json()["matches"] and saved.json()["saved"]["fingerprint"] == here
    assert not any(services.data_dir.rglob("*passphrase*"))
    assert PASSPHRASE.encode() not in (services.data_dir / keybackup.FILE).read_bytes()
    # A backup is made at once, and carries it (encrypted)
    newest = backup.newest_auto_backup(services.data_dir)
    with zipfile.ZipFile(newest) as archive:
        assert keybackup.read(archive.read(keybackup.FILE))["fingerprint"] == here
        assert b"PRIVATE KEY" not in archive.read(keybackup.FILE)
    file = await client.get("/api/signing-key/backup/file")
    assert file.status_code == 200 and keybackup.read(file.content)["fingerprint"] == here

    # Another computer: the backup restored, no key in its checkout yet
    zipped = newest.read_bytes()
    (services.data_dir / keybackup.FILE).unlink()
    key_file.unlink()
    await client.post("/api/restore", content=zipped, headers=CHANGE)
    state = (await client.get("/api/signing-key/backup")).json()
    assert state["here"] is None and state["can_restore"] and state["saved"]["fingerprint"] == here
    wrong = await client.post("/api/signing-key/restore", json={"passphrase": "not the passphrase"}, headers=CHANGE)
    assert wrong.status_code == 400 and wrong.json()["detail"] == "Wrong passphrase" and not key_file.exists()
    back = await client.post("/api/signing-key/restore", json={"passphrase": PASSPHRASE}, headers=CHANGE)
    assert back.status_code == 200 and back.json()["matches"]
    assert keybackup.fingerprint(key_file.read_bytes()) == here

    # Another key on this computer now: the backups' is said to be older, and is never written over it
    key_file.unlink()
    key_file.write_bytes(made_up_key())
    state = (await client.get("/api/signing-key/backup")).json()
    assert state["saved"] and not state["matches"] and not state["can_restore"]
    with pytest.raises(keybackup.KeyBackupError, match="different key"):
        keybackup.restore(repo, services.data_dir, PASSPHRASE)
    removed = (await client.delete("/api/signing-key/backup", headers=CHANGE)).json()
    assert removed["saved"] is None


def test_decrypted_without_the_app(tmp_path, monkeypatch, capsys):
    pem = made_up_key()
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("manifest.json", "{}")
        archive.writestr(keybackup.FILE, keybackup.encrypt(pem, PASSPHRASE))
    zipped = tmp_path / "backup.zip"
    zipped.write_bytes(buffer.getvalue())
    monkeypatch.setattr("getpass.getpass", lambda prompt="": PASSPHRASE)
    out = tmp_path / "keys" / "mcuboot-signing-key.pem"
    assert keybackup.main([str(zipped), str(out)]) == 0
    assert out.read_bytes() == pem and "readable by you only" in capsys.readouterr().out
    monkeypatch.setattr("getpass.getpass", lambda prompt="": "wrong passphrase!")
    assert keybackup.main([str(zipped), str(tmp_path / "other.pem")]) == 1
    assert "Wrong passphrase" in capsys.readouterr().err
