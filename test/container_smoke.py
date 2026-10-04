"""Real sing-box in the deployment container, synthetic HTTPS control plane only."""
import hashlib
import http.server
import json
from pathlib import Path
import secrets
import socket
import ssl
import subprocess
import tempfile
import threading
import time


def docker(*args, input=None):
    result = subprocess.run(['docker', *args], input=input, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        raise RuntimeError('Docker operation failed; output suppressed')
    return result.stdout


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def eventually(predicate, timeout=65):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            if predicate():
                return
        except (OSError, ValueError, RuntimeError):
            pass
        time.sleep(0.25)
    print('Recent bounded status reports:', [{k:r.get(k) for k in ['version','status','runningVersion']} for r in reports[-3:]], flush=True)
    raise RuntimeError('Runtime condition timeout; credentials and configuration suppressed')


port1, port2, blocked_port = free_port(), free_port(), free_port()
code = secrets.token_urlsafe(32)
token = 'sba_' + secrets.token_urlsafe(32)
reports = []
state = {'offline': False, 'enrolled': False}


def desired(version, port, enabled=True, invalid=False):
    config = {'log': {'level': 'error'}, 'inbounds': [{'type': 'socks', 'listen': '127.0.0.1', 'listen_port': port}], 'outbounds': [{'type': 'direct'}]}
    if not enabled:
        config['inbounds'] = []
    if invalid:
        config['inbounds'][0]['type'] = 'synthetic-invalid-type'
    document = json.dumps(config, indent=2) + '\n'
    state['desired'] = {'version': version, 'enabled': enabled, 'config': config, 'document': document, 'hash': hashlib.sha256(document.encode()).hexdigest()}


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def respond(self, status, body, headers=None):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(json.dumps(body).encode() if status != 304 else b'')

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if self.path == '/v1/agent/container-test/enroll':
            if body.get('code') != code or state['enrolled']:
                self.respond(401, {})
                return
            state['enrolled'] = True
            self.respond(200, {'token': token})
        elif self.path == '/v1/agent/container-test/status' and self.headers.get('Authorization') == 'Bearer ' + token:
            reports.append(body)
            self.respond(200, {})
        else:
            self.respond(401, {})

    def do_GET(self):
        if state['offline']:
            self.respond(503, {})
        elif self.path != '/v1/agent/container-test/config' or self.headers.get('Authorization') != 'Bearer ' + token:
            self.respond(401, {})
        else:
            value = state['desired']
            headers = {'ETag': '"' + value['hash'] + '"', 'X-Config-Version': str(value['version'])}
            self.respond(304 if self.headers.get('If-None-Match') == headers['ETag'] else 200, value, headers)


def reported(version, status, running):
    return any(r == {'version': version, 'status': status, 'runningVersion': running} for r in reports)


def socks_alive(port):
    with socket.create_connection(('127.0.0.1', port), timeout=1) as sock:
        sock.sendall(b'\x05\x01\x00')
        return sock.recv(2) == b'\x05\x00'


name = 'managed-proxy-smoke-' + str(time.time_ns())
volume = name + '-data'
control = None
try:
    with tempfile.TemporaryDirectory(prefix='managed-proxy-ca-') as directory:
        path = Path(directory)
        # A throwaway local test CA, never persisted or printed by the test.
        result = subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(path/'key.pem'), '-out', str(path/'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if result.returncode:
            raise RuntimeError('Test certificate generation failed')
        control = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(path/'cert.pem', path/'key.pem')
        control.socket = tls.wrap_socket(control.socket, server_side=True)
        threading.Thread(target=control.serve_forever, daemon=True).start()
        env = ['-e', 'SSL_CERT_FILE=/test/cert.pem', '-e', 'CONTROL_URL=https://localhost:' + str(control.server_port), '-e', 'MACHINE_ID=container-test', '-e', 'PROXY_DATA_VOLUME=' + volume]
        mounts = ['-v', str(path/'cert.pem') + ':/test/cert.pem:ro', '-v', volume + ':/var/lib/managed-sing-box', '-v', '/var/run/docker.sock:/var/run/docker.sock']
        options = ['--network', 'host', '--read-only', '--cap-drop', 'ALL', '--cap-add', 'NET_BIND_SERVICE', '--security-opt', 'no-new-privileges:true', '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=16m']
        docker('volume', 'create', '--label', 'io.nokiy.managed-proxy.id=container-test', volume)
        docker('run', '--rm', '-i', *options, *env, *mounts, 'sing-box-agent:test', 'enroll', input=(code + '\n').encode())
        print('Hidden-input enrollment and volume persistence PASS', flush=True)
        desired(1, port1)
        docker('run', '-d', '--name', name, *options, *env, *mounts, 'sing-box-agent:test')
        eventually(lambda: reported(1, 'applied', 1) and socks_alive(port1))
        print('Real sing-box initial configuration and status PASS', flush=True)
        desired(2, port2)
        eventually(lambda: reported(2, 'applied', 2) and socks_alive(port2))
        print('Published listener-port change without Compose change PASS', flush=True)
        desired(3, port1, invalid=True)
        docker('kill', '--signal', 'HUP', name)
        eventually(lambda: reported(3, 'failed_validation', 2) and socks_alive(port2))
        print('Invalid desired configuration retains running version PASS', flush=True)
        # Bind in the Docker host's network namespace, not the CLI host's.
        docker('run', '-d', '--name', name+'-blocker', '--network', 'host',
               '--read-only', '--cap-drop', 'ALL', '--log-driver', 'none',
               '--entrypoint', 'python3', 'sing-box-agent:test', '-m', 'http.server',
               str(blocked_port), '--bind', '127.0.0.1')
        eventually(lambda: docker('exec', name+'-blocker', 'python3', '-c',
            'import socket; socket.create_connection(("127.0.0.1",'+str(blocked_port)+'),1).close()') == b'')
        desired(4, blocked_port)
        docker('kill', '--signal', 'HUP', name)
        try:
            eventually(lambda: reported(4, 'failed_start', 2) and socks_alive(port2))
        except RuntimeError:
            # Only listener-port metadata from the credential-free synthetic fixture.
            print('Synthetic intended port:', blocked_port, flush=True)
            print('Synthetic agent file port:', docker('exec', name, 'python3', '-c', 'import json;print(json.load(open("/var/lib/managed-sing-box/proxy/config.json"))["inbounds"][0]["listen_port"])').decode().strip(), flush=True)
            print('Synthetic Docker state:', docker('inspect','--format','{{.State.Status}} {{.RestartCount}} {{.HostConfig.NetworkMode}}','nokiy-sing-box-container-test').decode().strip(), flush=True)
            raise
        docker('rm', '-f', name+'-blocker')
        print('Real startup failure restores last good configuration PASS', flush=True)
        desired(5, port2, enabled=False)
        docker('kill', '--signal', 'HUP', name)
        eventually(lambda: reported(5, 'stopped', 0))
        docker('exec', name, 'python3', '/app/container.py', 'health')
        desired(6, port2)
        docker('kill', '--signal', 'HUP', name)
        eventually(lambda: reported(6, 'applied', 6) and socks_alive(port2))
        print('Disable, health check and re-enable PASS', flush=True)
        # Metadata-only child PID; no credential/configuration inspection.
        docker('kill', 'nokiy-sing-box-container-test')
        eventually(lambda: socks_alive(port2))
        print('Stopped proxy container recovers automatically PASS', flush=True)
        original_id = docker('inspect', '--format', '{{.Id}}', 'nokiy-sing-box-container-test')
        state['offline'] = True
        docker('stop', '--time', '120', name)
        assert socks_alive(port2), 'Agent stop interrupted the independent proxy'
        assert docker('inspect', '--format', '{{.Id}}', 'nokiy-sing-box-container-test') == original_id
        print('Agent stop preserves independent proxy PASS', flush=True)
        docker('rm', '-f', 'nokiy-sing-box-container-test')
        docker('start', name)
        eventually(lambda: socks_alive(port2))
        eventually(lambda: docker('exec', name, 'python3', '/app/container.py', 'health') == b'')
        print('Agent restart restores cached proxy with control plane offline PASS', flush=True)
        state['offline'] = False
        desired(7, port2)
        docker('kill', '--signal', 'HUP', name)
        eventually(lambda: reported(7, 'applied', 7))
        print('Identical configuration advances reported version via HTTP 304 PASS', flush=True)
        # No token, enrollment code or proxy document may escape through logs.
        logs = docker('logs', name)
        if token.encode() in logs or code.encode() in logs or state['desired']['document'].encode() in logs:
            raise RuntimeError('Credential-safe log assertion failed; output suppressed')
        docker('stop', '--time', '120', name)
        assert socks_alive(port2), 'Agent stop interrupted the independent proxy'
        print('Credential-safe logs and independent lifecycle PASS', flush=True)
except Exception:
    print('Managed proxy smoke failed; raw errors, credentials and configuration suppressed.', flush=True)
    raise SystemExit(1)
finally:
    if control:
        control.shutdown()
        control.server_close()
    subprocess.run(['docker', 'rm', '-f', name+'-blocker'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(['docker', 'rm', '-f', 'nokiy-sing-box-container-test'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(['docker', 'volume', 'rm', volume], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
