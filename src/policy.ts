import { type MachineSpec, type Credentials, serverConfig, clientConfig, type Platform } from './generate.ts'
import { type MacosSettings } from './macos.ts'

export const protocols = ['anytls', 'vless', 'tuic', 'hysteria2'] as const
export type Protocol = typeof protocols[number]
export type Policy = {
  enabled: boolean
  protocols: Protocol[]
  ports: Record<Protocol, number>
  users: string[]
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  dns?: Record<string, unknown>
  route?: Record<string, unknown>
}
export function defaultPolicy(): Policy {
  return { enabled: true, protocols: [...protocols], ports: { anytls: 443, vless: 8443, tuic: 443, hysteria2: 8443 }, users: ['default'], logLevel: 'info' }
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
export function parsePolicy(value: unknown): Policy {
  const fail = () => { throw new TypeError('Invalid policy') }
  if (!object(value) || Object.keys(value).some(k => !['enabled', 'protocols', 'ports', 'users', 'logLevel', 'dns', 'route'].includes(k))) return fail()
  const p = { ...defaultPolicy(), ...value }
  if (typeof p.enabled !== 'boolean' || !Array.isArray(p.protocols) || p.protocols.length === 0 || p.protocols.some(t => !protocols.includes(t as Protocol)) || new Set(p.protocols).size !== p.protocols.length) return fail()
  if (!object(p.ports) || Object.keys(p.ports).length !== 4 || protocols.some(t => !Number.isInteger(p.ports[t]) || (p.ports[t] as number) < 1 || (p.ports[t] as number) > 65535)) return fail()
  if ((p.protocols.includes('anytls') && p.protocols.includes('vless') && p.ports.anytls === p.ports.vless) || (p.protocols.includes('tuic') && p.protocols.includes('hysteria2') && p.ports.tuic === p.ports.hysteria2)) return fail()
  if (!Array.isArray(p.users) || !p.users.includes('default') || p.users.length > 64 || new Set(p.users).size !== p.users.length || p.users.some(u => typeof u !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(u))) return fail()
  if (!['debug', 'info', 'warn', 'error'].includes(p.logLevel as string)) return fail()
  if (p.dns !== undefined && !object(p.dns) || p.route !== undefined && !object(p.route)) return fail()
  // These sections contain routing settings, never executable hooks or private material.
  if (/"(?:password|private_key|auth_key|token|secret)"\s*:/.test(JSON.stringify({ dns: p.dns, route: p.route }))) return fail()
  return p as Policy
}
export function managedServer(id: string, spec: MachineSpec, users: Map<string, Credentials>, policy: Policy): object {
  const config = serverConfig(id, spec, users.get('default')!) as any
  config.log.level = policy.logLevel
  config.inbounds = config.inbounds.filter((i: any) => policy.enabled && policy.protocols.includes(i.type))
  for (const inbound of config.inbounds) {
    inbound.listen_port = policy.ports[inbound.type as Protocol]
    inbound.users = policy.users.map(name => {
      const c = users.get(name)!
      const label = name === 'default' ? id : name
      if (inbound.type === 'anytls') return { name: label, password: c.anytlsPassword }
      if (inbound.type === 'vless') return { name: label, uuid: c.vlessUUID, flow: 'xtls-rprx-vision' }
      if (inbound.type === 'tuic') return { name: label, uuid: c.tuicUUID, password: c.tuicPassword }
      return { name: label, password: c.hysteria2Password }
    })
  }
  if (policy.dns) config.dns = policy.dns
  if (policy.route) config.route = { ...config.route, ...policy.route }
  return config
}
export function managedClient(id: string, spec: MachineSpec, c: Credentials, platform: Platform, policy: Policy, settings?: MacosSettings): object {
  const config = clientConfig(id, spec, c, platform, settings) as any
  config.log.level = policy.logLevel
  config.outbounds = config.outbounds.filter((o: any) => !protocols.includes(o.type) || policy.enabled && policy.protocols.includes(o.type))
  const tags = new Set(config.outbounds.map((o: any) => o.tag).concat((config.endpoints ?? []).map((e: any) => e.tag)))
  for (const outbound of config.outbounds) {
    if (protocols.includes(outbound.type)) outbound.server_port = policy.ports[outbound.type as Protocol]
    if (outbound.outbounds) {
      outbound.outbounds = outbound.outbounds.filter((tag: string) => tags.has(tag))
      if (outbound.default && !tags.has(outbound.default)) outbound.default = outbound.outbounds[0]
    }
  }
  return config
}
