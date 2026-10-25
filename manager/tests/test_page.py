import json
import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "hacoap_manager" / "static" / "app.js"


def test_page_script_parses():
    """A syntax error in app.js would leave the page blank. CI has Node.js; elsewhere this
    uses mini-racer if it's installed, or is skipped."""
    node = shutil.which("node")
    if node:
        result = subprocess.run([node, "--check", str(SCRIPT)], capture_output=True, text=True)
        assert result.returncode == 0, result.stderr
        return
    try:
        from py_mini_racer import MiniRacer
    except ImportError:
        pytest.skip("neither Node.js nor mini-racer is available")
    source = json.dumps(SCRIPT.read_text(encoding="utf-8"))
    check = "(function (s) { try { new Function(s); return 'ok'; } catch (e) { return String(e); } })"
    assert MiniRacer().eval(f"{check}({source})") == "ok"
