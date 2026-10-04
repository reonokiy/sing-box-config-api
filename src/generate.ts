import { macosProfile, type MacosSettings } from './macos.ts'
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'

export type Platform = 'linux' | 'macos'
export type Role = 'client' | 'server'

export type MachineSpec = {
  server: string
  tlsServerName: string
  realityServerName: string
  acmeEmail?: string
}

export type Credentials = {
  anytlsPassword: string
  vlessUUID: string
  tuicUUID: string
  tuicPassword: string
  hysteria2Password: string
  realityPrivateKey: string
  realityPublicKey: string
  realityShortID: string
}

const domain = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
const address = /^(?:[a-z0-9.-]{1,253}|[0-9a-f:]+)$/i

export function parseSpec(value: unknown, protocols: readonly string[] = ['anytls', 'vless', 'tuic', 'hysteria2']): MachineSpec {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid machine spec')
  const spec = value as Record<string, unknown>
  const validDomain = (value: unknown, required: boolean) => (!required && (value === undefined || value === '')) || typeof value === 'string' && domain.test(value)
  if (typeof spec.server !== 'string' || !address.test(spec.server) || spec.server.includes('..') ||
      !validDomain(spec.tlsServerName, protocols.some(p => p !== 'vless')) ||
      !validDomain(spec.realityServerName, protocols.includes('vless')) ||
      (spec.acmeEmail !== undefined && (typeof spec.acmeEmail !== 'string' ||
        spec.acmeEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(spec.acmeEmail)))) {
    throw new Error('invalid machine spec')
  }
  return {
    server: spec.server,
    tlsServerName: (spec.tlsServerName ?? '') as string,
    realityServerName: (spec.realityServerName ?? '') as string,
    ...(spec.acmeEmail === undefined ? {} : { acmeEmail: spec.acmeEmail as string }),
  }
}

export function newCredentials(): Credentials {
  const pair = generateKeyPairSync('x25519')
  const privateJwk = pair.privateKey.export({ format: 'jwk' })
  const publicJwk = pair.publicKey.export({ format: 'jwk' })
  return {
    anytlsPassword: randomBytes(32).toString('base64url'),
    vlessUUID: randomUUID(),
    tuicUUID: randomUUID(),
    tuicPassword: randomBytes(32).toString('base64url'),
    hysteria2Password: randomBytes(32).toString('base64url'),
    realityPrivateKey: privateJwk.d!,
    realityPublicKey: publicJwk.x!,
    realityShortID: randomBytes(8).toString('hex'),
  }
}

export function serverConfig(id: string, spec: MachineSpec, secrets: Credentials): object {
  const tls = {
    enabled: true,
    certificate_provider: 'inbound-acme',
  }
  return {
    log: { level: 'info', timestamp: true },
    certificate_providers: [{
      type: 'acme', tag: 'inbound-acme', domain: [spec.tlsServerName],
      provider: 'letsencrypt',
      ...(spec.acmeEmail ? { email: spec.acmeEmail } : {}),
      // TCP 443 belongs to AnyTLS; use HTTP-01 on TCP 80 for issuance.
      disable_tls_alpn_challenge: true,
    }],
    inbounds: [
      {
        type: 'anytls', tag: 'in:anytls', listen: '::', listen_port: 443,
        users: [{ name: id, password: secrets.anytlsPassword }], tls,
      },
      {
        type: 'vless', tag: 'in:vless-reality', listen: '::', listen_port: 8443,
        users: [{ name: id, uuid: secrets.vlessUUID, flow: 'xtls-rprx-vision' }],
        tls: {
          enabled: true, server_name: spec.realityServerName,
          reality: {
            enabled: true,
            handshake: { server: spec.realityServerName, server_port: 443 },
            private_key: secrets.realityPrivateKey,
            short_id: [secrets.realityShortID],
            max_time_difference: '1m',
          },
        },
      },
      {
        type: 'tuic', tag: 'in:tuic', listen: '::', listen_port: 443,
        users: [{ name: id, uuid: secrets.tuicUUID, password: secrets.tuicPassword }],
        congestion_control: 'bbr', auth_timeout: '3s', zero_rtt_handshake: false,
        heartbeat: '10s', tls,
      },
      {
        type: 'hysteria2', tag: 'in:hysteria2', listen: '::', listen_port: 8443,
        users: [{ name: id, password: secrets.hysteria2Password }],
        ignore_client_bandwidth: true, tls,
      },
    ],
    outbounds: [{ type: 'direct', tag: 'DIRECT' }],
    route: { final: 'DIRECT' },
  }
}

export function clientConfig(id: string, spec: MachineSpec, secrets: Credentials, platform: Platform, settings: MacosSettings = { headscaleDomains: [], headscalePublicDomains: [] }): object {
  const linux = platform === 'linux'
  const server = spec.server
  const tls = { enabled: true, server_name: spec.tlsServerName }
  const tun: Record<string, unknown> = {
    type: 'tun', tag: 'tun-in',
    address: ['172.19.0.1/30', 'fdfe:dcba:9876::1/126'],
    auto_route: true, dns_mode: 'hijack', stack: linux ? 'system' : 'mixed',
  }
  if (linux) {
    tun.interface_name = 'sing-box'
    tun.auto_redirect = true
    tun.strict_route = true
  }
  const config = {
    log: { level: 'info', timestamp: true },
    dns: { servers: [{ type: 'local', tag: 'local' }], final: 'local' },
    inbounds: [tun],
    outbounds: [
      { type: 'direct', tag: 'DIRECT' },
      {
        type: 'anytls', tag: 'AnyTLS', server, server_port: 443,
        password: secrets.anytlsPassword,
        tls: { ...tls, alpn: ['h2', 'http/1.1'], utls: { enabled: true, fingerprint: 'chrome' } },
      },
      {
        type: 'vless', tag: 'VLESS-Reality', server, server_port: 8443,
        uuid: secrets.vlessUUID, flow: 'xtls-rprx-vision', packet_encoding: 'xudp',
        tls: {
          enabled: true, server_name: spec.realityServerName,
          utls: { enabled: true, fingerprint: 'chrome' },
          reality: { enabled: true, public_key: secrets.realityPublicKey, short_id: secrets.realityShortID },
        },
      },
      {
        type: 'tuic', tag: 'TUIC', server, server_port: 443,
        uuid: secrets.tuicUUID, password: secrets.tuicPassword,
        congestion_control: 'bbr', udp_relay_mode: 'native', zero_rtt_handshake: false,
        heartbeat: '10s', tls,
      },
      {
        type: 'hysteria2', tag: 'Hysteria2', server, server_port: 8443,
        password: secrets.hysteria2Password, tls,
      },
      {
        type: 'selector', tag: 'Proxy',
        outbounds: ['AnyTLS', 'VLESS-Reality', 'TUIC', 'Hysteria2', 'DIRECT'],
        ...(linux ? { interrupt_exist_connections: true } : {}),
      },
    ],
    route: {
      auto_detect_interface: true,
      rules: [
        { protocol: 'dns', action: 'hijack-dns' },
        { ip_cidr: ['100.64.0.0/10', 'fd7a:115c:a1e0::/48'], action: 'route', outbound: 'DIRECT' },
        { ip_is_private: true, action: 'route', outbound: 'DIRECT' },
      ],
      final: 'Proxy',
    },
    experimental: { cache_file: { enabled: true, cache_id: `${id}-${platform}`, store_dns: true } },
  }
  return linux ? config : macosProfile(config, settings)
}
