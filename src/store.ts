import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { clientConfig, newCredentials, serverConfig, type Credentials, type MachineSpec, type Platform, type Role } from './generate.ts'

export { type Platform, type Role }

type MachineRecord = { spec: MachineSpec; credentials: Credentials }
let registrationQueue = Promise.resolve()

export function validSlug(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(value)
}

function recordPath(root: string, id: string): string {
  if (!validSlug(id)) throw new Error('invalid id')
  return join(root, `${id}.json`)
}

export function etag(data: Uint8Array): string {
  return `"${createHash('sha256').update(data).digest('hex')}"`
}

async function readRecord(root: string, id: string): Promise<MachineRecord | null> {
  try {
    return JSON.parse(await readFile(recordPath(root, id), 'utf8')) as MachineRecord
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function saveMachineUnlocked(root: string, id: string, spec: MachineSpec): Promise<void> {
  const existing = await readRecord(root, id)
  if (existing !== null && JSON.stringify(existing.spec) === JSON.stringify(spec)) return
  const record: MachineRecord = { spec, credentials: existing?.credentials ?? newCredentials() }
  await mkdir(root, { recursive: true, mode: 0o700 })
  const destination = recordPath(root, id)
  const temporary = join(root, `.${id}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 })
    await rename(temporary, destination)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

export async function saveMachine(root: string, id: string, spec: MachineSpec): Promise<void> {
  const current = registrationQueue.then(() => saveMachineUnlocked(root, id, spec))
  registrationQueue = current.catch(() => undefined)
  await current
}

export async function getConfig(root: string, role: Role, id: string, platform: Platform): Promise<Buffer | null> {
  const record = await readRecord(root, id)
  if (record === null) return null
  const config = role === 'server'
    ? serverConfig(id, record.spec, record.credentials)
    : clientConfig(id, record.spec, record.credentials, platform)
  return Buffer.from(`${JSON.stringify(config, null, 2)}\n`)
}
