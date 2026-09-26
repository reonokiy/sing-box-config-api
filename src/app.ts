import { Hono } from 'hono'
import { authorizedMachine, authorizedPublisher, bearer, machineToken } from './auth.ts'
import { parseSpec } from './generate.ts'
import { etag, getConfig, saveMachine, validSlug, type Platform, type Role } from './store.ts'

export type Settings = {
  dataDir: string
  publisherKey: string
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

export function createApp(settings: Settings): Hono {
  const app = new Hono()
  app.use('*', async (c, next) => {
    await next()
    c.header('Cache-Control', 'no-store')
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Referrer-Policy', 'no-referrer')
  })
  app.get('/healthz', (c) => c.text('ok'))
  app.get('/v1/config/:role/:id/:platform', async (c) => {
    const { role, id, platform } = c.req.param()
    if (!target(role, id, platform)) return c.notFound()
    if (!authorizedMachine(bearer(c.req.header('Authorization')), settings.publisherKey, id)) {
      return c.text('Unauthorized', 401, { 'WWW-Authenticate': 'Bearer' })
    }
    const data = await getConfig(settings.dataDir, role, id, platform as Platform)
    if (data === null) return c.notFound()
    const hash = etag(data)
    c.header('ETag', hash)
    if (c.req.header('If-None-Match') === hash) return c.body(null, 304)
    return c.body(data.toString('utf8'), 200, { 'Content-Type': 'application/json; charset=utf-8' })
  })
  app.put('/v1/machines/:id', async (c) => {
    const id = c.req.param('id')
    if (!validSlug(id)) return c.notFound()
    if (!authorizedPublisher(bearer(c.req.header('Authorization')), settings.publisherKey)) {
      return c.text('Unauthorized', 401, { 'WWW-Authenticate': 'Bearer' })
    }
    if (!(c.req.header('Content-Type') ?? '').toLowerCase().startsWith('application/json')) {
      return c.text('Expected application/json', 415)
    }
    const length = Number(c.req.header('Content-Length'))
    if (length > 16 * 1024) return c.text('Payload too large', 413)
    try {
      const body = await readLimitedBody(c.req.raw.body)
      const spec = parseSpec(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)))
      await saveMachine(settings.dataDir, id, spec)
      return c.json({ id, downloadToken: machineToken(settings.publisherKey, id) })
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
