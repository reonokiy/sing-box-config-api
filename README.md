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

## Register a personal macOS client

`PUT /v1/clients/macos` with `Content-Type: application/json` and
`{"platform":"macos"}` registers a personal client independently of proxy servers.
Download its profile from `GET /v1/clients/macos/config` (the returned link is
relative to the registration URL). Repeated registration is idempotent.
`HEADSCALE_URL` must be configured; registration returns 503 otherwise.

The profile uses the existing Headscale control server and domain settings,
macOS TUN with the mixed stack, and direct Internet access. It needs no proxy
server, remote rule downloads, pre-auth key, or transport credentials. Its
hostname is the registered client ID and its state directory is independent
of other clients. Starting it on the Mac and completing the Headscale/Pocket ID
login joins the actual device; saving a client record does not enroll a node
or change the Tailnet ACL. This endpoint is protected by the same deployment
boundary as the rest of the registry.

## Managed proxy servers

Open `https://api.internal.nokiy.net/sing-box/manage/` through the owner-only
Headscale network. No management-key input is needed on this private route.
The public administrative API still requires the sing-box application's Keygate
key and its Pocket ID group. The page manages independent server addresses,
TLS/Reality names, enabled protocols and ports, proxy users, log level, DNS and
routing. Credential material is excluded from machine lists, drafts and history.

1. Add a machine with only its ID (server address is optional). It starts disabled
   with no protocols or proxy listeners. You can enroll the Agent immediately.
2. Install Docker with Compose on the Linux proxy and generate a one-time
   enrollment code. It expires after ten minutes and can be redeemed once.
3. Download the deployment and enroll (these arguments contain no credentials):

   ```sh
   curl -fsS https://api.nokiy.net/sing-box/v1/agent/edge-01/compose.yaml -o compose.yaml
   docker compose run --rm agent enroll
   docker compose up -d
   ```

   Enter the code at the hidden prompt. The Compose service runs an agent daemon
   with Docker socket access, which creates and manages a separate official
   sing-box `v1.14.0-beta.1` container. Docker Engine 26 or later is required for
   volume subpaths. Neither host Python nor a systemd timer is needed.
   The persistent `proxy-data` volume holds the node-only credential, committed
   versions and runtime data with private file permissions. Only its `proxy/`
   subdirectory is mounted in sing-box, keeping the agent credential separate.
   Credentials never enter environment variables, Docker metadata or argv.
   Keep the volume across upgrades; never use `down --volumes` on a real proxy.
   Before replacing enrollment, run `docker compose stop agent`, then repeat
   enrollment and start. Stopping/removing the agent leaves the proxy running.
4. Every 30 seconds plus jitter, the agent verifies the desired document's hash
   and checks it in a temporary, network-isolated official sing-box container.
   It replaces configuration and restarts the independent proxy only after
   validation; startup failures restore the previous committed configuration.
   Reports distinguish attempted and actual versions. An agent restart keeps
   an existing proxy running, and recovers a missing/stopped proxy from its
   cached configuration even when the API is unavailable. Docker handles host
   reboot for both containers through `unless-stopped`. Interrupted replacement
   restores the last committed document before fetching new configuration.
   The agent finishes an in-progress update before shutdown. To request an
   immediate poll, send SIGHUP with `docker compose kill -s HUP agent`. Proxy diagnostics
   are not logged because they can contain credentials; agent logs contain
   only bounded operational messages.
5. Roll back from history to publish a new version containing the earlier
   settings. Revoking node access stops future sync; it does not remotely kill
   the already-running proxy. To stop a reachable proxy, publish `enabled:false`
   and wait for its `stopped` acknowledgement before revoking access.

The proxy uses Linux host networking so published listener-port changes need
no Compose changes; the agent has no inbound ports and uses Docker's normal
bridge network. The proxy drops all capabilities except `NET_BIND_SERVICE`,
has a read-only root filesystem, and receives no Docker socket. The agent has
all capabilities dropped but Docker socket access grants control of the host's
Docker daemon; deploy it on a trusted, dedicated Linux proxy host.
Only containers and volumes with matching ownership labels may be used; a
name collision with an unrelated container aborts the operation.
The host firewall must allow configured proxy ports and TCP/80 for ACME
HTTP-01, and TLS DNS must point to that host. This is a Linux server deployment,
separate from the macOS client.

To stop a proxy before retiring the agent, publish `enabled:false` and wait for
`stopped`; `docker compose down` removes the agent but intentionally retains the
independent proxy. The managed proxy is named `nokiy-sing-box-<machine-id>`. Revocation, rotation,
expiry and enrollment are enforced in the API and stored as hashes. A node
cannot download another node's credentials, edit settings or obtain client
profiles. A fresh enrollment replaces the old node credential immediately.

A user ID `default` retains the server's existing protocol credentials; extra
user IDs get independent credentials preserved across removal/re-add and
rollback. Removing a user publishes server and paired-client changes together;
existing proxy sessions are terminated by the server restart. Client downloads
accept `?user=alice`; clients must refresh/import the updated profile themselves.
Personal Headscale-only macOS profiles remain independent of proxy servers.

Management routes (all relative to `/sing-box/`):

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `v1/machines/{id}/register` | Add an unconfigured machine; optional `{server}` |
| POST | `v1/machines/{id}/users/{user}/rotate` | Rotate that user's proxy credentials and publish; `{baseVersion}` |
| GET | `v1/machines` / `v1/machines/{id}` | Safe list and detail/status |
| PUT | `v1/machines/{id}/draft` | `{baseVersion,spec,policy}` |
| POST | `v1/machines/{id}/publish` | `{baseVersion}` |
| GET | `v1/machines/{id}/versions/{version}` | Historical settings without credentials |
| POST | `v1/machines/{id}/rollback` | `{baseVersion,version}` |
| POST | `v1/machines/{id}/enrollment` | Issue single-use code |
| POST | `v1/machines/{id}/revoke` | Revoke node and outstanding enrollment |

Only the namespace `v1/agent/` bypasses Keygate on the public gateway. Its enroll
endpoint requires a single-use code; config/status require that machine's bearer
credential. The bootstrap source is public and contains no credential. All
other public routes retain fail-closed Keygate application authorization.

Existing `PUT v1/machines/{id}` remains backward compatible: registration/address
changes publish immediately while preserving credentials and managed policy.
Use the draft API/UI for reviewed changes. Published versions are immutable;
rollback appends a new version rather than overwriting history.

The previous native Python/systemd bootstrap remains available for existing nodes; new UI enrollments use Docker. Agent image and API image are built for linux/amd64 and linux/arm64 from the same revision. Compose downloads contain only a validated machine ID and public image/control-service metadata, not machine configuration.


### Configure an enrolled machine later

Choose protocols and TCP/UDP listener ports in the panel, set the server address
and applicable TLS certificate or Reality handshake domain, and select proxy
users. Enable the service, save the draft, then publish. The enrolled Agent
checks and applies the published configuration automatically. Required ports
are shown in the panel; host and cloud firewall rules remain operator-owned.
TLS-based protocols also need TCP 80 for HTTP-01 certificate issuance.

Passwords and UUIDs are generated independently per machine and proxy user.
Client downloads use the matching credentials automatically. A user's rotation
publishes a new version without changing other users, the machine's Reality
identity or its Agent token. Old client profiles stop authenticating once the
Agent applies that version; download fresh profiles afterward. Configuration
rollback retains the latest credentials and never revives a rotated key.
Credential material is excluded from management responses and history.
