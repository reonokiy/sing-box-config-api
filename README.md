# sing-box config API

This private repository holds a small TypeScript API for generating and serving
one independent sing-box server/client pair per machine. A machine joins
Headscale with the ordinary Tailscale client before fetching its files;
sing-box is not used to join the Tailnet.

The generated pair follows the four protocols used by `reonokiy/sing-box`:
AnyTLS, VLESS Reality, TUIC, and Hysteria2. Every machine gets fresh passwords,
UUIDs, and a Reality key pair. Re-registering the same ID keeps its credentials
and updates its address or certificate paths. Existing HK/US proxy servers are
not modified. The client config contains a TUN, a `Proxy` selector, and direct
routes for private/Tailnet addresses. Linux uses the `system` stack,
`auto_redirect`, and `strict_route`; macOS uses `mixed`. It does not embed a
second Tailscale endpoint.

The API creates **configuration files only**. It does not install sing-box,
configure public DNS/firewall rules, or obtain a TLS certificate. The server
needs a valid certificate for `tlsServerName` at the configured certificate/key
paths. The machine must accept TCP/443 for AnyTLS, TCP/8443 for VLESS Reality,
UDP/443 for TUIC, and UDP/8443 for Hysteria2. These dedicated ports avoid the
Traefik SNI routing used by the existing multi-service edge nodes.

## API

| Method | Path | Authorization | Result |
| --- | --- | --- | --- |
| `GET` | `/healthz` | None | Readiness |
| `PUT` | `/v1/machines/{id}` | Publisher bearer key | Generate or update one machine; returns its download token |
| `GET` | `/v1/config/{server\|client}/{id}/{linux\|macos}` | That machine's download token | Matching JSON config |

The machine ID uses lowercase letters, digits, and hyphens, up to 63
characters. A request to register `edge-a` looks like:

```json
{
  "server": "edge-a.example.com",
  "tlsServerName": "edge-a.example.com",
  "realityServerName": "www.example.org",
  "certificatePath": "/etc/sing-box/fullchain.pem",
  "keyPath": "/etc/sing-box/privkey.pem"
}
```

`server` is the address in client outbounds. `tlsServerName` must match the
server certificate. `realityServerName` is the Reality handshake target and
client SNI. Certificate/key paths must be absolute paths on the server.

`PUT` returns a `downloadToken` derived from the publisher key and machine ID.
No token database or create/revoke API is needed. Give that token only to the
corresponding machine. The same token can download its server and client
variants. A token from one ID cannot download another ID's configs. The API
never logs tokens or configurations, returns `Cache-Control: no-store`, and
supports ETag/`If-None-Match` for update checks.

Keep the publisher key and download token out of URLs, shell history, and
process arguments. For curl, put the `Authorization: Bearer ...` header in a
mode-0600 curl config file and pass its path with `--config`. Do not commit the
resulting JSON: server configs contain the Reality private key, and client
configs contain proxy passwords and UUIDs.

## Run

Node.js 24 is required. Provision `PUBLISH_KEY` as a random 32-byte-or-longer
URL-safe value from a secret store. `DATA_DIR` must be a private writable
directory on a persistent encrypted volume. The HTTP server defaults to
`127.0.0.1:3000`; a cluster deployment sets `HOST=0.0.0.0` and terminates
HTTPS at the dedicated Tailnet Gateway listener.

```sh
npm ci
npm run check
npm start
```

The application is designed for one replica. Machine credentials and specs are
stored in mode-0600 records and replaced atomically. Retain encrypted backups
of the volume; losing a record changes a machine's credentials and requires a
new server/client pair.
