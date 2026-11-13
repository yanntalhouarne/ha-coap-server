"""A problem report: one .zip with what helps to understand a problem (the app's recent log,
settings, devices, update and build history, the last network reading, the build checks),
and nothing secret. The signing key and local.conf are never read into it, and the PSKd is
blanked out of every text, in case a build log printed it."""

import collections
import io
import json
import logging
import platform
import sys
import time
import zipfile

from . import __version__, kconfig

MAX_LOG_LINES = 2000


class RecentLog(logging.Handler):
    """Keeps the app's last log lines in memory, for the problem report."""

    def __init__(self):
        super().__init__(level=logging.INFO)
        self.lines = collections.deque(maxlen=MAX_LOG_LINES)
        self.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))

    def emit(self, record):
        try:
            self.lines.append(self.format(record))
        except Exception:  # noqa: BLE001 - logging must never fail
            pass


recent_log = RecentLog()


def install():
    """Starts keeping the log (once)."""
    root = logging.getLogger()
    if recent_log not in root.handlers:
        root.addHandler(recent_log)
        if root.level > logging.INFO or root.level == logging.NOTSET:
            root.setLevel(logging.INFO)


def _pskd(repository):
    try:
        text = (repository / "application" / "local.conf").read_text(encoding="utf-8")
    except (OSError, TypeError):
        return ""
    return kconfig.conf_values(text).get("OPENTHREAD_JOINER_PSKD", "").strip('"')


def create_report(services, jobs):
    """The report, as the bytes of a .zip file."""
    s = services
    pskd = _pskd(s.repository)

    def clean(text):
        return text.replace(pskd, "<PSKd>") if pskd and len(pskd) >= 6 else text

    def as_json(value):
        return clean(json.dumps(value, indent=2, default=str))

    builds = s.db.builds(limit=20)
    summary = {
        "app_version": __version__, "created": time.strftime("%Y-%m-%d %H:%M:%S %z"),
        "python": sys.version, "platform": platform.platform(), "frozen": bool(getattr(sys, "frozen", False)),
        "data_dir": str(s.data_dir), "repository": str(s.repository) if s.repository else None,
        "devices": len(s.db.devices()), "images": len(s.db.images()),
    }
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("README.txt", "HA-CoAP Fleet Manager problem report. It holds no signing key and no PSKd.\n")
        archive.writestr("summary.json", as_json(summary))
        archive.writestr("log.txt", clean("\n".join(recent_log.lines)) + "\n")
        archive.writestr("settings.json", as_json(s.settings.as_dict()))
        archive.writestr("devices.json", as_json(s.inventory.devices()))
        archive.writestr("images.json", as_json(s.db.images()))
        archive.writestr("updates.json", as_json(s.db.updates(limit=500)))
        archive.writestr("update-jobs.json", as_json(jobs))
        archive.writestr("alerts.json", as_json(s.db.recent_alerts(100)))
        archive.writestr("build-checks.json", as_json(s.builds.checks()))
        archive.writestr("builds.json", as_json(builds))
        for build in builds[:5]:
            full = s.db.build(build["id"], with_log=True)
            if full and full.get("log"):
                archive.writestr(f"build-logs/build-{build['id']}.txt", clean(full["log"]))
        archive.writestr("network.json", as_json(s.network.state()))
    return buffer.getvalue()
