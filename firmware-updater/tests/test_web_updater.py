#!/usr/bin/env python3
"""Tests for the web updater, with the real update script and a fake mcumgr.

Runs on Linux, macOS and Windows (needs bash: Git Bash on Windows); CI runs it on all three.
Usage, from the firmware-updater folder with its requirements installed:
    python tests/test_web_updater.py
"""

import hashlib
import json
import os
import re
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import time

UPDATER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO_DIR = os.path.dirname(UPDATER_DIR)
FAKE_MCUMGR = os.path.join(REPO_DIR, 'scripts', 'tests', 'fake-mcumgr')

failures = []


def check(name, condition, detail=''):
    print(('PASS  ' if condition else 'FAIL  ') + name + ('' if condition else f'  ({detail})'))
    if not condition:
        failures.append(name)


def make_image(path):
    """A minimal signed MCUboot image; returns the SHA-256 hash it reports."""
    body = b'\xa5' * 1000
    digest = hashlib.sha256(body).digest()
    header = struct.pack('<IIHHII', 0x96F3B83D, 0, 32, 0, len(body), 0) + bytes(12)
    tlvs = struct.pack('<BxH', 0x10, 32) + digest + struct.pack('<BxH', 0x22, 8) + bytes(8)
    with open(path, 'wb') as f:
        f.write(header + body + struct.pack('<HH', 0x6907, 4 + len(tlvs)) + tlvs)
    return digest.hex()


def page_scripts(client, page):
    """The JavaScript a page runs, in order: local script files, then inline scripts."""
    html = client.get(page).get_data(as_text=True)
    code = []
    for src, inline in re.findall(r'<script(?:\s+src="([^"]*)")?[^>]*>(.*?)</script>', html, re.S):
        if src.startswith('/static/'):
            with open(os.path.join(UPDATER_DIR, src.lstrip('/')), encoding='utf-8') as f:
                code.append(f.read())
        elif not src:
            code.append(inline)
    return '\n;\n'.join(code)


def main():
    tmp = tempfile.mkdtemp()
    try:
        # Fake device and firmware
        bin_dir = os.path.join(tmp, 'bin')
        state = os.path.join(tmp, 'state')
        build = os.path.join(tmp, 'build')
        for d in (bin_dir, state, os.path.join(build, 'zephyr')):
            os.makedirs(d)
        shutil.copy(FAKE_MCUMGR, os.path.join(bin_dir, 'mcumgr'))
        os.chmod(os.path.join(bin_dir, 'mcumgr'), 0o755 | stat.S_IEXEC)
        image_hash = make_image(os.path.join(build, 'zephyr', 'app_update.bin'))
        with open(os.path.join(state, 'slot0'), 'w') as f:
            f.write('0' * 64 + '\n')
        with open(os.path.join(state, 'new'), 'w') as f:
            f.write(image_hash + '\n')
        open(os.path.join(state, 'calls.log'), 'w').close()

        os.environ['PATH'] = bin_dir + os.pathsep + os.environ['PATH']
        os.environ['FAKE_MCUMGR_STATE'] = state
        os.environ['HACOAP_UPDATER_LOG_DIR'] = os.path.join(tmp, 'logs')
        os.environ['HACOAP_TEST_DEVICES'] = 'ha-coap-1234=fd00::5'

        sys.path.insert(0, UPDATER_DIR)
        import app as webapp
        client = webapp.app.test_client()

        # Pages, and their JavaScript
        node = shutil.which('node')
        for page in ('/', '/devices', '/update'):
            response = client.get(page)
            check(f'GET {page}', response.status_code == 200, response.status_code)
            if node:
                script = os.path.join(tmp, 'page.js')
                with open(script, 'w', encoding='utf-8') as f:
                    f.write(page_scripts(client, page))
                result = subprocess.run([node, '--check', script], capture_output=True, text=True)
                check(f'{page} JavaScript parses', result.returncode == 0, result.stderr.strip()[:300])
        if not node:
            print('SKIP  JavaScript syntax checks (Node.js not installed)')

        # System status
        status = client.get('/api/system_status').get_json()
        check('system status: update script and bash found', status['update_script'] and status['bash'], status)

        # Build directory checks
        data = client.get('/api/check_build_dir', query_string={'build_dir': build}).get_json()
        check('build directory check reports the image', data.get('success') and data['image']['hash'] == image_hash, data)
        data = client.get('/api/check_build_dir', query_string={'build_dir': os.path.join(tmp, 'nope')}).get_json()
        check('build directory check rejects a missing directory', data.get('success') is False, data)

        # Discovery
        data = client.post('/api/discover', json={}).get_json()
        check('discovery returns devices', data.get('success') and data.get('discovery_available')
              and data['devices'] == [{'name': 'ha-coap-1234', 'address': 'fd00::5', 'selected': True}], data)

        # Invalid update requests
        for name, request in [
            ('bad address', {'devices': [{'name': 'x', 'address': 'not-an-ip'}], 'build_dir': build}),
            ('bad name', {'devices': [{'name': 'a;b', 'address': 'fd00::1'}], 'build_dir': build}),
            ('bad build dir', {'devices': [{'name': 'x', 'address': 'fd00::1'}], 'build_dir': os.path.join(tmp, 'nope')}),
            ('bad mode', {'devices': [{'name': 'x', 'address': 'fd00::1'}], 'build_dir': build, 'update_mode': 'yolo'}),
        ]:
            data = client.post('/api/start_update', json=request).get_json()
            check(f'update request rejected: {name}', data.get('success') is False, data)

        # A real update run through the script, with the fake mcumgr
        data = client.post('/api/start_update', json={
            'devices': [{'name': 'plant1', 'address': 'fd00::1'}],
            'build_dir': build, 'update_mode': 'test', 'stall_timeout': 30}).get_json()
        check('update starts', data.get('success'), data)
        deadline = time.time() + 90
        status = {}
        while time.time() < deadline:
            status = client.get('/api/update_status').get_json()
            if status['state'] != 'updating':
                break
            time.sleep(1)
        check('update completes', status.get('state') == 'completed', json.dumps(status))
        check('update counts one success', status.get('successful_updates') == 1 and status.get('failed_updates') == 0, status)
        check('upload progress reaches 100%', status.get('upload_progress') == 100, status.get('upload_progress'))
        with open(os.path.join(state, 'calls.log'), encoding='utf-8') as f:
            calls = f.read()
        check('mcumgr was asked to test the new image', f'image test {image_hash}' in calls, calls)

        # Progress parsing of the script's output (the fake upload is too quick to show it)
        manager = webapp.update_manager
        manager._parse_line('[0;36m  [PROGRESS][0m Upload progress: 42%')
        check('upload progress read from the script output', manager.current_status['upload_progress'] == 42,
              manager.current_status['upload_progress'])

        # Logs and statistics
        data = client.get('/api/log_files').get_json()
        check('update log listed', data.get('success') and len(data['log_files']) == 1, data)
        log = client.get('/api/logs').get_json()
        check('update log has the device result', 'RESULT plant1 success' in log.get('logs', ''), log.get('error'))
        data = client.get('/api/logs', query_string={'log_file': '../app.py'}).get_json()
        check('log reader refuses other files', data.get('success') is False, data)
        stats = client.get('/api/stats').get_json()
        check('statistics count the run', stats['runs'] == 1 and stats['success'] == 1, stats)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print()
    if failures:
        print(f'{len(failures)} test(s) failed.')
        return 1
    print('All tests passed.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
