import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import postgres from 'postgres'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { createApp } from '../src/app.ts'
import { PostgresStore } from '../src/store.ts'
import { githubIssuer, publishAudience, type Publisher } from '../src/profiles.ts'

const repository = 'reonokiy/sing-box-deploy'
const ownerID = '65524316'
const revision = 'a'.repeat(40)
const keys = await generateKeyPair('RS256')
const jwk = await exportJWK(keys.publicKey)
let store: PostgresStore, control: ReturnType<typeof postgres>, database: string, url: string
let app: ReturnType<typeof createApp>
const publisher: Publisher = { repository, ownerID, keys: createLocalJWKSet({ keys: [{ ...jwk, kid: 'test', alg: 'RS256' }] }) }
const bundle = { linux: JSON.stringify({ inbounds: [], outbounds: [], route: {} }), macos: JSON.stringify({ inbounds: [], outbounds: [], route: {}, log: { level: 'warn' } }, null, 2) + '\n' }

before(async () => {
  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required')
  control = postgres(process.env.TEST_DATABASE_URL)
  database = 'profiles_test_' + randomUUID().replaceAll('-', '')
  await control.unsafe('CREATE DATABASE ' + database)
  const parsed = new URL(process.env.TEST_DATABASE_URL); parsed.pathname = '/' + database; url = parsed.toString()
  store = new PostgresStore(url); await store.initialize()
  app = createApp({ store, publisher })
})
after(async () => { if (store) await store.close(); if (control) { await control.unsafe('DROP DATABASE IF EXISTS ' + database); await control.end() } })

async function token(overrides: Record<string, unknown> = {}, otherKey = false) {
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    iss: githubIssuer, aud: publishAudience, iat: now, nbf: now - 1, exp: now + 300,
    repository, repository_owner_id: ownerID, repository_id: '123', ref: 'refs/heads/main',
    workflow_ref: `${repository}/.github/workflows/deploy.yml@refs/heads/main`,
    event_name: 'push', sha: revision, run_number: '1', run_attempt: '1', ...overrides,
  }
  return new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid: 'test' }).sign(otherKey ? (await generateKeyPair('RS256')).privateKey : keys.privateKey)
}
async function upload(jwt: string, body: unknown = bundle) {
  return app.request('/v1/profiles/sing-box-deploy', { method: 'PUT', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

test('publishing requires an exact, signed GitHub Actions identity', async () => {
  assert.equal((await app.request('/v1/profiles/sing-box-deploy', { method: 'PUT' })).status, 401)
  assert.equal((await upload('invalid')).status, 403)
  assert.equal((await upload(await token({}, true))).status, 403)
  for (const override of [
    { repository: 'attacker/repo' }, { repository_owner_id: '1' }, { ref: 'refs/heads/other' },
    { workflow_ref: `${repository}/.github/workflows/other.yml@refs/heads/main` },
    { event_name: 'pull_request' }, { aud: 'other' }, { iss: 'https://attacker.example' },
    { exp: 1 }, { exp: undefined }, { nbf: Math.floor(Date.now() / 1000) + 600 },
    { run_number: '0' }, { sha: 'not-a-revision' },
  ]) assert.equal((await upload(await token(override))).status, 403)
  const idBound = createApp({ store, publisher: { ...publisher, repositoryID: '456' } })
  assert.equal((await idBound.request('/v1/profiles/sing-box-deploy', { method: 'PUT', headers: { Authorization: `Bearer ${await token()}` }, body: JSON.stringify(bundle) })).status, 403)
  const disabled = createApp({ store })
  assert.equal((await disabled.request('/v1/profiles/sing-box-deploy', { method: 'PUT' })).status, 503)
})

test('stores exact JSON, replaces both profiles atomically, prevents stale writes and persists', async () => {
  const jwt = await token()
  assert.equal((await upload(jwt)).status, 200)
  for (const platform of ['linux', 'macos'] as const) {
    const result = await app.request(`/v1/profiles/sing-box-deploy/${platform}`)
    assert.equal(result.status, 200)
    assert.equal(result.headers.get('Cache-Control'), 'no-store')
    assert.equal(await result.text(), bundle[platform])
    const cached = await app.request(`/v1/profiles/sing-box-deploy/${platform}`, { headers: { 'If-None-Match': result.headers.get('ETag')! } })
    assert.equal(cached.status, 304)
    assert.equal(await cached.text(), '')
  }
  assert.equal((await upload(jwt)).status, 200)
  const changed = { ...bundle, linux: bundle.macos }
  assert.equal((await upload(jwt, changed)).status, 409)
  assert.equal((await upload(await token({ run_number: '2', sha: 'b'.repeat(40) }), changed)).status, 200)
  assert.equal((await upload(jwt)).status, 409)
  assert.equal((await upload(await token({ run_number: '2', run_attempt: '2', sha: 'b'.repeat(40) }), bundle)).status, 200)
  await store.close(); store = new PostgresStore(url); await store.initialize()
  app = createApp({ store, publisher })
  const saved = await app.request('/v1/profiles/sing-box-deploy/linux')
  assert.equal(await saved.text(), bundle.linux)
  assert.equal((await app.request('/v1/profiles/other/linux')).status, 404)
})

test('rejects missing, oversized or invalid profiles without changing published data', async () => {
  const jwt = await token({ run_number: '3' })
  const before = await (await app.request('/v1/profiles/sing-box-deploy/linux')).text()
  for (const body of [null, {}, { linux: bundle.linux }, { ...bundle, extra: '' }, { ...bundle, linux: '{}' }, { ...bundle, macos: 'broken' }, { ...bundle, linux: [] }]) {
    assert.equal((await upload(jwt, body)).status, 400)
  }
  assert.equal((await upload(jwt, { ...bundle, linux: 'x'.repeat(2 * 1024 * 1024) })).status, 413)
  assert.equal(await (await app.request('/v1/profiles/sing-box-deploy/linux')).text(), before)
})
