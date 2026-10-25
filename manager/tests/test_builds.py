import asyncio
import shutil
import sys
import textwrap
from pathlib import Path

import pytest

from hacoap_manager import builds, kconfig
from hacoap_manager.builds import BuildError, BuildRunner
from hacoap_manager.db import Database
from hacoap_manager.events import EventBus
from hacoap_manager.images import ImageLibrary

REPOSITORY = Path(__file__).resolve().parents[2]

# Stands in for scripts/build: writes an image into the variant's build folder, and prints
# what the real build prints about the signing key.
FAKE_BUILD = textwrap.dedent("""
    import os, sys, time
    sys.path.insert(0, sys.argv[3])
    from hacoap_manager import mcuboot
    variant, repository = sys.argv[1], sys.argv[2]
    conf = open(os.environ["HACOAP_EXTRA_CONF"]).read()
    print("Merged configuration", os.environ["HACOAP_EXTRA_CONF"])
    key = os.path.join(repository, "application", "keys", "mcuboot-signing-key.pem")
    print("-- MCUboot signing key: " + key if os.path.exists(key) else "CMake Warning: No private signing key")
    time.sleep(float(os.environ.get("FAKE_BUILD_SLEEP", "0")))
    if os.environ.get("FAKE_BUILD_EXIT"):
        print("FAILED: something")
        sys.exit(int(os.environ["FAKE_BUILD_EXIT"]))
    folder = os.path.join(repository, "application", "build" if variant == "battery" else "build_" + variant.replace("-", "_"), "zephyr")
    os.makedirs(folder, exist_ok=True)
    open(os.path.join(folder, "app_update.bin"), "wb").write(mcuboot.build_image(conf.encode(), (0, 0, 0, 0)))
    print("done")
""")


@pytest.fixture
def repo(tmp_path):
    """A checkout with the real Kconfig and prj.conf, a fake SDK and a signing key."""
    root = tmp_path / "repo"
    (root / "application" / "keys").mkdir(parents=True)
    (root / "external" / "zephyr").mkdir(parents=True)
    for name in ("Kconfig", "prj.conf"):
        shutil.copy(REPOSITORY / "application" / name, root / "application" / name)
    (root / "application" / "keys" / "mcuboot-signing-key.pem").write_text("key")
    (root / "application" / "local.conf").write_text('CONFIG_OPENTHREAD_JOINER_PSKD="ABCDEF"\n')
    (root / "fake_build.py").write_text(FAKE_BUILD)
    return root


@pytest.fixture
def runner(tmp_path, repo, monkeypatch):
    monkeypatch.setattr(builds, "find_nrfutil", lambda: "nrfutil")
    db = Database(tmp_path / "test.db")
    events = EventBus()
    manager_dir = str(Path(__file__).resolve().parents[1])

    def command(repository, variant):
        return [sys.executable, str(repository / "fake_build.py"), variant, str(repository), manager_dir]

    runner = BuildRunner(repo, tmp_path / "data", db, ImageLibrary(tmp_path / "data", db), events, command)
    db.save_profile("Production", "battery", {})
    yield runner
    db.close()


# ---------------------------------------------------------------- the settings schema

def test_schema_from_the_repository():
    schema = {s["name"]: s for s in kconfig.load_schema(REPOSITORY)}
    sample = schema["HACOAP_SENSOR_SAMPLE_PERIOD_S"]
    assert (sample["type"], sample["menu"], sample["range"]) == ("int", "Sensors", [10, 86400])
    assert sample["help"].startswith("The sensors are sampled")
    assert schema["HACOAP_HW_VERSION"]["default"] == "v2.0"
    suffix = schema["HACOAP_SRP_NAME_SUFFIX"]
    assert suffix["type"] == "choice" and suffix["default"] == "HACOAP_SRP_SUFFIX_DEVICE_ID"
    assert [o["name"] for o in suffix["options"]][:2] == ["HACOAP_SRP_SUFFIX_DEVICE_ID", "HACOAP_SRP_SUFFIX_RANDOM"]
    assert schema["HACOAP_SRP_MANUAL_ID"]["depends_on"] == "HACOAP_SRP_SUFFIX_MANUAL"
    assert schema["OPENTHREAD_POLL_PERIOD"]["default"] == 3000  # from prj.conf
    assert "COAP_SERVER_LOG_LEVEL" not in schema


def test_validate():
    schema = kconfig.load_schema(REPOSITORY)
    assert kconfig.validate(schema, {"HACOAP_SENSOR_SAMPLE_PERIOD_S": "600"}) == {"HACOAP_SENSOR_SAMPLE_PERIOD_S": 600}
    bad = [
        ({"HACOAP_SENSOR_SAMPLE_PERIOD_S": 5}, "from 10"),
        ({"HACOAP_PUMP_MAX_DURATION": "lots"}, "whole number"),
        ({"NOT_A_SETTING": 1}, "Unknown"),
        ({"HACOAP_HW_VERSION": 'v2"'}, "quotes"),
        ({"HACOAP_SRP_NAME_SUFFIX": "HACOAP_NOPE"}, "unknown option"),
        ({"HACOAP_SOIL_WET_MV": 2500}, "dry soil"),
        ({"HACOAP_WDT_FEED_PERIOD_MS": 40000}, "watchdog"),
        ({"OPENTHREAD_POLL_PERIOD": 100}, "mcumgr"),
    ]
    for settings, message in bad:
        with pytest.raises(kconfig.KconfigError, match=message):
            kconfig.validate(schema, settings)


def test_conf_file():
    schema = kconfig.load_schema(REPOSITORY)
    conf = kconfig.to_conf(schema, {"HACOAP_SENSOR_SAMPLE_PERIOD_S": 600, "HACOAP_HW_VERSION": "v2.1",
                                    "HACOAP_SRP_NAME_SUFFIX": "HACOAP_SRP_SUFFIX_RANDOM"}, "test")
    assert "CONFIG_HACOAP_SENSOR_SAMPLE_PERIOD_S=600\n" in conf
    assert 'CONFIG_HACOAP_HW_VERSION="v2.1"\n' in conf
    assert "CONFIG_HACOAP_SRP_SUFFIX_RANDOM=y\n" in conf


# ---------------------------------------------------------------- checks

def test_checks(repo, monkeypatch):
    monkeypatch.setattr(builds, "find_nrfutil", lambda: None)
    result = {c["name"]: c for c in builds.checks(repo)}
    assert result["SDK"]["ok"] and result["Private signing key"]["ok"] and result["Private PSKd"]["ok"]
    assert not result["nRF Connect toolchain"]["ok"]
    (repo / "application" / "local.conf").write_text('CONFIG_OPENTHREAD_JOINER_PSKD="J01NU5"\n')
    assert not {c["name"]: c for c in builds.checks(repo)}["Private PSKd"]["ok"]
    assert builds.checks(None)[0]["ok"] is False


# ---------------------------------------------------------------- builds

async def test_build_adds_the_image(runner):
    runner.db.save_profile("Greenhouse", "usb-logging", {"HACOAP_SENSOR_SAMPLE_PERIOD_S": 600})
    lines = []
    with runner.events.subscribe() as queue:
        build = runner.start("Greenhouse")
        assert build["result"] == "running"
        build = await asyncio.wait_for(runner.wait(), 30)
        while not queue.empty():
            event = queue.get_nowait()
            if event["type"] == "build-log":
                lines.append(event["line"])
    assert build["result"] == "done", build
    assert build["signing"] == "private"
    image = runner.db.image(build["image_hash"])
    assert image is not None and "Greenhouse (usb-logging" in image["notes"]
    # The settings reached the build through $HACOAP_EXTRA_CONF
    assert b"CONFIG_HACOAP_SENSOR_SAMPLE_PERIOD_S=600" in runner.images.data(build["image_hash"])
    assert (runner.repository / "application" / "build_usb_logging" / "zephyr" / "app_update.bin").exists()
    assert "done" in lines
    assert "done" in runner.db.build(build["id"], with_log=True)["log"]


async def test_development_key_needs_a_confirmation(runner):
    (runner.repository / "application" / "keys" / "mcuboot-signing-key.pem").unlink()
    with pytest.raises(BuildError, match="No private signing key"):
        runner.start("Production")
    runner.start("Production", allow_development_key=True)
    build = await asyncio.wait_for(runner.wait(), 30)
    assert (build["result"], build["signing"]) == ("done", "development")
    assert "DEVELOPMENT KEY" in runner.db.image(build["image_hash"])["notes"]


async def test_failed_build(runner, monkeypatch):
    monkeypatch.setenv("FAKE_BUILD_EXIT", "1")
    runner.start("Production")
    build = await asyncio.wait_for(runner.wait(), 30)
    assert build["result"] == "failed" and "exit code 1" in build["message"]
    assert runner.db.images() == []


async def test_cancel(runner, monkeypatch):
    monkeypatch.setenv("FAKE_BUILD_SLEEP", "30")
    runner.start("Production")
    with pytest.raises(BuildError, match="already running"):
        runner.start("Production")
    while runner._process is None:
        await asyncio.sleep(0.05)
    await asyncio.sleep(0.5)
    runner.cancel()
    build = await asyncio.wait_for(runner.wait(), 20)
    assert build["result"] == "cancelled"


async def test_missing_toolchain_stops_the_build(runner, monkeypatch):
    monkeypatch.setattr(builds, "find_nrfutil", lambda: None)
    with pytest.raises(BuildError, match="toolchain"):
        runner.start("Production")


async def test_invalid_profile_settings_stop_the_build(runner):
    runner.db.save_profile("Broken", "battery", {"HACOAP_SENSOR_SAMPLE_PERIOD_S": 1})
    with pytest.raises(kconfig.KconfigError):
        runner.start("Broken")
    with pytest.raises(BuildError, match="Unknown profile"):
        runner.start("Nope")
