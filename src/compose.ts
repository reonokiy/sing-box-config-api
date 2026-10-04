export function proxyCompose(id: string): string {
  // This public template contains no machine data or credential material.
  const image = process.env.PROXY_AGENT_IMAGE ?? 'ghcr.io/reonokiy/sing-box-config-api:agent-latest'
  if (!/^ghcr\.io\/reonokiy\/sing-box-config-api(?::agent-[A-Za-z0-9_.-]+|@sha256:[a-f0-9]{64})$/.test(image)) throw new Error('invalid managed proxy image')
  return `name: sing-box-${id}
services:
  agent:
    image: ${image}
    restart: unless-stopped
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    environment:
      CONTROL_URL: https://api.nokiy.net/sing-box
      MACHINE_ID: ${id}
      PROXY_DATA_VOLUME: sing-box-${id}-data
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - proxy-data:/var/lib/managed-sing-box
    tmpfs:
      - /tmp:rw,nosuid,nodev,noexec,size=16m
    stop_grace_period: 120s
    logging:
      driver: json-file
      options:
        max-size: 1m
        max-file: '2'
volumes:
  proxy-data:
    name: sing-box-${id}-data
    labels:
      io.nokiy.managed-proxy.id: ${id}
`
}
