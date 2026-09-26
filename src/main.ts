import { serve } from '@hono/node-server'
import { createApp } from './app.ts'

const dataDir = process.env.DATA_DIR
if (!dataDir) throw new Error('DATA_DIR is required')
const host = process.env.HOST ?? '127.0.0.1'
const port = Number(process.env.PORT ?? '3000')
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid PORT')
const server = serve({ fetch: createApp({ dataDir }).fetch, hostname: host, port })
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close())
