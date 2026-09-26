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
  "realityServerName": "www.example.org",
  "certificatePath": "/etc/fullchain.pem",
  "keyPath": "/etc/privkey.pem"
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
(TCP/8443), TUIC (UDP/443), and Hysteria2 (UDP/8443). The server needs a valid
certificate for `tlsServerName` at the specified file paths, and the Reality
handshake target must be reachable. These dedicated ports work without
Traefik. This service only generates configuration; it does not install
sing-box, obtain certificates, or configure DNS and firewalls.

Clients use TUN with a protocol selector. Linux uses the system stack and
`auto_redirect`; macOS uses the mixed stack. Tailnet/private destinations go
directly through the host network. Machines join Headscale using the ordinary
Tailscale client; these configurations have no embedded Tailscale endpoint.
The generated configs pass `sing-box check` on v1.14.0-beta.1.

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
