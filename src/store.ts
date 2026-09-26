import { createHash } from 'node:crypto'
import postgres from 'postgres'
import { clientConfig, newCredentials, serverConfig, type Credentials, type MachineSpec, type Platform, type Role } from './generate.ts'

export { type Platform, type Role }
export function validSlug(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(value)
}
export function etag(data: Uint8Array): string {
  return `"${createHash('sha256').update(data).digest('hex')}"`
}

export class PostgresStore {
  private readonly sql: ReturnType<typeof postgres>
  constructor(url?: string) {
    const options = {
      max: 5, connect_timeout: 5, idle_timeout: 20, onnotice: () => {},
      ...(process.env.PGSSLMODE === 'require' ? { ssl: 'require' as const } : {}),
    }
    this.sql = url ? postgres(url, options) : postgres(options)
  }

  async initialize(): Promise<void> {
    await this.sql.begin(async (sql) => {
      await sql`SELECT pg_advisory_xact_lock(736426, 1)`
      await sql`
        CREATE TABLE IF NOT EXISTS machines (
          id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
          server text NOT NULL,
          tls_server_name text NOT NULL,
          reality_server_name text NOT NULL,
          certificate_path text,
          key_path text,
          acme_email text NOT NULL DEFAULT '',
          anytls_password text NOT NULL,
          vless_uuid uuid NOT NULL UNIQUE,
          tuic_uuid uuid NOT NULL UNIQUE,
          tuic_password text NOT NULL,
          hysteria2_password text NOT NULL,
          reality_private_key text NOT NULL,
          reality_public_key text NOT NULL,
          reality_short_id text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )`
      // Retain legacy path metadata while allowing registrations without file paths.
      await sql`ALTER TABLE machines ALTER COLUMN certificate_path DROP NOT NULL,
        ALTER COLUMN key_path DROP NOT NULL,
        ADD COLUMN IF NOT EXISTS acme_email text NOT NULL DEFAULT ''`
    })
  }

  async ready(): Promise<void> { await this.sql`SELECT 1` }
  async close(): Promise<void> { await this.sql.end({ timeout: 5 }) }

  async saveMachine(id: string, spec: MachineSpec): Promise<void> {
    if (!validSlug(id)) throw new Error('invalid id')
    const c = newCredentials()
    // One atomic upsert: concurrent registration never replaces established credentials.
    await this.sql`
      INSERT INTO machines (
        id, server, tls_server_name, reality_server_name, acme_email,
        anytls_password, vless_uuid, tuic_uuid, tuic_password, hysteria2_password,
        reality_private_key, reality_public_key, reality_short_id
      ) VALUES (
        ${id}, ${spec.server}, ${spec.tlsServerName}, ${spec.realityServerName}, ${spec.acmeEmail ?? ''},
        ${c.anytlsPassword}, ${c.vlessUUID}, ${c.tuicUUID}, ${c.tuicPassword}, ${c.hysteria2Password},
        ${c.realityPrivateKey}, ${c.realityPublicKey}, ${c.realityShortID}
      ) ON CONFLICT (id) DO UPDATE SET
        server = EXCLUDED.server, tls_server_name = EXCLUDED.tls_server_name,
        reality_server_name = EXCLUDED.reality_server_name,
        acme_email = EXCLUDED.acme_email,
        updated_at = now()`
  }

  async getConfig(role: Role, id: string, platform: Platform): Promise<Buffer | null> {
    const [row] = await this.sql`SELECT * FROM machines WHERE id = ${id}`
    if (!row) return null
    const spec: MachineSpec = {
      server: row.server, tlsServerName: row.tls_server_name,
      realityServerName: row.reality_server_name,
      ...(row.acme_email ? { acmeEmail: row.acme_email } : {}),
    }
    const c: Credentials = {
      anytlsPassword: row.anytls_password, vlessUUID: row.vless_uuid,
      tuicUUID: row.tuic_uuid, tuicPassword: row.tuic_password,
      hysteria2Password: row.hysteria2_password, realityPrivateKey: row.reality_private_key,
      realityPublicKey: row.reality_public_key, realityShortID: row.reality_short_id,
    }
    const config = role === 'server' ? serverConfig(id, spec, c) : clientConfig(id, spec, c, platform)
    return Buffer.from(`${JSON.stringify(config, null, 2)}\n`)
  }
}
