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
  certificatePath: '/etc/sing-box/fullchain.pem',
  keyPath: '/etc/sing-box/privkey.pem',
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

async function register(id: string, body = spec) {
  return admin.request(`/sing-box/v1/machines/${id}`, {
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
    `/sing-box/v1/config/${role}/${id}/${platform}`,
  )

  const serverResponse = await get('server', 'laptop', 'linux')
  const clientResponse = await get('client', 'laptop', 'macos')
  assert.equal(serverResponse.status, 200)
  assert.equal(clientResponse.status, 200)
  assert.equal(clientResponse.headers.get('Cache-Control'), 'no-store')
  const server = await serverResponse.json() as any
  const client = await clientResponse.json() as any
  const byTag = (tag: string) => client.outbounds.find((outbound: any) => outbound.tag === tag)
  assert.equal(server.inbounds[0].users[0].password, byTag('AnyTLS').password)
  assert.equal(server.inbounds[1].users[0].uuid, byTag('VLESS-Reality').uuid)
  assert.equal(server.inbounds[2].users[0].uuid, byTag('TUIC').uuid)
  assert.equal(server.inbounds[2].users[0].password, byTag('TUIC').password)
  assert.equal(server.inbounds[3].users[0].password, byTag('Hysteria2').password)
  assert.equal(client.endpoints, undefined)

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
  assert.equal((await admin.request('/sing-box/v1/machines/Bad-ID', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(spec),
  })).status, 404)
  assert.equal((await register('bad', { ...spec, certificatePath: '../secret' })).status, 400)
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
