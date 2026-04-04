/**
 * Helpers for o2o egress (`send` capability).
 */

export function parsePayload(
  args: Record<string, unknown>,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const p = args.payload
  if (p !== undefined && typeof p === 'object' && p !== null && !Array.isArray(p)) {
    return { ok: true, value: p as Record<string, unknown> }
  }
  if (typeof p === 'string') {
    try {
      const v = JSON.parse(p) as unknown
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
        return { ok: true, value: v as Record<string, unknown> }
      }
      return { ok: false, error: 'payload JSON must decode to an object' }
    } catch {
      return { ok: false, error: 'payload must be valid JSON when provided as a string' }
    }
  }
  return { ok: false, error: 'payload is required (object or JSON string)' }
}

export function buildRequestBody(
  payload: Record<string, unknown>,
  taskId: string | undefined,
): Record<string, unknown> {
  if (taskId === undefined) return { ...payload }
  return { ...payload, taskId }
}

export function resolvePeerUrl(peerUrl: string, pathSuffix: string | undefined): string {
  if (!pathSuffix?.trim()) return peerUrl
  const u = new URL(peerUrl)
  const left = u.pathname.endsWith('/') ? u.pathname.slice(0, -1) : u.pathname
  const right = pathSuffix.trim().replace(/^\/+/, '')
  u.pathname = `${left}/${right}`
  return u.href
}
