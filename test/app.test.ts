import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createApp } from '../src/app.ts'

const publisher = 'publisher-synthetic-token-for-tests'
let directory: string
let app: ReturnType<typeof createApp>

const spec = {
  server: 'edge.example.com',
  tlsServerName: 'edge.example.com',
  realityServerName: 'www.example.org',
  certificatePath: '/etc/sing-box/fullchain.pem',
  keyPath: '/etc/sing-box/privkey.pem',
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'sing-box-config-test-'))
  app = createApp({ dataDir: directory, publisherKey: publisher })
})
after(async () => { await rm(directory, { recursive: true, force: true }) })

async function register(id: string, body = spec) {
  return app.request(`/v1/machines/${id}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${publisher}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('generates matching server/client credentials for each machine', async () => {
  const first = await register('laptop')
  assert.equal(first.status, 200)
  const { downloadToken: firstToken } = await first.json() as { downloadToken: string }
  const second = await register('desktop')
  assert.equal(second.status, 200)
  const { downloadToken: secondToken } = await second.json() as { downloadToken: string }
  assert.notEqual(firstToken, secondToken)

  const get = (role: string, id: string, platform: string, token: string) => app.request(
    `/v1/config/${role}/${id}/${platform}`, { headers: { Authorization: `Bearer ${token}` } },
  )
  assert.equal((await get('server', 'laptop', 'linux', secondToken)).status, 401)
  assert.equal((await get('server', 'laptop', 'linux', publisher)).status, 401)

  const serverResponse = await get('server', 'laptop', 'linux', firstToken)
  const clientResponse = await get('client', 'laptop', 'macos', firstToken)
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
  assert.equal((await repeated.json() as any).downloadToken, firstToken)
  const sameServer = await get('server', 'laptop', 'linux', firstToken)
  assert.equal(await sameServer.text(), JSON.stringify(server, null, 2) + '\n')
  const changed = await register('laptop', { ...spec, server: 'new-edge.example.com' })
  assert.equal(changed.status, 200)
  const updated = await (await get('client', 'laptop', 'linux', firstToken)).json() as any
  assert.equal(updated.outbounds.find((outbound: any) => outbound.tag === 'AnyTLS').server, 'new-edge.example.com')
  assert.equal(updated.outbounds.find((outbound: any) => outbound.tag === 'AnyTLS').password, byTag('AnyTLS').password)
  const desktopClient = await (await get('client', 'desktop', 'linux', secondToken)).json() as any
  assert.notEqual(byTag('AnyTLS').password, desktopClient.outbounds.find((outbound: any) => outbound.tag === 'AnyTLS').password)
})

test('rejects invalid machine specs and IDs', async () => {
  assert.equal((await app.request('/v1/machines/Bad-ID', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${publisher}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(spec),
  })).status, 404)
  assert.equal((await register('bad', { ...spec, certificatePath: '../secret' })).status, 400)
  assert.equal((await register('oversize', { ...spec, server: 'x'.repeat(17_000) })).status, 413)
})
