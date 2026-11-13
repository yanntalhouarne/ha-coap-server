import shutil
import subprocess
from pathlib import Path

import pytest

MODULES = sorted((Path(__file__).resolve().parents[1] / "hacoap_manager" / "static" / "js").glob("*.js"))


@pytest.mark.parametrize("module", MODULES, ids=[m.name for m in MODULES])
def test_page_modules_parse(module, tmp_path):
    """A syntax error in a page module would leave the page blank. Checked with Node.js (CI has it),
    as an ES module; skipped where it isn't installed (the browser test still loads them all)."""
    node = shutil.which("node")
    if not node:
        pytest.skip("Node.js isn't installed")
    copy = tmp_path / (module.stem + ".mjs")  # .mjs: Node reads it as a module, with import and export
    copy.write_text(module.read_text(encoding="utf-8"), encoding="utf-8")
    result = subprocess.run([node, "--check", str(copy)], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_every_import_exists():
    """Each module imports names the other module exports (a typo would only show in the browser)."""
    import re
    exported = {}
    for module in MODULES:
        text = module.read_text(encoding="utf-8")
        exported[module.name] = set(re.findall(r"^export (?:async function|function|const|let|class) (\w+)", text, re.M))
    for module in MODULES:
        for names, source in re.findall(r"^import \{ ([^}]+) \} from '\./([\w.]+)';", module.read_text(encoding="utf-8"), re.M):
            for name in (n.strip() for n in names.split(",")):
                assert name in exported[source], f"{module.name} imports {name}, which {source} doesn't export"


def test_page_ids_are_unique():
    """Two elements with one ID: the script finds the wrong one (it once wiped a Settings card)."""
    import re
    page = (Path(__file__).resolve().parents[1] / "hacoap_manager" / "static" / "index.html").read_text(encoding="utf-8")
    ids = re.findall(r'\bid="([^"]+)"', page)
    assert not {i for i in ids if ids.count(i) > 1}
