import { serve } from '@hono/node-server'
import { createApp } from './app.ts'
import { PostgresStore } from './store.ts'

const host = process.env.HOST ?? '127.0.0.1'
const port = Number(process.env.PORT ?? '3000')
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid PORT')
const store = new PostgresStore(process.env.DATABASE_URL)
try { await store.initialize() } catch {
  console.error('Database initialization failed')
  await store.close()
  process.exit(1)
}
const server = serve({ fetch: createApp({ store }).fetch, hostname: host, port })
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  server.close(() => { void store.close() })
})
