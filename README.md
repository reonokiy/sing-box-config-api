# sing-box registration center

TypeScript + Hono service at `https://api.example.com/sing-box/`.
Each registered machine gets independent proxy credentials and matching server
and Linux/macOS client configurations. The service uses the existing Tailnet
entrypoint without application authentication.

## Register a machine

`PUT /sing-box/v1/machines/edge-a` with `Content-Type: application/json`:

```json
{
  "server": "edge-a.example.com",
  "tlsServerName": "edge-a.example.com",
  "realityServerName": "www.example.org",
  "certificatePath": "/etc/sing-box/fullchain.pem",
  "keyPath": "/etc/sing-box/privkey.pem"
}
```

The response contains configuration download paths. Updating the same machine
ID preserves its credentials; different IDs receive independent passwords,
UUIDs, and Reality key pairs. Machine records are persisted atomically and must
be backed up. There is no token management API.

## Download configurations

- Server: `/sing-box/v1/config/server/edge-a/linux`
- Linux client: `/sing-box/v1/config/client/edge-a/linux`
- macOS client: `/sing-box/v1/config/client/edge-a/macos`

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
npm run check
DATA_DIR=./data npm start
```

The default listener is `127.0.0.1:3000`. Kubernetes sets `HOST=0.0.0.0` and
mounts an encrypted persistent volume at `DATA_DIR`. Run one replica. Image
builds contain code only; no machine records or proxy credentials are committed
or bundled into the image.
