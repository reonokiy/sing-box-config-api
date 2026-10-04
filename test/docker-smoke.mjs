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
  assert.equal((await fetch(base+'/v1/machines/empty-machine/register',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,200)
  for(const role of ['server','client'])for(const platform of role==='server'?['linux']:['linux','macos']){
    const config=await (await fetch(base+'/v1/config/'+role+'/empty-machine/'+platform)).json()
    const file='unconfigured-'+role+'-'+platform+'.json'
    await writeFile(join(fixtures,file),JSON.stringify(config))
    docker('run','--rm','--network','none','-v',fixtures+':/fixtures:ro','ghcr.io/sagernet/sing-box:v1.14.0-beta.1','check','-D','/tmp','-c','/fixtures/'+file)
  }
  console.log('Unconfigured machine with no address, certificate or protocols: official syntax checks PASS')
  const clientRequestUrl = base + '/v1/clients/personal-macos'
  const clientRegistration = await fetch(clientRequestUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"platform":"macos"}' })
  assert.equal(clientRegistration.status, 200)
  const clientLinks = await clientRegistration.json()
  const personalResponse = await fetch(new URL(clientLinks.config, clientRequestUrl))
  assert.equal(personalResponse.status, 200)
  const personal = await personalResponse.json()
  assert.equal(personal.endpoints[0].hostname, 'personal-macos')
  assert.equal(personal.endpoints[0].control_url, 'https://hs.example.com')
  assert.equal(personal.endpoints[0].auth_key, undefined)
  assert.deepEqual(personal.outbounds, [{ type: 'direct', tag: 'DIRECT' }])
  await writeFile(join(fixtures, 'personal-macos.json'), JSON.stringify(personal))
  docker('run', '--rm', '--network', 'none', '-v', fixtures + ':/fixtures:ro', 'ghcr.io/sagernet/sing-box:v1.14.0-beta.1', 'check', '-D', '/tmp', '-c', '/fixtures/personal-macos.json')
  console.log('Personal Headscale macOS client: sing-box check PASS')
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
  assert.deepEqual(await (await fetch(new URL(clientLinks.config, clientRequestUrl))).json(), personal)
  console.log('Independent personal client and restart persistence PASS')
  assert.deepEqual(await (await fetch(new URL(links.client.macos, requestUrl))).json(), configs.macos)
  console.log('API registration, ETag, paired credentials and restart persistence PASS')
  const policy = { enabled: true, protocols: ['anytls','tuic'], ports: { anytls: 9443, vless: 8443, tuic: 9443, hysteria2: 8443 }, users: ['default','alice'], logLevel: 'warn', dns: { servers: [{ type: 'local', tag: 'local' }], final: 'local' }, route: { rules: [{ domain_suffix: ['example.com'], action: 'route', outbound: 'DIRECT' }], final: 'DIRECT' } }
  assert.equal((await fetch(base+'/v1/machines/docker-test/draft',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({baseVersion:1,spec:{server:'192.0.2.10',tlsServerName:'edge.example.com',realityServerName:'www.example.org'},policy})})).status,200)
  assert.equal((await fetch(base+'/v1/machines/docker-test/publish',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"baseVersion":1}'})).status,200)
  for (const [name,path] of Object.entries({ managedServer:'/v1/config/server/docker-test/linux',managedLinux:'/v1/config/client/docker-test/linux?user=alice',managedMacos:'/v1/config/client/docker-test/macos?user=alice' })) {
    const response=await fetch(base+path);assert.equal(response.status,200)
    const generated=await response.json()
    await writeFile(join(fixtures,name+'.json'),JSON.stringify(generated))
    docker('run','--rm','--network','none','-v',fixtures+':/fixtures:ro','ghcr.io/sagernet/sing-box:v1.14.0-beta.1','check','-D','/tmp','-c','/fixtures/'+name+'.json')
  }
  const codeResponse=await fetch(base+'/v1/machines/docker-test/enrollment',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})
  const {code}=await codeResponse.json()
  const joinResponse=await fetch(base+'/v1/agent/docker-test/enroll',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})})
  assert.equal(joinResponse.status,200)
  const {token}=await joinResponse.json()
  const nodeHeaders={Authorization:'Bearer '+token}
  const desiredResponse=await fetch(base+'/v1/agent/docker-test/config',{headers:nodeHeaders});assert.equal(desiredResponse.status,200)
  assert.equal((await desiredResponse.json()).version,2)
  assert.equal((await fetch(base+'/v1/machines',{headers:nodeHeaders})).status,403)
  compose('restart','api');await ready(base+'/readyz')
  assert.equal((await fetch(base+'/v1/agent/docker-test/config',{headers:nodeHeaders})).status,200)
  assert.equal((await (await fetch(base+'/v1/machines/docker-test')).json()).version,2)
  assert.equal((await fetch(base+'/v1/machines/docker-test/rollback',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"baseVersion":2,"version":1}'})).status,200)
  assert.deepEqual(await (await fetch(new URL(links.server,requestUrl))).json(),configs.server)
  for(const protocol of ['anytls','vless','tuic','hysteria2']) {
    const id='syntax-only-'+protocol
    const spec={server:'192.0.2.10',...(protocol==='vless'?{realityServerName:'www.example.org'}:{tlsServerName:'edge.example.com'}),policy:{protocols:[protocol]}}
    assert.equal((await fetch(base+'/v1/machines/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(spec)})).status,200)
    for(const role of ['server','client']) {
      const config=await (await fetch(base+'/v1/config/'+role+'/'+id+'/linux')).json()
      const file=id+'-'+role+'.json'
      await writeFile(join(fixtures,file),JSON.stringify(config))
      docker('run','--rm','--network','none','-v',fixtures+':/fixtures:ro','ghcr.io/sagernet/sing-box:v1.14.0-beta.1','check','-D','/tmp','-c','/fixtures/'+file)
    }
  }
  console.log('Each protocol independently passes official sing-box server/client checks')
  console.log('Managed policy, three real sing-box syntax checks, node scope, restart persistence and rollback PASS')
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
  console.error('Docker smoke test failed; inspect the failing stage without printing configuration.')
  process.exitCode = 1
} finally {
  try { docker('rm', '-f', runtimeName) } catch {}
  await rm(fixtures, { recursive: true, force: true })
}
