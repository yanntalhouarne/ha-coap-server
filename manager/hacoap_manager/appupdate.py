"""Whether a newer version of this app is out: asks GitHub for the repository's releases
(tags manager-v<version>). Only when the user turns it on in Settings, or clicks Check now."""

import json
import re
import time
import urllib.error
import urllib.request

from . import __version__

REPOSITORY = "yanntalhouarne/ha-coap-server"
RELEASES_URL = f"https://api.github.com/repos/{REPOSITORY}/releases?per_page=30"
TAG = re.compile(r"manager-v(\d+(?:\.\d+)*)")
CACHE_S = 6 * 3600


def version_tuple(text):
    return tuple(int(part) for part in text.split("."))


def newest(releases):
    """The newest published (not draft or pre-release) app release: (version, page URL), or None."""
    best = None
    for release in releases:
        match = TAG.fullmatch(release.get("tag_name", ""))
        if not match or release.get("draft") or release.get("prerelease"):
            continue
        if best is None or version_tuple(match.group(1)) > version_tuple(best[0]):
            best = (match.group(1), release.get("html_url", ""))
    return best


class UpdateCheck:
    def __init__(self, fetch=None):
        self._fetch = fetch or self._github
        self.last = None

    @staticmethod
    def _github():
        request = urllib.request.Request(RELEASES_URL, headers={
            "Accept": "application/vnd.github+json", "User-Agent": f"hacoap-manager/{__version__}"})
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.loads(response.read())

    def check(self, force=False):
        """{current, latest, url, newer, checked, error}. Asks GitHub at most every 6 hours
        unless forced."""
        if self.last and not force and time.time() - self.last["checked"] < CACHE_S:
            return self.last
        result = {"current": __version__, "latest": None, "url": f"https://github.com/{REPOSITORY}/releases",
                  "newer": False, "checked": time.time(), "error": ""}
        try:
            found = newest(self._fetch())
        except (OSError, urllib.error.URLError, ValueError) as exc:
            result["error"] = f"Couldn't reach GitHub: {exc}"
        else:
            if found:
                result.update(latest=found[0], url=found[1] or result["url"],
                              newer=version_tuple(found[0]) > version_tuple(__version__))
        self.last = result
        return result
