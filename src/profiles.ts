import { createHash } from 'node:crypto'
import { Hono } from 'hono'
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'

export const profileID = 'sing-box-deploy'
export const publishAudience = 'https://api.nokiy.net/sing-box/v1/profiles'
export const githubIssuer = 'https://token.actions.githubusercontent.com'
const githubKeys = createRemoteJWKSet(new URL(`${githubIssuer}/.well-known/jwks`), { timeoutDuration: 5000 })
const maxBodySize = 2 * 1024 * 1024
export type Profiles = { linux: string; macos: string }
export type Publication = { revision: string; run: number; attempt: number; files: Profiles }
export type ProfileStore = {
  publishProfiles(id: string, publication: Publication): Promise<boolean>
  getPublishedProfile(id: string, platform: keyof Profiles): Promise<Buffer | null>
}
export type Publisher = { repository: string; ownerID: string; repositoryID?: string; keys?: JWTVerifyGetKey }

export function publisherFromEnvironment(env: NodeJS.ProcessEnv): Publisher | undefined {
  const repository = env.PUBLISH_REPOSITORY
  const ownerID = env.PUBLISH_OWNER_ID
  if (!repository || !ownerID) return undefined
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^\d+$/.test(ownerID)) throw new Error('invalid publisher identity')
  const repositoryID = env.PUBLISH_REPOSITORY_ID
  if (repositoryID && !/^\d+$/.test(repositoryID)) throw new Error('invalid publisher repository ID')
  return { repository, ownerID, repositoryID }
}

async function identity(token: string, publisher: Publisher) {
  const { payload } = await jwtVerify(token, publisher.keys ?? githubKeys, {
    issuer: githubIssuer, audience: publishAudience, algorithms: ['RS256'],
    requiredClaims: ['exp', 'iat', 'nbf', 'repository', 'repository_owner_id', 'ref', 'workflow_ref', 'event_name', 'sha', 'run_number', 'run_attempt'],
    maxTokenAge: '10m', clockTolerance: 5,
  })
  if (payload.repository !== publisher.repository || payload.repository_owner_id !== publisher.ownerID ||
      (publisher.repositoryID && payload.repository_id !== publisher.repositoryID) ||
      payload.ref !== 'refs/heads/main' ||
      payload.workflow_ref !== `${publisher.repository}/.github/workflows/deploy.yml@refs/heads/main` ||
      !['push', 'workflow_dispatch'].includes(String(payload.event_name)) ||
      typeof payload.sha !== 'string' || !/^[a-f0-9]{40}$/.test(payload.sha)) throw new Error('untrusted publication identity')
  const run = Number(payload.run_number), attempt = Number(payload.run_attempt)
  if (!Number.isSafeInteger(run) || run < 1 || !Number.isSafeInteger(attempt) || attempt < 1) throw new Error('invalid workflow run')
  return { revision: payload.sha, run, attempt }
}

async function readProfiles(request: Request): Promise<Profiles> {
  if (!request.body) throw new Error('empty body')
  const reader = request.body.getReader()
  let size = 0
  const chunks: Uint8Array[] = []
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBodySize) throw new RangeError('too large')
      chunks.push(value)
    }
  } finally { await reader.cancel() }
  const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).sort().join(',') !== 'linux,macos') throw new Error('expected linux and macos profiles')
  const files = parsed as Profiles
  for (const platform of ['linux', 'macos'] as const) {
    if (typeof files[platform] !== 'string') throw new Error('expected JSON text')
    const config: unknown = JSON.parse(files[platform])
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('expected configuration object')
    const document = config as Record<string, unknown>
    if (!Array.isArray(document.inbounds) || !Array.isArray(document.outbounds) || !document.route || typeof document.route !== 'object' || Array.isArray(document.route)) throw new Error('invalid configuration structure')
  }
  return files
}

export function profileRoutes(store: ProfileStore, publisher?: Publisher) {
  const app = new Hono()
  app.put(`/${profileID}`, async c => {
    if (!publisher) return c.text('Publishing is not configured', 503)
    const token = c.req.header('Authorization')?.match(/^Bearer (\S+)$/i)?.[1]
    if (!token) return c.text('GitHub Actions identity required', 401)
    let claims: Awaited<ReturnType<typeof identity>>
    try { claims = await identity(token, publisher) }
    catch { return c.text('Invalid publication identity', 403) }
    if (!(c.req.header('Content-Type') ?? '').toLowerCase().startsWith('application/json')) return c.text('Expected application/json', 415)
    let files: Profiles
    try { files = await readProfiles(c.req.raw) }
    catch (error) { return c.text(error instanceof RangeError ? 'Payload too large' : 'Invalid profile bundle', error instanceof RangeError ? 413 : 400) }
    if (!await store.publishProfiles(profileID, { ...claims, files })) return c.text('A newer or different publication already exists', 409)
    return c.json({ revision: claims.revision, linux: `${profileID}/linux`, macos: `${profileID}/macos` })
  })
  app.get('/:id/:platform', async c => {
    const { id, platform } = c.req.param()
    if (id !== profileID || (platform !== 'linux' && platform !== 'macos')) return c.notFound()
    const data = await store.getPublishedProfile(id, platform)
    if (data === null) return c.notFound()
    const hash = `"${createHash('sha256').update(data).digest('hex')}"`
    c.header('ETag', hash)
    if (c.req.header('If-None-Match') === hash) return c.body(null, 304)
    // Download authorization remains at the existing Keygate/Tailnet boundary.
    return c.body(data.toString('utf8'), 200, { 'Content-Type': 'application/json; charset=utf-8' })
  })
  return app
}
