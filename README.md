# sing-box registration center

TypeScript + Hono service for generating per-machine sing-box configurations.
Each registered machine gets independent proxy credentials and matching server
and Linux/macOS client configurations. The service uses the existing Tailnet
entrypoint without application authentication.

## Register a machine

`PUT /v1/machines/edge-a` with `Content-Type: application/json`:

```json
{
  "server": "edge-a.example.com",
  "tlsServerName": "edge-a.example.com",
  "realityServerName": "www.example.org"
}
```

The response contains configuration links relative to the registration request URL
(for example, `../config/server/edge-a/linux`). Resolve them against that URL,
not the site root. Updating the same machine
ID preserves its credentials; different IDs receive independent passwords,
UUIDs, and Reality key pairs. Machine records use a dedicated PostgreSQL database. Each field has an
explicit column; atomic upserts preserve credentials during concurrent updates. There is no token management API.

## Download configurations

- Server: `/v1/config/server/edge-a/linux`
- Linux client: `/v1/config/client/edge-a/linux`
- macOS client: `/v1/config/client/edge-a/macos`

The server JSON is portable across Linux and macOS (`server/edge-a/macos`
returns the same configuration). Responses support ETag/If-None-Match and
`Cache-Control: no-store`. Credentials are never written to application logs.

Protocols follow `reonokiy/sing-box`: AnyTLS (TCP/443), VLESS Reality
(TCP/8443), TUIC (UDP/443), and Hysteria2 (UDP/8443). AnyTLS, TUIC and Hysteria2 share a sing-box ACME certificate provider;
VLESS uses Reality. No certificate files or file paths are required at registration.
An optional `acmeEmail` sets the ACME account contact address.

The server automatically obtains and renews a Let's Encrypt certificate for
`tlsServerName` using HTTP-01. Its public A/AAAA records must point to the machine,
and public TCP/80 must reach sing-box and be available for its challenge listener.
TLS-ALPN challenges are disabled because AnyTLS uses TCP/443. Certificate/account
state uses sing-box's default ACME data directory on the server machine; keep that
directory across restarts. The registry itself still needs no persistent volume.
Reality uses the configured handshake target and generated keys, without ACME.
Use a sing-box build with `with_acme` (validated on v1.14.0-beta.1).
The existing reference deployment uses Cloudflare DNS-01; this standalone config
uses HTTP-01 so machines do not need a DNS API token. The API only generates
configuration; it does not install sing-box or configure DNS and firewalls.

Clients use TUN: Linux uses the system stack with `auto_redirect` and a host-managed
Tailscale client. macOS uses the mixed stack and embedded Tailscale endpoints.
The generated configs target sing-box v1.14.0-beta.1 with `with_tailscale`,
`with_gvisor`, `with_quic`, and `with_utls` support.

## macOS networks and routing

macOS has an official `Tailscale` endpoint. Set these registry environment variables
to add a second `Headscale` endpoint (example deployment values only):

```sh
HEADSCALE_URL=https://hs.example.com
HEADSCALE_DOMAINS=tailnet
HEADSCALE_PUBLIC_DOMAINS=internal.example.com
```

`HEADSCALE_DOMAINS` contains comma-separated MagicDNS suffixes or exact record names.
`HEADSCALE_PUBLIC_DOMAINS` contains ordinary public DNS names that resolve to
Headscale IPs. MagicDNS rules take priority over public DNS rules.
The real deployment URL is supplied at runtime and is not embedded in source.

- Login to each endpoint separately in the client's endpoint management UI.
  No auth keys are embedded. State is stored in separate `tailscale-official` and
  `tailscale-headscale` directories relative to the client's data directory.
- The `Tailnet` selector switches raw `100.64.0.0/10`, Tailscale IPv6, and advertised
  subnet traffic. It defaults to Headscale when configured. Both endpoints remain
  online; switching interrupts existing selected-network connections.
- Fully qualified `.ts.net` and configured Headscale names always use their owning
  endpoint, independent of the selector. Internal A/AAAA queries use FakeIP to
  preserve the domain when real addresses overlap; the route then resolves the
  actual address with that network's DNS. The persistent cache stores FakeIP mappings.
- Ambiguous single-label names return NXDOMAIN; use complete names. Unknown
  private subnets use DIRECT unless advertised by an endpoint.
- Apple/China domains and IPs go DIRECT. Their DNS uses domestic DoH and suppresses
  AAAA/HTTPS/SVCB as in the reference macOS profile. Other DNS goes through Proxy.
- `AI` is independently selectable and defaults to Proxy. Configs contain one
  registered machine's protocols, so there are no invented HK/US or WARP profiles.
- Keep the client's data directory across restarts. Initial rule-set downloads need
  the selected proxy server to be reachable. Do not run another competing TUN client.

## Docker verification

The test Compose stack binds only loopback ports and uses disposable synthetic
PostgreSQL credentials/data. From the repository directory:

```sh
docker compose -p registry-test -f compose.test.yaml up -d --build --wait
node test/docker-smoke.mjs
docker compose -p registry-test -f compose.test.yaml down
```

The smoke test registers a synthetic server, downloads all three configs, checks
ETags and restart persistence, and runs `sing-box check`. Runtime testing replaces
the macOS TUN with a mixed inbound, remote rule downloads with synthetic inline
rules, and control URLs with an offline address. It verifies both endpoints and
selector switching without real logins. macOS TUN behavior, real MagicDNS and
peer reachability still require testing on a Mac after both endpoint logins.

## Development and deployment

Node.js 24:

```sh
npm ci
TEST_DATABASE_URL=postgres://postgres@localhost/postgres npm run check
npm start
```

Set standard `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, and
`PGSSLMODE` environment variables, or supply `DATABASE_URL` through a secret
store. The service initializes its table under a transaction advisory lock.
The default listener is `127.0.0.1:3000`; Kubernetes sets `HOST=0.0.0.0`.
The application needs no persistent volume. PostgreSQL supplies durable storage
and backup. `/healthz` checks the process; `/readyz` checks database access.
Images contain code only; no machine records or proxy credentials are committed
or bundled into the image.

## Reverse proxy deployment

The application serves `/`, `/v1/machines/:id`, and `/v1/config/:role/:id/:platform`.
A reverse proxy owns any external path prefix and strips it before forwarding.
No base-path setting or forwarded-prefix header is needed by the application.
For example, the gateway can map `/registry/v1/machines/edge-a` to
`/v1/machines/edge-a`. Canonicalize the mount root to a trailing slash at the
gateway so the discovery document's relative paths resolve correctly.
