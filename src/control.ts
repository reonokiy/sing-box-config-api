import { Hono } from 'hono'
import { proxyCompose } from './compose.ts'
import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { parseSpec } from './generate.ts'
import { parsePolicy, defaultPolicy } from './policy.ts'
import { validSlug, type PostgresStore } from './store.ts'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const statuses = ['applied', 'stopped', 'failed_validation', 'failed_start', 'failed_rollback']
export function controlRoutes(store: PostgresStore): Hono {
  const app = new Hono()
  app.use('*', async (c,next) => {
    // A node credential must never reach administrative or client-download handlers,
    // including when the owner-only internal gateway bypasses Keygate.
    if (!c.req.path.startsWith('/v1/agent/') && /^Bearer sba_/i.test(c.req.header('Authorization') ?? '')) return c.text('Forbidden',403)
    if (!['GET','HEAD'].includes(c.req.method)) {
      const origin = c.req.header('Origin')
      if (origin) {
        try { if (new URL(origin).host !== new URL(c.req.url).host) return c.text('Forbidden',403) }
        catch { return c.text('Forbidden',403) }
      }
    }
    await next()
  })
  for (const [path,file,type] of [['/manage/','index.html','text/html'],['/manage/app.js','app.js','application/javascript'],['/manage/style.css','style.css','text/css']]) {
    app.get(path, async c => {
      c.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
      c.header('Content-Type',type + '; charset=utf-8')
      return c.body(await readFile(new URL('../web/'+file,import.meta.url)))
    })
  }
  app.get('/manage',c => c.redirect('./manage/'))
  app.get('/v1/agent/bootstrap.py',async c => {
    c.header('Content-Type','text/x-python; charset=utf-8')
    return c.body(await readFile(new URL('../agent/sync.py',import.meta.url)))
  })
  app.get('/v1/agent/:id/compose.yaml',c => {
    const id = c.req.param('id')
    if (!validSlug(id)) return c.notFound()
    c.header('Content-Type','application/yaml; charset=utf-8')
    c.header('Content-Disposition','attachment; filename=compose.yaml')
    return c.body(proxyCompose(id))
  })
  app.get('/v1/machines',async c => c.json({ machines: await store.listMachines(), defaultPolicy: defaultPolicy() }))
  app.get('/v1/machines/:id',async c => {
    if (!validSlug(c.req.param('id') ?? '')) return c.notFound()
    const machine = await store.machine(c.req.param('id'))
    return machine ? c.json(machine) : c.notFound()
  })
  app.get('/v1/machines/:id/versions/:version',async c => {
    const value = await store.version(c.req.param('id'),Number(c.req.param('version')))
    return value ? c.json(value) : c.notFound()
  })
  // Exact JSON content type and bounded reads also prevent browser form-based CSRF.
  app.use('/v1/*',async(c,next) => {
    if (!['GET','HEAD'].includes(c.req.method) && /(?:\/(?:draft|publish|rollback|enrollment|revoke)|\/agent\/[^/]+\/(?:enroll|status))$/.test(c.req.path)) {
      if (!(c.req.header('Content-Type') ?? '').toLowerCase().startsWith('application/json')) return c.text('Expected application/json',415)
      const reader = c.req.raw.body?.getReader()
      let size = 0
      const chunks: Uint8Array[] = []
      if (reader) {
        try { while (true) { const {done,value} = await reader.read(); if (done) break; size += value.length; if (size>65536) { await reader.cancel(); return c.text('Payload too large',413) } chunks.push(value) } }
        finally { reader.releaseLock() }
      }
      try { c.set('body' as never,JSON.parse(Buffer.concat(chunks).toString('utf8')) as never) }
      catch { return c.text('Invalid JSON',400) }
    }
    await next()
  })
  const body = (c: any): any => c.get('body')
  const respond = (c: any,status: number) => status === 200 ? c.json({ok:true}) : c.text(status === 409 ? 'Version conflict' : 'Not found',status)
  app.put('/v1/machines/:id/draft',async c => {
    if (!validSlug(c.req.param('id') ?? '')) return c.notFound()
    try {
      const b = body(c)
      if (!b || !Number.isInteger(b.baseVersion) || b.baseVersion < 1) return c.text('Invalid draft',400)
      return respond(c,await store.stage(c.req.param('id'),parseSpec(b.spec),parsePolicy(b.policy),b.baseVersion))
    } catch(e) { if (e instanceof TypeError || (e instanceof Error && e.message === 'invalid machine spec')) return c.text('Invalid draft',400); throw e }
  })
  for (const action of ['publish','rollback']) app.post('/v1/machines/:id/'+action,async c => {
    const b = body(c)
    if (!validSlug(c.req.param('id') ?? '')) return c.notFound()
    if (!b || !Number.isInteger(b.baseVersion) || b.baseVersion < 1 || action === 'rollback' && (!Number.isInteger(b.version) || b.version < 1)) return c.text('Invalid version',400)
    return respond(c,await store.publish(c.req.param('id')!,b.baseVersion,action === 'rollback' ? b.version : undefined))
  })
  app.post('/v1/machines/:id/enrollment',async c => {
    if (!validSlug(c.req.param('id') ?? '')) return c.notFound()
    const code = randomBytes(32).toString('base64url')
    return await store.enrollment(c.req.param('id'),digest(code)) ? c.json({code,expiresIn:600}) : c.notFound()
  })
  app.post('/v1/machines/:id/revoke',async c => {
    if (!validSlug(c.req.param('id') ?? '')) return c.notFound()
    return await store.revoke(c.req.param('id')) ? c.json({ok:true}) : c.notFound()
  })
  app.post('/v1/agent/:id/enroll',async c => {
    const b = body(c)
    if (!validSlug(c.req.param('id') ?? '') || !b || typeof b.code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(b.code)) return c.text('Unauthorized',401)
    const token = 'sba_'+randomBytes(32).toString('base64url')
    return await store.enroll(c.req.param('id'),digest(b.code),digest(token)) ? c.json({token}) : c.text('Unauthorized',401)
  })
  app.use('/v1/agent/:id/*',async(c,next) => {
    const authorization = c.req.header('Authorization') ?? ''
    if (!/^Bearer sba_[A-Za-z0-9_-]{43}$/.test(authorization) || !validSlug(c.req.param('id') ?? '') || c.req.query('api_key') || c.req.query('apikey') || !await store.authorizeAgent(c.req.param('id')!,digest(authorization.slice(7)))) return c.text('Unauthorized',401)
    await next()
  })
  app.get('/v1/agent/:id/config',async c => {
    const result = await store.desired(c.req.param('id'))
    if (!result) return c.notFound()
    c.header('ETag','"'+result.hash+'"')
    c.header('X-Config-Version',String(result.version))
    // Repeated identical configuration may still have a new published version.
    if (c.req.header('If-None-Match') === '"'+result.hash+'"') return c.body(null,304)
    return c.json(result)
  })
  app.post('/v1/agent/:id/status',async c => {
    const b = body(c)
    if (!b || !Number.isInteger(b.version) || !statuses.includes(b.status) || !Number.isInteger(b.runningVersion) || b.runningVersion < 0 || (b.status === 'applied' && b.runningVersion !== b.version) || (b.status === 'stopped' && b.runningVersion !== 0) || Object.keys(b).some(k => !['version','runningVersion','status'].includes(k))) return c.text('Invalid status',400)
    return await store.report(c.req.param('id'),b.version,b.runningVersion,b.status) ? c.json({ok:true}) : c.text('Unknown version',400)
  })
  return app
}
