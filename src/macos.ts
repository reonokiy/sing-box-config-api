import { isIP } from 'node:net'

export type MacosSettings = {
  headscaleUrl?: string
  headscaleDomains: string[]
  headscalePublicDomains: string[]
}

export function macosSettings(env: NodeJS.ProcessEnv): MacosSettings {
  const headscaleUrl = env.HEADSCALE_URL
  if (headscaleUrl) {
    const url = new URL(headscaleUrl)
    if (isIP(url.hostname.replace(/^\[|\]$/g, '')) || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('HEADSCALE_URL must be an HTTPS control server URL with a hostname')
    }
  }
  const domains = (value: string | undefined) => (value ?? '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean)
  const headscaleDomains = domains(env.HEADSCALE_DOMAINS ?? (headscaleUrl ? 'tailnet' : ''))
  const headscalePublicDomains = domains(env.HEADSCALE_PUBLIC_DOMAINS)
  for (const domain of [...headscaleDomains, ...headscalePublicDomains]) {
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain) || domain.includes('..') ||
        domain === 'ts.net' || domain.endsWith('.ts.net')) throw new Error('invalid Headscale domain suffix')
  }
  if (!headscaleUrl && (headscaleDomains.length || headscalePublicDomains.length)) throw new Error('HEADSCALE_URL is required')
  return { headscaleUrl, headscaleDomains, headscalePublicDomains }
}

const directDomains = ['126.com', '163.com', 'alicdn.com', 'aliyun.com', 'baidu.com', 'bdstatic.com',
  'bilibili.com', 'biliapi.com', 'douyin.com', 'gtimg.com', 'iqiyi.com', 'jd.com', 'kuaishou.com',
  'mi.com', 'netease.com', 'qq.com', 'taobao.com', 'tencent.com', 'tmall.com', 'weibo.com',
  'weixin.qq.com', 'xiaomi.com', 'youku.com', 'zhihu.com']
const aiDomains = ['ai.com', 'anthropic.com', 'auth0.openai.com', 'chat.com', 'chatgpt.com', 'claude.ai',
  'client-api.arkoselabs.com', 'copilot.microsoft.com', 'gemini.google.com', 'generativelanguage.googleapis.com',
  'oaistatic.com', 'oaiusercontent.com', 'openai.com', 'openaiapi-site.azureedge.net', 'perplexity.ai', 'poe.com', 'sora.com']
const directSets = ['geosite-apple', 'geosite-cn', 'direct-extra']
type JsonObject = Record<string, unknown>

export function macosProfile(base: JsonObject & { outbounds: JsonObject[] }, settings: MacosSettings): object {
  const endpoints: JsonObject[] = [{
    type: 'tailscale', tag: 'Tailscale', state_directory: 'tailscale-official',
    domain_resolver: 'bootstrap', accept_routes: true,
  }]
  const dnsServers: JsonObject[] = [
    { type: 'local', tag: 'local' },
    { type: 'udp', tag: 'bootstrap', server: '223.5.5.5' },
    { type: 'tailscale', tag: 'dns-tailscale', endpoint: 'Tailscale', accept_search_domain: false },
    { type: 'fakeip', tag: 'tailnet-fakeip', inet4_range: '198.18.0.0/15', inet6_range: 'fc00::/18' },
    { type: 'https', tag: 'cn-doh', domain_resolver: 'bootstrap', server: 'doh.pub', server_port: 443,
      tls: { enabled: true, server_name: 'doh.pub' }, path: '/dns-query' },
    { type: 'https', tag: 'proxy-doh', detour: 'Proxy', server: '1.1.1.1', server_port: 443,
      tls: { enabled: true, server_name: 'cloudflare-dns.com' }, path: '/dns-query' },
  ]
  const networks = [{ domains: ['ts.net'], dns: 'dns-tailscale', endpoint: 'Tailscale' }]
  if (settings.headscaleUrl) {
    endpoints.push({ type: 'tailscale', tag: 'Headscale', control_url: settings.headscaleUrl,
      state_directory: 'tailscale-headscale', domain_resolver: 'bootstrap', accept_routes: true })
    dnsServers.push({ type: 'tailscale', tag: 'dns-headscale', endpoint: 'Headscale', accept_search_domain: false })
    if (settings.headscaleDomains.length) networks.push({ domains: settings.headscaleDomains, dns: 'dns-headscale', endpoint: 'Headscale' })
    // Public DNS records may point at Headscale addresses without being MagicDNS records.
    if (settings.headscalePublicDomains.length) networks.push({ domains: settings.headscalePublicDomains, dns: 'bootstrap', endpoint: 'Headscale' })
  }
  const dnsRules: JsonObject[] = [{ domain_suffix: ['localhost', 'local'], action: 'route', server: 'local' }]
  const routeRules: JsonObject[] = [{ action: 'sniff' }, { protocol: 'dns', action: 'hijack-dns' }]
  for (const network of networks) {
    // FakeIP preserves the original domain even when both networks assign the same real IP.
    dnsRules.push({ domain_suffix: network.domains, query_type: ['A', 'AAAA'], action: 'route', server: 'tailnet-fakeip' },
      { domain_suffix: network.domains, action: 'route', server: network.dns })
    routeRules.push({ domain_suffix: network.domains, action: 'resolve', server: network.dns },
      { domain_suffix: network.domains, action: 'route', outbound: network.endpoint })
  }
  dnsRules.push(
    { domain_regex: '^[^.]+$', action: 'predefined', rcode: 'NXDOMAIN' },
    { type: 'logical', mode: 'and', rules: [{ query_type: ['AAAA', 'HTTPS', 'SVCB'] }, { rule_set: directSets }], action: 'predefined', rcode: 'NOERROR' },
    { rule_set: directSets, action: 'route', server: 'cn-doh' },
  )
  routeRules.push(
    { ip_cidr: ['100.64.0.0/10', 'fd7a:115c:a1e0::/48'], action: 'route', outbound: 'Tailnet' },
    // Advertised private subnets also follow the selector, including overlapping subnets.
    { preferred_by: endpoints.map(e => e.tag), action: 'route', outbound: 'Tailnet' },
    { ip_is_private: true, action: 'route', outbound: 'DIRECT' },
    { rule_set: 'geosite-apple', action: 'route', outbound: 'DIRECT' },
    { domain_suffix: aiDomains, action: 'route', outbound: 'AI' },
    { rule_set: ['direct-extra', 'geosite-cn', 'geoip-cn'], action: 'route', outbound: 'DIRECT' },
  )
  return {
    ...base,
    endpoints,
    dns: { servers: dnsServers, rules: dnsRules, final: 'proxy-doh', strategy: 'prefer_ipv4', timeout: '5s', cache_capacity: 4096 },
    http_clients: [{ tag: 'rules', engine: 'go', detour: 'Proxy' }],
    outbounds: [...base.outbounds,
      { type: 'selector', tag: 'AI', outbounds: ['Proxy', 'AnyTLS', 'VLESS-Reality', 'TUIC', 'Hysteria2', 'DIRECT'], default: 'Proxy' },
      { type: 'selector', tag: 'Tailnet', outbounds: endpoints.map(e => e.tag), default: settings.headscaleUrl ? 'Headscale' : 'Tailscale', interrupt_exist_connections: true },
    ],
    route: {
      auto_detect_interface: true, default_domain_resolver: 'bootstrap', default_http_client: 'rules',
      rules: routeRules, final: 'Proxy',
      rule_set: [
        { type: 'remote', tag: ['geosite-apple', 'geosite-cn'], format: 'binary',
          url: 'https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/{tag}.srs', update_interval: '168h' },
        { type: 'remote', tag: 'geoip-cn', format: 'binary',
          url: 'https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-cn.srs', update_interval: '168h' },
        { type: 'inline', tag: 'direct-extra', rules: [{ domain_suffix: directDomains }] },
      ],
    },
    experimental: { ...(base.experimental as JsonObject), cache_file: {
      ...((base.experimental as JsonObject).cache_file as JsonObject), store_fakeip: true,
    } },
  }
}
