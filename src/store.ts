import { macosClientProfile, type MacosSettings } from './macos.ts'
import { createHash } from 'node:crypto'
import postgres from 'postgres'
import { newCredentials, type Credentials, type MachineSpec, type Platform, type Role } from './generate.ts'

import { defaultPolicy, parsePolicy, managedServer, managedClient, type Policy } from './policy.ts'

export { type Platform, type Role }
export function validSlug(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(value)
}
export function etag(data: Uint8Array): string {
  return `"${createHash('sha256').update(data).digest('hex')}"`
}

export class PostgresStore {
  private readonly sql: ReturnType<typeof postgres>
  private readonly macos?: MacosSettings
  constructor(url?: string, macos?: MacosSettings) {
    this.macos = macos
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
      await sql`ALTER TABLE machines ADD COLUMN IF NOT EXISTS policy jsonb NOT NULL DEFAULT '{}',
        ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS agent_token_hash text,
        ADD COLUMN IF NOT EXISTS last_seen timestamptz,
        ADD COLUMN IF NOT EXISTS reported_version integer,
        ADD COLUMN IF NOT EXISTS reported_status text,
        ADD COLUMN IF NOT EXISTS reported_running_version integer,
        ADD COLUMN IF NOT EXISTS reported_at timestamptz`
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS machines_agent_token ON machines(agent_token_hash) WHERE agent_token_hash IS NOT NULL`
      await sql`CREATE TABLE IF NOT EXISTS machine_versions (
        machine_id text NOT NULL REFERENCES machines(id), version integer NOT NULL,
        spec jsonb NOT NULL, policy jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(machine_id,version))`
      await sql`CREATE TABLE IF NOT EXISTS machine_drafts (
        machine_id text PRIMARY KEY REFERENCES machines(id), base_version integer NOT NULL,
        spec jsonb NOT NULL, policy jsonb NOT NULL)`
      await sql`CREATE TABLE IF NOT EXISTS machine_users (
        machine_id text NOT NULL REFERENCES machines(id), name text NOT NULL,
        credentials jsonb NOT NULL, PRIMARY KEY(machine_id,name))`
      await sql`CREATE TABLE IF NOT EXISTS machine_enrollments (
        machine_id text PRIMARY KEY REFERENCES machines(id), code_hash text NOT NULL UNIQUE,
        expires_at timestamptz NOT NULL)`
      // Retain legacy path metadata while allowing registrations without file paths.
      await sql`ALTER TABLE machines ALTER COLUMN certificate_path DROP NOT NULL,
        ALTER COLUMN key_path DROP NOT NULL,
        ADD COLUMN IF NOT EXISTS acme_email text NOT NULL DEFAULT ''`
      await sql`INSERT INTO machine_versions(machine_id,version,spec,policy) SELECT id,version, jsonb_build_object('server',server,'tlsServerName',tls_server_name,'realityServerName',reality_server_name,'acmeEmail',acme_email),policy FROM machines ON CONFLICT DO NOTHING`
      await sql`CREATE TABLE IF NOT EXISTS client_machines (
        id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
        platform text NOT NULL CHECK (platform = 'macos'),
        created_at timestamptz NOT NULL DEFAULT now()
      )`
    })
  }

  async ready(): Promise<void> { await this.sql`SELECT 1` }
  async close(): Promise<void> { await this.sql.end({ timeout: 5 }) }

  async saveClient(id: string): Promise<boolean> {
    if (!validSlug(id)) throw new Error('invalid id')
    if (!this.macos?.headscaleUrl) return false
    await this.sql`INSERT INTO client_machines (id,platform) VALUES (${id},'macos') ON CONFLICT (id) DO NOTHING`
    return true
  }

  async getClientConfig(id: string): Promise<Buffer | null> {
    if (!this.macos?.headscaleUrl) return null
    const [row] = await this.sql`SELECT id FROM client_machines WHERE id=${id}`
    if (!row) return null
    return Buffer.from(`${JSON.stringify(macosClientProfile(row.id, this.macos), null, 2)}\n`)
  }

  async saveMachine(id: string, spec: MachineSpec): Promise<void> {
    if (!validSlug(id)) throw new Error('invalid id')
    const c = newCredentials()
    // One atomic upsert: concurrent registration never replaces established credentials.
    await this.sql.begin(async sql => {
      await sql`
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
        acme_email = EXCLUDED.acme_email, version = machines.version + 1,
        updated_at = now()
      WHERE (machines.server,machines.tls_server_name,machines.reality_server_name,machines.acme_email)
        IS DISTINCT FROM (EXCLUDED.server,EXCLUDED.tls_server_name,EXCLUDED.reality_server_name,EXCLUDED.acme_email)`
      const [row] = await sql`SELECT id,version,policy,server,tls_server_name,reality_server_name,acme_email FROM machines WHERE id=${id} FOR UPDATE`
      await sql`INSERT INTO machine_versions(machine_id,version,spec,policy) VALUES (${id},${row.version},${sql.json(this.spec(row))},${row.policy}) ON CONFLICT DO NOTHING`
    })
  }

  private spec(row: any): MachineSpec {
    return { server: row.server, tlsServerName: row.tls_server_name, realityServerName: row.reality_server_name,
      ...(row.acme_email ? { acmeEmail: row.acme_email } : {}) }
  }
  private credentials(row: any): Credentials {
    return { anytlsPassword: row.anytls_password, vlessUUID: row.vless_uuid, tuicUUID: row.tuic_uuid,
      tuicPassword: row.tuic_password, hysteria2Password: row.hysteria2_password,
      realityPrivateKey: row.reality_private_key, realityPublicKey: row.reality_public_key, realityShortID: row.reality_short_id }
  }
  async getConfig(role: Role, id: string, platform: Platform, user = 'default'): Promise<Buffer | null> {
    // Repeatable-read keeps credentials, active policy and user list in one published snapshot.
    return this.sql.begin('isolation level repeatable read read only', async sql => {
      const [row] = await sql`SELECT id,server,tls_server_name,reality_server_name,acme_email,anytls_password,vless_uuid,tuic_uuid,tuic_password,hysteria2_password,reality_private_key,reality_public_key,reality_short_id,policy,version FROM machines WHERE id = ${id}`
      if (!row) return null
      const policy = parsePolicy(row.policy)
      if (!policy.users.includes(user)) return null
      const users = new Map<string, Credentials>([['default', this.credentials(row)]])
      for (const extra of await sql`SELECT name,credentials FROM machine_users WHERE machine_id=${id}`) users.set(extra.name,extra.credentials)
      const config = role === 'server' ? managedServer(id,this.spec(row),users,policy) : managedClient(id,this.spec(row),users.get(user)!,platform,policy,this.macos)
      return Buffer.from(JSON.stringify(config,null,2) + '\n')
    })
  }
  async listMachines(): Promise<any[]> {
    return this.sql`SELECT id,server,version,policy->'enabled' AS enabled,last_seen,reported_version,reported_running_version,reported_status,reported_at FROM machines ORDER BY id`
  }
  async machine(id: string): Promise<any | null> {
    const [row] = await this.sql`SELECT id,server,tls_server_name,reality_server_name,acme_email,policy,version,last_seen,reported_version,reported_running_version,reported_status,reported_at,agent_token_hash IS NOT NULL AS enrolled FROM machines WHERE id=${id}`
    if (!row) return null
    const [draft] = await this.sql`SELECT base_version,spec,policy FROM machine_drafts WHERE machine_id=${id}`
    const versions = await this.sql`SELECT version,created_at FROM machine_versions WHERE machine_id=${id} ORDER BY version DESC LIMIT 100`
    return { id, spec: this.spec(row), policy: parsePolicy(row.policy), version: row.version, enrolled: row.enrolled,
      lastSeen: row.last_seen, reportedVersion: row.reported_running_version, attemptedVersion: row.reported_version, reportedStatus: row.reported_status, reportedAt: row.reported_at, draft: draft ?? null, versions }
  }
  async stage(id: string, spec: MachineSpec, policy: Policy, baseVersion: number): Promise<number> {
    return this.sql.begin(async sql => {
      const [row] = await sql`SELECT version FROM machines WHERE id=${id} FOR UPDATE`
      if (!row) return 404
      if (row.version !== baseVersion) return 409
      await sql`INSERT INTO machine_drafts(machine_id,base_version,spec,policy) VALUES (${id},${baseVersion},${sql.json(spec)},${sql.json(JSON.parse(JSON.stringify(policy)))}) ON CONFLICT(machine_id) DO UPDATE SET base_version=EXCLUDED.base_version,spec=EXCLUDED.spec,policy=EXCLUDED.policy`
      return 200
    })
  }
  async publish(id: string, baseVersion: number, rollbackVersion?: number): Promise<number> {
    return this.sql.begin(async sql => {
      const [row] = await sql`SELECT version FROM machines WHERE id=${id} FOR UPDATE`
      if (!row) return 404
      if (row.version !== baseVersion) return 409
      const [draft] = rollbackVersion === undefined
        ? await sql`SELECT * FROM machine_drafts WHERE machine_id=${id} AND base_version=${baseVersion}`
        : await sql`SELECT * FROM machine_versions WHERE machine_id=${id} AND version=${rollbackVersion}`
      if (!draft) return 404
      const policy = parsePolicy(draft.policy)
      for (const name of policy.users.filter(u => u !== 'default')) {
        await sql`INSERT INTO machine_users(machine_id,name,credentials) VALUES (${id},${name},${sql.json(newCredentials())}) ON CONFLICT DO NOTHING`
      }
      const spec = draft.spec as MachineSpec
      await sql`UPDATE machines SET server=${spec.server},tls_server_name=${spec.tlsServerName},reality_server_name=${spec.realityServerName},acme_email=${spec.acmeEmail ?? ''},policy=${sql.json(JSON.parse(JSON.stringify(policy)))},version=version+1,updated_at=now() WHERE id=${id}`
      await sql`INSERT INTO machine_versions(machine_id,version,spec,policy) VALUES (${id},${baseVersion+1},${sql.json(spec)},${sql.json(JSON.parse(JSON.stringify(policy)))})`
      await sql`DELETE FROM machine_drafts WHERE machine_id=${id}`
      return 200
    })
  }
  async version(id: string, version: number): Promise<any | null> {
    const [row] = await this.sql`SELECT version,spec,policy,created_at FROM machine_versions WHERE machine_id=${id} AND version=${version}`
    return row ? { ...row, policy: parsePolicy(row.policy) } : null
  }
  async enrollment(id: string, hash: string): Promise<boolean> {
    return this.sql.begin(async sql => {
      const [row] = await sql`SELECT id FROM machines WHERE id=${id} FOR UPDATE`
      if (!row) return false
      await sql`INSERT INTO machine_enrollments(machine_id,code_hash,expires_at) VALUES (${id},${hash},now()+interval '10 minutes') ON CONFLICT(machine_id) DO UPDATE SET code_hash=EXCLUDED.code_hash,expires_at=EXCLUDED.expires_at`
      return true
    })
  }
  async enroll(id: string, codeHash: string, tokenHash: string): Promise<boolean> {
    return this.sql.begin(async sql => {
      await sql`SELECT id FROM machines WHERE id=${id} FOR UPDATE`
      const used = await sql`DELETE FROM machine_enrollments WHERE machine_id=${id} AND code_hash=${codeHash} AND expires_at>now() RETURNING machine_id`
      if (used.length === 0) return false
      await sql`UPDATE machines SET agent_token_hash=${tokenHash},last_seen=now() WHERE id=${id}`
      return true
    })
  }
  async revoke(id: string): Promise<boolean> {
    return this.sql.begin(async sql => {
      const rows = await sql`UPDATE machines SET agent_token_hash=NULL WHERE id=${id} RETURNING id`
      await sql`DELETE FROM machine_enrollments WHERE machine_id=${id}`
      return rows.length > 0
    })
  }
  async authorizeAgent(id: string, hash: string): Promise<boolean> {
    const rows = await this.sql`UPDATE machines SET last_seen=now() WHERE id=${id} AND agent_token_hash=${hash} RETURNING id`
    return rows.length > 0
  }
  async desired(id: string): Promise<any | null> {
    // Lock the machine while reading its version and generated config to prevent mismatched labels.
    return this.sql.begin(async sql => {
      const [row] = await sql`SELECT id,server,tls_server_name,reality_server_name,acme_email,anytls_password,vless_uuid,tuic_uuid,tuic_password,hysteria2_password,reality_private_key,reality_public_key,reality_short_id,policy,version FROM machines WHERE id=${id} FOR SHARE`
      if (!row) return null
      const policy = parsePolicy(row.policy)
      const users = new Map<string, Credentials>([['default',this.credentials(row)]])
      for (const extra of await sql`SELECT name,credentials FROM machine_users WHERE machine_id=${id}`) users.set(extra.name,extra.credentials)
      const data = Buffer.from(JSON.stringify(managedServer(id,this.spec(row),users,policy),null,2)+'\n')
      return { version: row.version, enabled: parsePolicy(row.policy).enabled, config: JSON.parse(data!.toString()), hash: etag(data!).slice(1,-1) }
    })
  }
  async report(id: string, version: number, runningVersion: number, status: string): Promise<boolean> {
    const rows = await this.sql`UPDATE machines SET reported_version=${version},reported_running_version=${runningVersion},reported_status=${status},reported_at=now() WHERE id=${id} AND EXISTS(SELECT 1 FROM machine_versions WHERE machine_id=${id} AND version=${version}) AND (${runningVersion}=0 OR EXISTS(SELECT 1 FROM machine_versions WHERE machine_id=${id} AND version=${runningVersion})) RETURNING id`
    return rows.length > 0
  }
}
