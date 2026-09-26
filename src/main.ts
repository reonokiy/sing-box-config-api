import { serve } from '@hono/node-server'
import { createApp } from './app.ts'

const dataDir = process.env.DATA_DIR
const publisherKey = process.env.PUBLISH_KEY
if (!dataDir || !publisherKey || !/^[A-Za-z0-9._~-]{32,256}$/.test(publisherKey)) {
  throw new Error('DATA_DIR and PUBLISH_KEY are required')
}
const host = process.env.HOST ?? '127.0.0.1'
const port = Number(process.env.PORT ?? '3000')
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid PORT')
const app = createApp({ dataDir, publisherKey })
serve({ fetch: app.fetch, hostname: host, port })
