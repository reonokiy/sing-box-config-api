#!/usr/bin/env python3
"""Machine-scoped sing-box synchronization. Credentials never enter argv or logs."""
import argparse
import fcntl
import getpass
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

LIMIT = 1024 * 1024
CONFIG_PATH = Path('/etc/sing-box/config.json')
DATA_DIR = '/var/lib/sing-box'

def atomic(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
        name = stream.name
        os.chmod(name, 0o600)
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    try:
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)

def encode(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n').encode()

def request(settings, suffix, body=None, etag=None):
    url = settings['url'].rstrip('/') + '/v1/agent/' + settings['id'] + '/' + suffix
    headers = {'Accept': 'application/json'}
    if settings.get('token'):
        headers['Authorization'] = 'Bearer ' + settings['token']
    if etag:
        headers['If-None-Match'] = etag
    data = None if body is None else json.dumps(body).encode()
    if data is not None:
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, headers=headers, data=data)
    # Never forward a node credential to redirects or a different host.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    try:
        with urllib.request.build_opener(NoRedirect).open(req, timeout=15) as response:
            raw = response.read(LIMIT + 1)
            if len(raw) > LIMIT:
                raise ValueError('response too large')
            return response.status, response.headers, json.loads(raw)
    except urllib.error.HTTPError as error:
        if error.code == 304:
            return 304, error.headers, None
        raise RuntimeError('control service HTTP ' + str(error.code)) from None

def service(operation):
    result = subprocess.run(['systemctl', operation, 'sing-box.service'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if result.returncode:
        raise RuntimeError('service operation failed')

def healthy():
    for _ in range(5):
        time.sleep(1)
        if subprocess.run(['systemctl', 'is-active', '--quiet', 'sing-box.service'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
            return False
    return True

def report(settings, version, status, running_version=0):
    request(settings, 'status', {'version': version, 'runningVersion': running_version, 'status': status})

def sync(settings, state_dir):
    state_dir = Path(state_dir)
    state_file = state_dir / 'applied.json'
    previous = json.loads(state_file.read_text()) if state_file.exists() else {}
    etag = previous.get('etag')
    if not CONFIG_PATH.exists() or hashlib.sha256(CONFIG_PATH.read_bytes()).hexdigest() != (etag or '').strip('"'):
        etag = None
    status, headers, desired = request(settings, 'config', etag=etag)
    if status == 304:
        version = int(headers['X-Config-Version'])
        current = 'applied' if previous.get('enabled', True) else 'stopped'
        if previous.get('enabled', True) and not healthy():
            try:
                service('restart')
                if not healthy():
                    raise RuntimeError('service unhealthy')
            except Exception:
                report(settings, version, 'failed_start')
                return
        if not previous.get('enabled', True):
            service('stop')
        previous['version'] = version
        atomic(state_file, encode(previous))
        report(settings, version, current, version if current == 'applied' else 0)
        return
    if not isinstance(desired.get('version'), int) or type(desired.get('enabled')) is not bool or not isinstance(desired.get('config'), dict):
        raise ValueError('invalid desired configuration')
    version = desired['version']
    candidate_data = encode(desired['config'])
    if hashlib.sha256(candidate_data).hexdigest() != desired['hash']:
        raise ValueError('configuration hash mismatch')
    failure_file = state_dir / 'failed.json'
    if failure_file.exists():
        failure = json.loads(failure_file.read_text())
        if failure.get('hash') == desired['hash'] and failure.get('version') == version:
            report(settings, version, failure['status'], failure.get('runningVersion', 0))
            return
    with tempfile.TemporaryDirectory(dir=state_dir) as staging:
        candidate = Path(staging) / 'config.json'
        atomic(candidate, candidate_data)
        # Capture and discard output: sing-box diagnostics may include private material.
        result = subprocess.run(['sing-box', 'check', '-D', DATA_DIR, '-c', str(candidate)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
        if result.returncode:
            atomic(failure_file, encode({'version': version, 'hash': desired['hash'], 'status': 'failed_validation', 'runningVersion': previous.get('version', 0) if previous.get('enabled', True) else 0}))
            report(settings, version, 'failed_validation', previous.get('version', 0) if previous.get('enabled', True) else 0)
            return
        config = CONFIG_PATH
        old = config.read_bytes() if config.exists() else None
        atomic(config, candidate_data)
        try:
            service('restart' if desired['enabled'] else 'stop')
            if desired['enabled'] and not healthy():
                raise RuntimeError('service unhealthy')
        except Exception:
            failed = 'failed_start'
            try:
                if old is not None:
                    atomic(config, old)
                    service('restart' if previous.get('enabled', True) else 'stop')
                    if previous.get('enabled', True) and not healthy():
                        failed = 'failed_rollback'
                else:
                    config.unlink(missing_ok=True)
                    service('stop')
            except Exception:
                failed = 'failed_rollback'
            atomic(failure_file, encode({'version': version, 'hash': desired['hash'], 'status': failed, 'runningVersion': previous.get('version', 0) if failed != 'failed_rollback' and previous.get('enabled', True) else 0}))
            report(settings, version, failed, previous.get('version', 0) if failed != 'failed_rollback' and previous.get('enabled', True) else 0)
            return
    atomic(state_file, encode({'version': version, 'enabled': desired['enabled'], 'etag': headers['ETag']}))
    failure_file.unlink(missing_ok=True)
    report(settings, version, 'applied' if desired['enabled'] else 'stopped', version if desired['enabled'] else 0)

def validate_url(url):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError('HTTPS service URL required')
    return url.rstrip('/')

def install(args):
    if not re.fullmatch('[a-z0-9][a-z0-9-]{0,62}', args.id):
        raise ValueError('invalid machine ID')
    settings = {'url': validate_url(args.url), 'id': args.id}
    if shutil.which('sing-box') is None:
        raise RuntimeError('install a compatible sing-box first')
    code = getpass.getpass('One-time enrollment code: ')
    _, _, result = request(settings, 'enroll', {'code': code})
    token = result.get('token', '')
    if not re.fullmatch('sba_[A-Za-z0-9_-]{43}', token):
        raise ValueError('invalid enrollment response')
    settings['token'] = token
    directory = Path('/etc/sing-box-sync')
    directory.mkdir(mode=0o700, exist_ok=True)
    os.chmod(directory, 0o700)
    atomic(directory / 'settings.json', encode(settings))
    atomic('/usr/local/lib/sing-box-sync.py', Path(__file__).read_bytes())
    Path('/var/lib/sing-box-sync').mkdir(mode=0o700, exist_ok=True)
    Path('/var/lib/sing-box').mkdir(mode=0o700, exist_ok=True)
    atomic('/etc/systemd/system/sing-box-sync.service', b'[Unit]\nDescription=Synchronize managed sing-box configuration\nWants=network-online.target\nAfter=network-online.target\n[Service]\nType=oneshot\nExecStart=/usr/bin/python3 /usr/local/lib/sing-box-sync.py sync\nUMask=0077\nTimeoutStartSec=120\n')
    atomic('/etc/systemd/system/sing-box-sync.timer', b'[Unit]\nDescription=Poll managed sing-box configuration\n[Timer]\nOnBootSec=15s\nOnUnitInactiveSec=30s\nRandomizedDelaySec=5s\n[Install]\nWantedBy=timers.target\n')
    subprocess.run(['systemctl', 'daemon-reload'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(['systemctl', 'enable', '--now', 'sing-box-sync.timer'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print('Enrolled. Synchronization starts within 35 seconds.')

def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest='command', required=True)
    enroll = commands.add_parser('install')
    enroll.add_argument('--url', required=True)
    enroll.add_argument('--id', required=True)
    commands.add_parser('sync')
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('run as root')
    try:
        if args.command == 'install':
            install(args)
        else:
            state_dir = Path('/var/lib/sing-box-sync')
            state_dir.mkdir(mode=0o700, exist_ok=True)
            with (state_dir / 'lock').open('a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                settings = json.loads(Path('/etc/sing-box-sync/settings.json').read_text())
                validate_url(settings['url'])
                sync(settings, state_dir)
    except Exception:
        # No exception text, subprocess output, URL, headers or body is logged.
        print('Synchronization failed; previous configuration retained.', file=sys.stderr)
        return 1
    return 0

if __name__ == '__main__':
    sys.exit(main())
