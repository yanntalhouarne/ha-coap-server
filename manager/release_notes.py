"""Prints a version's section of CHANGELOG.md, for the GitHub release (manager-release.yml).

    python release_notes.py 0.2.0
"""

import sys
from pathlib import Path


def notes(version, text):
    lines, inside = [], False
    for line in text.splitlines():
        if line.startswith("## "):
            if inside:
                break
            inside = line[3:].split()[0].strip("[]") == version
            continue
        if inside:
            lines.append(line)
    if not inside and not lines:
        raise SystemExit(f"No section for {version} in CHANGELOG.md")
    return "\n".join(lines).strip() + "\n\nDownloads: see the assets below, and README.md inside each zip.\n"


if __name__ == "__main__":
    print(notes(sys.argv[1], (Path(__file__).parent / "CHANGELOG.md").read_text(encoding="utf-8")))
