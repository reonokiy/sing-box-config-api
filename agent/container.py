#!/usr/bin/env python3
"""An agent daemon manages one independent sing-box container through Docker."""
import argparse
import fcntl
import getpass
import http.client
import json
import os
from pathlib import Path
import random
import re
import signal
import socket
import threading
import time
import sync

ROOT = Path('/var/lib/managed-sing-box')

class UnixConnection(http.client.HTTPConnection):
    def __init__(self):
        super().__init__('localhost', timeout=35)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect('/var/run/docker.sock')


class Docker:
    def __init__(self):
        version = self.request('GET', '/version', versioned=False)['ApiVersion']
        if not re.fullmatch(r'1\.[0-9]{2,3}', version) or int(version.split('.')[1]) < 45:
            raise RuntimeError('Docker 26 or later required')
        self.version = '/v' + version

    def request(self, method, path, body=None, versioned=True, allow_missing=False, raw=False):
        connection = UnixConnection()
        try:
            connection.request(method, (self.version if versioned else '') + path,
                               None if body is None else json.dumps(body).encode(),
                               {'Content-Type': 'application/json'})
            response = connection.getresponse()
            if response.status == 404 and allow_missing:
                return None
            if response.status == 304 and method == 'POST' and ('/start' in path or '/stop?' in path):
                return {}
            if not 200 <= response.status < 300:
                raise RuntimeError('Docker operation rejected')
            data = response.read(1024 * 1024 + 1)
            if len(data) > 1024 * 1024:
                raise RuntimeError('Docker response too large')
            return data if raw else json.loads(data) if data else {}
        finally:
            connection.close()


class Runtime:
    def __init__(self, machine_id, root=ROOT):
        self.root = Path(root)
        self.staging_dir = self.root / 'proxy'
        self.staging_dir.mkdir(mode=0o700, exist_ok=True)
        self.config_path = self.staging_dir / 'config.json'
        self.data_dir = str(self.staging_dir / 'runtime')
        Path(self.data_dir).mkdir(mode=0o700, exist_ok=True)
        self.shutdown = threading.Event()
        self.wake = threading.Event()
        self.docker = Docker()
        self.name = 'nokiy-sing-box-' + machine_id
        self.labels = {'io.nokiy.managed-proxy.id': machine_id, 'io.nokiy.managed-proxy.role': 'proxy'}
        self.volume = os.environ['PROXY_DATA_VOLUME']
        if not re.fullmatch('[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', self.volume):
            raise ValueError('invalid volume')
        volume = self.docker.request('GET', '/volumes/' + self.volume)
        if volume.get('Labels', {}).get('io.nokiy.managed-proxy.id') != machine_id:
            raise RuntimeError('volume ownership mismatch')
        self.image = os.environ.get('SING_BOX_IMAGE', 'ghcr.io/sagernet/sing-box@sha256:eeafd5e62919a0ae72284de9e7d7f5f7e64400f90b8d6e9449a5f0c42fd4bf46')
        if not re.fullmatch('ghcr.io/sagernet/sing-box@sha256:[a-f0-9]{64}', self.image):
            raise ValueError('pinned official image required')
        # Recover validation-container leftovers after an abrupt agent death.
        from urllib.parse import quote
        filters = quote(json.dumps({'label': [
            'io.nokiy.managed-proxy.id=' + machine_id,
            'io.nokiy.managed-proxy.role=check']}), safe='')
        for container in self.docker.request('GET', '/containers/json?all=true&filters=' + filters):
            identifier = container.get('Id', '')
            if not re.fullmatch('[a-f0-9]{64}', identifier):
                raise RuntimeError('invalid container identifier')
            expected = {**self.labels, 'io.nokiy.managed-proxy.role': 'check'}
            if any(container.get('Labels', {}).get(k) != v for k, v in expected.items()):
                raise RuntimeError('checker ownership mismatch')
            self.docker.request('DELETE', '/containers/' + identifier + '?force=true&v=false')
        if self.docker.request('GET', '/images/' + self.image + '/json', allow_missing=True) is None:
            from urllib.parse import quote
            result = self.docker.request('POST', '/images/create?fromImage=' + quote(self.image, safe=''), raw=True)
            if b'"errorDetail"' in result:
                raise RuntimeError('image pull failed')

    def inspect(self):
        value = self.docker.request('GET', '/containers/' + self.name + '/json', allow_missing=True)
        if value is not None and any(value['Config'].get('Labels', {}).get(k) != v for k, v in self.labels.items()):
            raise RuntimeError('container ownership mismatch')
        return value

    def host_config(self, check=False):
        return {
            'NetworkMode': 'none' if check else 'host',
            'ReadonlyRootfs': True, 'CapDrop': ['ALL'],
            'CapAdd': [] if check else ['NET_BIND_SERVICE'],
            'SecurityOpt': ['no-new-privileges:true'],
            'Mounts': [{'Type': 'volume', 'Source': self.volume,
                        'Target': '/var/lib/sing-box', 'ReadOnly': check,
                        'VolumeOptions': {'Subpath': 'proxy'}}],
            'Tmpfs': {'/tmp': 'rw,nosuid,nodev,noexec,size=16m'},
            'RestartPolicy': {'Name': 'no' if check else 'unless-stopped'},
            # Diagnostics can contain private material, so do not persist them.
            'LogConfig': {'Type': 'none', 'Config': {}}}

    def check(self, candidate):
        relative = candidate.relative_to(self.staging_dir).as_posix()
        labels = {**self.labels, 'io.nokiy.managed-proxy.role': 'check'}
        value = self.docker.request('POST', '/containers/create', {
            'Image': self.image, 'Cmd': ['check', '-D', '/tmp', '-c', '/var/lib/sing-box/' + relative],
            'Labels': labels, 'HostConfig': self.host_config(check=True)})
        identifier = value['Id']
        try:
            self.docker.request('POST', '/containers/' + identifier + '/start')
            return self.docker.request('POST', '/containers/' + identifier + '/wait?condition=not-running')['StatusCode'] == 0
        finally:
            self.docker.request('DELETE', '/containers/' + identifier + '?force=true&v=false')

    def service(self, operation):
        value = self.inspect()
        if value is not None and (value['State']['Running'] or value['State'].get('Restarting', False)):
            self.docker.request('POST', '/containers/' + self.name + '/stop?t=10')
        if operation == 'stop':
            return
        if value is not None and value['Config']['Image'] != self.image:
            self.docker.request('DELETE', '/containers/' + self.name + '?force=false&v=false')
            value = None
        if value is None:
            self.docker.request('POST', '/containers/create?name=' + self.name, {
                'Image': self.image, 'Cmd': ['run', '-D', '/var/lib/sing-box/runtime', '-c', '/var/lib/sing-box/config.json'],
                'Labels': self.labels, 'HostConfig': self.host_config()})
        self.docker.request('POST', '/containers/' + self.name + '/start')

    def healthy(self):
        initial = self.inspect()
        if initial is None or not initial['State']['Running']:
            return False
        started = initial['State'].get('StartedAt')
        restarts = initial.get('RestartCount', 0)
        for _ in range(5):
            time.sleep(1)
            value = self.inspect()
            if value is None or not value['State']['Running']:
                return False
            if value['State'].get('StartedAt') != started or value.get('RestartCount', 0) != restarts:
                return False
        return True

    def restore(self):
        path = self.root / 'applied.json'
        if not path.exists():
            return
        previous = json.loads(path.read_text())
        if not previous.get('enabled', True):
            self.service('stop')
            return
        value = self.inspect()
        committed = self.config_path.exists() and self.config_path.read_bytes() == previous['document'].encode('utf8')
        if value is not None and value['State']['Running'] and committed:
            return
        sync.atomic(self.config_path, previous['document'].encode('utf8'))
        self.service('restart')
        if not self.healthy():
            raise RuntimeError('cached configuration failed to start')

    def health_marker(self):
        previous = self.root / 'applied.json'
        enabled = not previous.exists() or json.loads(previous.read_text()).get('enabled', True)
        value = self.inspect()
        running = value is not None and value['State']['Running']
        sync.atomic(self.root / 'health.json', sync.encode({
            'time': time.time(), 'supervisor': os.getpid(), 'container': self.name,
            'healthy': running or not enabled}))


def settings(root=ROOT):
    value = json.loads((root / 'settings.json').read_text())
    sync.validate_url(value['url'])
    if not re.fullmatch('[a-z0-9][a-z0-9-]{0,62}', value['id']) or not re.fullmatch('sba_[A-Za-z0-9_-]{43}', value['token']):
        raise ValueError('invalid settings')
    return value


def enroll(args):
    url = sync.validate_url(args.url)
    if not re.fullmatch('[a-z0-9][a-z0-9-]{0,62}', args.id):
        raise ValueError('invalid machine ID')
    value = {'url': url, 'id': args.id}
    code = getpass.getpass('One-time enrollment code: ')
    if not re.fullmatch('[A-Za-z0-9_-]{43}', code):
        raise ValueError('invalid enrollment code')
    _, _, response = sync.request(value, 'enroll', {'code': code})
    token = response.get('token', '')
    if not re.fullmatch('sba_[A-Za-z0-9_-]{43}', token):
        raise ValueError('invalid enrollment response')
    sync.atomic(ROOT / 'settings.json', sync.encode({**value, 'token': token}))
    print('Enrolled. Start the agent with docker compose up -d.')


def run():
    value = settings()
    runtime = Runtime(value['id'])
    def shutdown(*_):
        runtime.shutdown.set()
        runtime.wake.set()
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGHUP, lambda *_: runtime.wake.set())
    last_result = None
    try:
        while not runtime.shutdown.is_set():
            result = 'Control-service poll completed.'
            try:
                # Recover a missing/stopped proxy before contacting the API.
                # This also restores service during control-plane outages.
                runtime.restore()
                sync.sync(value, ROOT, runtime)
            except Exception:
                result = 'Synchronization failed; retaining the last committed configuration.'
            if runtime.shutdown.is_set():
                break
            runtime.health_marker()
            if result != last_result:
                print(result, flush=True)
                last_result = result
            runtime.wake.wait(30 + random.uniform(0, 5))
            runtime.wake.clear()
    finally:
        (ROOT / 'health.json').unlink(missing_ok=True)


def health():
    value = json.loads((ROOT / 'health.json').read_text())
    if not value['healthy'] or time.time() - value['time'] > 100:
        return 1
    os.kill(value['supervisor'], 0)
    # The Docker proxy is intentionally independent of the agent lifecycle.
    return 0


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['run', 'enroll', 'health'], nargs='?', default='run')
    parser.add_argument('--url', default=os.environ.get('CONTROL_URL', 'https://api.nokiy.net/sing-box'))
    parser.add_argument('--id', default=os.environ.get('MACHINE_ID', ''))
    args = parser.parse_args()
    try:
        if args.action == 'health':
            return health()
        ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(ROOT, 0o700)
        with (ROOT / 'lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if args.action == 'enroll':
                enroll(args)
            else:
                run()
    except Exception:
        print('Operation failed. Check enrollment and control-service availability.', flush=True)
        return 1
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
