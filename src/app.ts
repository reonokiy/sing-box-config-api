import { controlRoutes } from './control.ts'
import { Hono } from 'hono'
import { parsePolicy } from './policy.ts'
import { parseSpec } from './generate.ts'
import { etag, validSlug, type PostgresStore, type Platform, type Role } from './store.ts'

export type Settings = {
  store: PostgresStore
}

class PayloadTooLarge extends Error {}

async function readLimitedBody(body: ReadableStream<Uint8Array> | null): Promise<Uint8Array> {
  if (body === null) return new Uint8Array()
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 16 * 1024) throw new PayloadTooLarge()
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

function target(role: string, id: string, platform: string): role is Role {
  return (role === 'client' || role === 'server') && validSlug(id) &&
    (platform === 'linux' || platform === 'macos')
}

function baseApp(): Hono {
  const app = new Hono()
  app.use('*', async (c, next) => {
    await next()
    c.header('Cache-Control', 'no-store')
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Referrer-Policy', 'no-referrer')
  })
  app.get('/healthz', (c) => c.text('ok'))
  app.get('/', (c) => c.json({ service: 'sing-box registry', manage: 'GET manage/', register: 'PUT v1/machines/{id}', config: 'GET v1/config/{server|client}/{id}/{linux|macos}', registerClient: 'PUT v1/clients/{id}', clientConfig: 'GET v1/clients/{id}/config' }))
  return app
}

export function createApp(settings: Settings): Hono {
  const app = baseApp()
  app.onError((_error, c) => c.text('Internal Server Error', 500))
  app.route('/',controlRoutes(settings.store))
  app.get('/readyz', async (c) => {
    try { await settings.store.ready(); return c.text('ok') }
    catch { return c.text('Database unavailable', 503) }
  })
  app.put('/v1/clients/:id', async (c) => {
    const id = c.req.param('id')
    if (!validSlug(id)) return c.notFound()
    if (!(c.req.header('Content-Type') ?? '').toLowerCase().startsWith('application/json')) {
      return c.text('Expected application/json', 415)
    }
    if (Number(c.req.header('Content-Length')) > 16 * 1024) return c.text('Payload too large', 413)
    try {
      const body = await readLimitedBody(c.req.raw.body)
      const spec: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
      if (typeof spec !== 'object' || spec === null || Array.isArray(spec) ||
        Object.keys(spec).length !== 1 || (spec as Record<string, unknown>).platform !== 'macos') {
        return c.text('Invalid client spec', 400)
      }
      if (!await settings.store.saveClient(id)) return c.text('Headscale is not configured', 503)
      return c.json({ id, platform: 'macos', config: `./${id}/config` })
    } catch (error) {
      if (error instanceof PayloadTooLarge) return c.text('Payload too large', 413)
      if (error instanceof SyntaxError || error instanceof TypeError) return c.text('Invalid client spec', 400)
      throw error
    }
  })
  app.get('/v1/clients/:id/config', async (c) => {
    const id = c.req.param('id')
    if (!validSlug(id)) return c.notFound()
    const data = await settings.store.getClientConfig(id)
    if (data === null) return c.notFound()
    const hash = etag(data)
    c.header('ETag', hash)
    if (c.req.header('If-None-Match') === hash) return c.body(null, 304)
    return c.body(data.toString('utf8'), 200, { 'Content-Type': 'application/json; charset=utf-8' })
  })
  app.get('/v1/config/:role/:id/:platform', async (c) => {
    const { role, id, platform } = c.req.param()
    if (!target(role, id, platform)) return c.notFound()
    const user = c.req.query('user') ?? 'default'
    if (!validSlug(user)) return c.notFound()
    const data = await settings.store.getConfig(role, id, platform as Platform, user)
    if (data === null) return c.notFound()
    const hash = etag(data)
    c.header('ETag', hash)
    if (c.req.header('If-None-Match') === hash) return c.body(null, 304)
    return c.body(data.toString('utf8'), 200, { 'Content-Type': 'application/json; charset=utf-8' })
  })
  app.put('/v1/machines/:id', async (c) => {
    const id = c.req.param('id')
    if (!validSlug(id)) return c.notFound()
    if (!(c.req.header('Content-Type') ?? '').toLowerCase().startsWith('application/json')) {
      return c.text('Expected application/json', 415)
    }
    const length = Number(c.req.header('Content-Length'))
    if (length > 16 * 1024) return c.text('Payload too large', 413)
    try {
      const body = await readLimitedBody(c.req.raw.body)
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
      const policy = value?.policy === undefined ? undefined : parsePolicy(value.policy)
      if (policy && (policy.users.length !== 1 || policy.users[0] !== 'default')) return c.text('Invalid initial users', 400)
      const spec = parseSpec(value, policy?.protocols)
      if (!await settings.store.saveMachine(id, spec, policy)) return c.text('Machine already exists', 409)
      return c.json({ id, server: `../config/server/${id}/linux`, client: { linux: `../config/client/${id}/linux`, macos: `../config/client/${id}/macos` } })
    } catch (error) {
      if (error instanceof PayloadTooLarge) return c.text('Payload too large', 413)
      if (error instanceof SyntaxError || error instanceof TypeError ||
          (error instanceof Error && error.message === 'invalid machine spec')) {
        return c.text('Invalid machine spec', 400)
      }
      throw error
    }
  })
  return app
}
