import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clientConfig, newCredentials } from '../src/generate.ts'
import { macosSettings } from '../src/macos.ts'

const spec = { server: 'edge.example.com', tlsServerName: 'edge.example.com', realityServerName: 'www.example.org' }
const settings = macosSettings({ HEADSCALE_URL: 'https://hs.example.com', HEADSCALE_DOMAINS: 'tailnet', HEADSCALE_PUBLIC_DOMAINS: 'internal.example.com' })

test('dual tailnets keep DNS and state isolated; raw IPs use the selector', () => {
  const config = clientConfig('test', spec, newCredentials(), 'macos', settings) as any
  assert.deepEqual(config.endpoints.map((e: any) => e.tag), ['Tailscale', 'Headscale'])
  assert.equal(new Set(config.endpoints.map((e: any) => e.state_directory)).size, 2)
  assert.ok(config.endpoints.every((e: any) => !e.auth_key && !e.system_interface))
  const selector = config.outbounds.find((o: any) => o.tag === 'Tailnet')
  assert.deepEqual(selector.outbounds, ['Tailscale', 'Headscale'])
  assert.equal(selector.default, 'Headscale')
  assert.equal(selector.interrupt_exist_connections, true)
  const routes = config.route.rules
  for (const [domain, dns, endpoint] of [['ts.net', 'dns-tailscale', 'Tailscale'], ['tailnet', 'dns-headscale', 'Headscale'], ['internal.example.com', 'bootstrap', 'Headscale']]) {
    assert.ok(config.dns.rules.some((r: any) => r.domain_suffix?.includes(domain) && r.server === 'tailnet-fakeip'))
    const resolve = routes.findIndex((r: any) => r.domain_suffix?.includes(domain) && r.action === 'resolve')
    assert.equal(routes[resolve].server, dns)
    assert.equal(routes[resolve + 1].outbound, endpoint)
    assert.ok(resolve < routes.findIndex((r: any) => r.ip_cidr))
  }
  assert.equal(routes.find((r: any) => r.ip_cidr).outbound, 'Tailnet')
  assert.equal(routes.find((r: any) => r.preferred_by).outbound, 'Tailnet')
  assert.equal(config.dns.rules.find((r: any) => r.domain_regex).rcode, 'NXDOMAIN')
  assert.equal(config.inbounds[0].stack, 'mixed')
  assert.ok(config.outbounds.some((o: any) => o.tag === 'AI'))
  assert.equal(config.experimental.cache_file.store_fakeip, true)
})

test('Linux remains on the host Tailscale client and invalid control URLs fail', () => {
  const config = clientConfig('test', spec, newCredentials(), 'linux', settings) as any
  assert.equal(config.endpoints, undefined)
  assert.equal(config.inbounds[0].stack, 'system')
  assert.throws(() => macosSettings({ HEADSCALE_URL: 'http://hs.example.com' }))
  assert.throws(() => macosSettings({ HEADSCALE_URL: 'https://user:pass@hs.example.com' }))
  assert.throws(() => macosSettings({ HEADSCALE_DOMAINS: 'tailnet' }))
  assert.throws(() => macosSettings({ HEADSCALE_URL: 'https://192.0.2.1' }))
})
