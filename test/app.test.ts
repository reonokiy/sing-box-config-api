import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { PostgresStore } from '../src/store.ts'
import { after, before, test } from 'node:test'
import { createApp } from '../src/app.ts'

let store: PostgresStore
let database: string
let control: ReturnType<typeof postgres>
let admin: ReturnType<typeof createApp>
let read: ReturnType<typeof createApp>

const spec = {
  server: 'edge.example.com',
  tlsServerName: 'edge.example.com',
  realityServerName: 'www.example.org',
}

before(async () => {
  const url = process.env.TEST_DATABASE_URL
  if (!url) throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests')
  control = postgres(url)
  database = 'registry_test_' + randomUUID().replaceAll('-', '')
  await control.unsafe('CREATE DATABASE ' + database)
  const testUrl = new URL(url); testUrl.pathname = '/' + database
  store = new PostgresStore(testUrl.toString())
  await store.initialize()
  const settings = { store }
  admin = createApp(settings)
  read = createApp(settings)
})
after(async () => {
  if (store) await store.close()
  if (control) { await control.unsafe('DROP DATABASE IF EXISTS ' + database); await control.end() }
})

async function register(id: string, body: typeof spec & { acmeEmail?: string } = spec) {
  return admin.request(`/v1/machines/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('generates matching server/client credentials for each machine', async () => {
  const first = await register('laptop')
  assert.equal(first.status, 200)
  assert.equal((await first.json() as any).id, 'laptop')
  const second = await register('desktop')
  assert.equal(second.status, 200)

  const get = (role: string, id: string, platform: string) => read.request(
    `/v1/config/${role}/${id}/${platform}`,
  )

  const serverResponse = await get('server', 'laptop', 'linux')
  const clientResponse = await get('client', 'laptop', 'macos')
  assert.equal(serverResponse.status, 200)
  assert.equal(clientResponse.status, 200)
  assert.equal(clientResponse.headers.get('Cache-Control'), 'no-store')
  const server = await serverResponse.json() as any
  assert.deepEqual(server.certificate_providers, [{
    type: 'acme', tag: 'inbound-acme', domain: [spec.tlsServerName],
    provider: 'letsencrypt', disable_tls_alpn_challenge: true,
  }])
  for (const inbound of server.inbounds.filter((i: any) => i.type !== 'vless')) {
    assert.equal(inbound.tls.certificate_provider, 'inbound-acme')
    assert.equal(inbound.tls.certificate_path, undefined)
    assert.equal(inbound.tls.key_path, undefined)
  }
  assert.equal(server.inbounds[1].tls.reality.enabled, true)
  const client = await clientResponse.json() as any
  const byTag = (tag: string) => client.outbounds.find((outbound: any) => outbound.tag === tag)
  assert.equal(server.inbounds[0].users[0].password, byTag('AnyTLS').password)
  assert.equal(server.inbounds[1].users[0].uuid, byTag('VLESS-Reality').uuid)
  assert.equal(server.inbounds[2].users[0].uuid, byTag('TUIC').uuid)
  assert.equal(server.inbounds[2].users[0].password, byTag('TUIC').password)
  assert.equal(server.inbounds[3].users[0].password, byTag('Hysteria2').password)
  assert.equal(client.endpoints[0].tag, 'Tailscale')

  const repeated = await register('laptop')
  assert.equal((await repeated.json() as any).id, 'laptop')
  const sameServer = await get('server', 'laptop', 'linux')
  assert.equal(await sameServer.text(), JSON.stringify(server, null, 2) + '\n')
  const changed = await register('laptop', { ...spec, server: 'new-edge.example.com' })
  assert.equal(changed.status, 200)
  const updated = await (await get('client', 'laptop', 'linux')).json() as any
  assert.equal(updated.outbounds.find((outbound: any) => outbound.tag === 'AnyTLS').server, 'new-edge.example.com')
  assert.equal(updated.outbounds.find((outbound: any) => outbound.tag === 'AnyTLS').password, byTag('AnyTLS').password)
  const desktopClient = await (await get('client', 'desktop', 'linux')).json() as any
  assert.notEqual(byTag('AnyTLS').password, desktopClient.outbounds.find((outbound: any) => outbound.tag === 'AnyTLS').password)
})

test('rejects invalid machine specs and IDs', async () => {
  assert.equal((await admin.request('/v1/machines/Bad-ID', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(spec),
  })).status, 404)
  assert.equal((await register('bad', { ...spec, acmeEmail: 'invalid-email' })).status, 400)
  assert.equal((await register('oversize', { ...spec, server: 'x'.repeat(17_000) })).status, 413)
})

test('concurrent registration preserves credentials and database reconnect keeps records', async () => {
  await register('concurrent')
  const before = await store.getConfig('server', 'concurrent', 'linux')
  await Promise.all(Array.from({ length: 8 }, () => register('concurrent')))
  assert.equal((await store.getConfig('server', 'concurrent', 'linux'))?.toString(), before?.toString())
  const url = new URL(process.env.TEST_DATABASE_URL!); url.pathname = '/' + database
  const reconnected = new PostgresStore(url.toString())
  try { assert.equal((await reconnected.getConfig('server', 'concurrent', 'linux'))?.toString(), before?.toString()) }
  finally { await reconnected.close() }
})


test('configuration links resolve under any gateway mount path', async () => {
  const root = await (await read.request('/')).json() as any
  assert.equal(root.register, 'PUT v1/machines/{id}')
  assert.equal((await read.request('/registry/')).status, 404)
  for (const mount of ['/', '/registry/', '/nested/proxy/']) {
    const requestUrl = new URL('v1/machines/links', 'https://api.example.com' + mount)
    const response = await register('links')
    const links = await response.json() as any
    for (const link of [links.server, links.client.linux, links.client.macos]) {
      const external = new URL(link, requestUrl)
      assert.equal(external.origin, requestUrl.origin)
      assert.ok(external.pathname.startsWith(mount + 'v1/config/'))
      const upstreamPath = '/' + external.pathname.slice(mount.length)
      assert.equal((await read.request(upstreamPath)).status, 200)
    }
  }
})


test('migrates legacy path columns without changing machine credentials', async () => {
  const url = new URL(process.env.TEST_DATABASE_URL!); url.pathname = '/' + database
  const sql = postgres(url.toString())
  try {
    await register('migration')
    const before = await store.getConfig('server', 'migration', 'linux')
    await sql`UPDATE machines SET certificate_path = '/legacy/cert.pem', key_path = '/legacy/key.pem'`
    await sql`ALTER TABLE machines ALTER COLUMN certificate_path SET NOT NULL,
      ALTER COLUMN key_path SET NOT NULL, DROP COLUMN acme_email`
    await store.initialize()
    await store.initialize()
    assert.equal((await register('migration')).status, 200)
    assert.equal((await store.getConfig('server', 'migration', 'linux'))?.toString(), before?.toString())
    assert.equal((await register('after-migration', { ...spec, acmeEmail: 'ops@example.com' })).status, 200)
    const config = JSON.parse((await store.getConfig('server', 'after-migration', 'linux'))!.toString())
    assert.equal(config.certificate_providers[0].email, 'ops@example.com')
  } finally { await sql.end() }
})

test('personal macOS registration creates only a client and persists its Headscale profile', async () => {
  const url = new URL(process.env.TEST_DATABASE_URL!); url.pathname = '/' + database
  const settings = { headscaleUrl: 'https://hs.example.com', headscaleDomains: ['tailnet'], headscalePublicDomains: ['internal.example.com'] }
  const clientStore = new PostgresStore(url.toString(), settings)
  const app = createApp({ store: clientStore })
  const request = (id: string, body: unknown = { platform: 'macos' }) => app.request(`/v1/clients/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  try {
    assert.equal((await app.request('/v1/clients/personal-macos/config')).status, 404)
    const registered = await request('personal-macos')
    assert.equal(registered.status, 200)
    const link = (await registered.json() as any).config
    assert.equal(new URL(link, 'https://api.example.com/sing-box/v1/clients/personal-macos').pathname, '/sing-box/v1/clients/personal-macos/config')
    const response = await app.request('/v1/clients/personal-macos/config')
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
    const profile = await response.json() as any
    assert.equal(profile.endpoints.length, 1)
    assert.equal(profile.endpoints[0].hostname, 'personal-macos')
    assert.equal(profile.endpoints[0].control_url, settings.headscaleUrl)
    assert.equal(profile.endpoints[0].auth_key, undefined)
    assert.deepEqual(profile.outbounds, [{ type: 'direct', tag: 'DIRECT' }])
    assert.equal(profile.inbounds[0].type, 'tun')
    assert.equal(profile.inbounds[0].stack, 'mixed')
    assert.equal(profile.route.final, 'DIRECT')
    for (const [domain, resolver] of [['tailnet', 'dns-headscale'], ['internal.example.com', 'bootstrap']]) {
      assert.ok(profile.dns.rules.some((r: any) => r.domain_suffix?.includes(domain) && r.server === 'tailnet-fakeip'))
      const index = profile.route.rules.findIndex((r: any) => r.domain_suffix?.includes(domain) && r.action === 'resolve')
      assert.equal(profile.route.rules[index].server, resolver)
      assert.equal(profile.route.rules[index + 1].outbound, 'Headscale')
    }
    assert.equal(profile.route.rules.find((r: any) => r.preferred_by).outbound, 'Headscale')
    assert.equal((await app.request('/v1/config/server/personal-macos/linux')).status, 404)
    assert.equal((await app.request('/v1/clients/personal-macos/config', { headers: { 'If-None-Match': response.headers.get('etag')! } })).status, 304)
    await Promise.all(Array.from({ length: 8 }, () => request('personal-macos')))
    const reconnected = new PostgresStore(url.toString(), settings)
    try { assert.deepEqual(JSON.parse((await reconnected.getClientConfig('personal-macos'))!.toString()), profile) }
    finally { await reconnected.close() }
    for (const body of [{ platform: 'linux' }, {}, { platform: 'macos', server: 'unwanted.example.com' }, [], null]) {
      assert.equal((await request('bad-client', body)).status, 400)
    }
    assert.equal((await request('Bad-ID')).status, 404)
    assert.equal((await app.request('/v1/clients/client', { method: 'PUT' })).status, 415)
    assert.equal((await request('large', { platform: 'macos', extra: 'x'.repeat(17000) })).status, 413)
    assert.equal((await app.request('/v1/clients/Bad-ID/config')).status, 404)
    assert.equal((await app.request('/v1/clients/bad-client/config')).status, 404)
    const notConfigured = await admin.request('/v1/clients/no-control', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"platform":"macos"}' })
    assert.equal(notConfigured.status, 503)
    assert.equal(await store.getClientConfig('personal-macos'), null)
  } finally { await clientStore.close() }
})
