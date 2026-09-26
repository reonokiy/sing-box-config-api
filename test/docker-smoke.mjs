// Synthetic credentials only. No real endpoint login or proxy access is attempted.
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
const docker = (...args) => execFileSync('docker', args, { stdio: 'pipe' })
const compose = (...args) => docker('compose', '-p', 'registry-test', '-f', 'compose.test.yaml', ...args)
const base = 'http://127.0.0.1:13087'
async function ready(url) {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new Error('readiness timeout')
}
const runtimeName = 'registry-tailnet-smoke-' + Date.now()
const fixtures = await mkdtemp(join(tmpdir(), 'registry-docker-smoke-'))
try {
  await ready(base + '/readyz')
  const requestUrl = base + '/v1/machines/docker-test'
  const register = await fetch(requestUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ server: '192.0.2.10', tlsServerName: 'edge.example.com', realityServerName: 'www.example.org' }) })
  assert.equal(register.status, 200)
  const links = await register.json()
  const configs = {}
  for (const [name, link] of Object.entries({ server: links.server, linux: links.client.linux, macos: links.client.macos })) {
    const response = await fetch(new URL(link, requestUrl)); assert.equal(response.status, 200)
    configs[name] = await response.json()
    const etag = response.headers.get('etag'); assert.ok(etag)
    assert.equal((await fetch(new URL(link, requestUrl), { headers: { 'If-None-Match': etag } })).status, 304)
    await writeFile(join(fixtures, name + '.json'), JSON.stringify(configs[name]))
    docker('run', '--rm', '--network', 'none', '-v', fixtures + ':/fixtures:ro', 'ghcr.io/sagernet/sing-box:v1.14.0-beta.1', 'check', '-D', '/tmp', '-c', '/fixtures/' + name + '.json')
    console.log(name + ': sing-box check PASS')
  }
  assert.equal(configs.server.inbounds[0].users[0].password, configs.macos.outbounds.find(o => o.type === 'anytls').password)
  assert.equal(configs.macos.endpoints.length, 2)
  compose('restart', 'api'); await ready(base + '/readyz')
  assert.deepEqual(await (await fetch(new URL(links.client.macos, requestUrl))).json(), configs.macos)
  console.log('API registration, ETag, paired credentials and restart persistence PASS')
  // Docker cannot exercise the macOS Network Extension/TUN. Run the same selectors,
  // DNS and routing engine with a mixed inbound and offline synthetic rule sets.
  const runtime = structuredClone(configs.macos)
  runtime.inbounds = [{ type: 'mixed', tag: 'test-in', listen: '0.0.0.0', listen_port: 1080 }]
  runtime.endpoints.forEach(e => { e.control_url = 'http://control.invalid:9' })
  runtime.dns.servers = runtime.dns.servers.map(s => s.tag === 'bootstrap' ? { type: 'hosts', tag: 'bootstrap', predefined: { 'control.invalid': ['127.0.0.1'] } } : s)
  runtime.route.rule_set = runtime.route.rule_set.flatMap(r => r.type !== 'remote' ? [r] :
    (Array.isArray(r.tag) ? r.tag : [r.tag]).map(tag => ({ type: 'inline', tag, rules: [{ domain_suffix: 'fixture.invalid' }] })))
  runtime.experimental.clash_api = { external_controller: '0.0.0.0:9090' }
  await writeFile(join(fixtures, 'runtime.json'), JSON.stringify(runtime))
  docker('run', '-d', '--name', runtimeName, '--network', 'registry-test_default', '-p', '127.0.0.1::9090', '-v', fixtures + ':/fixtures:ro', 'ghcr.io/sagernet/sing-box:v1.14.0-beta.1', 'run', '-D', '/tmp', '-c', '/fixtures/runtime.json')
  const binding = docker('port', runtimeName, '9090').toString().trim()
  const selectorUrl = 'http://' + binding + '/proxies/Tailnet'
  await ready(selectorUrl)
  for (const name of ['Tailscale', 'Headscale']) {
    const changed = await fetch(selectorUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })
    assert.equal(changed.status, 204)
    assert.equal((await (await fetch(selectorUrl)).json()).now, name)
  }
  console.log('Two-endpoint runtime and live Tailnet selector switching PASS (offline; no network logins)')
} catch (error) {
  // Avoid dumping generated configuration or subprocess buffers containing credentials.
  console.error('Docker smoke test failed: ' + (error instanceof assert.AssertionError ? error.message : error.message.split('\n')[0]))
  try {
    const result = spawnSync('docker', ['logs', runtimeName], { encoding: 'utf8' })
    const logs = result.stdout + result.stderr
    console.error(docker('inspect', runtimeName, '--format', '{{.State.Status}} exit={{.State.ExitCode}} error={{.State.Error}}').toString())
    console.error(logs.split('\n').map(line => line.replace(/[A-Za-z0-9_\/-]{30,}/g, '[redacted]')).slice(0,18).join('\n'))
  } catch {}
  process.exitCode = 1
} finally {
  try { docker('rm', '-f', runtimeName) } catch {}
  await rm(fixtures, { recursive: true, force: true })
}
