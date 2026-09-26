import { createHmac, timingSafeEqual } from 'node:crypto'

export function bearer(header: string | undefined): string | null {
  const match = /^Bearer ([A-Za-z0-9._~-]{24,256})$/.exec(header ?? '')
  return match?.[1] ?? null
}

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function authorizedPublisher(token: string | null, secret: string): boolean {
  return token !== null && equal(token, secret)
}

export function machineToken(secret: string, id: string): string {
  return createHmac('sha256', secret).update(`machine:${id}`).digest('base64url')
}

export function authorizedMachine(token: string | null, secret: string, id: string): boolean {
  return token !== null && equal(token, machineToken(secret, id))
}
