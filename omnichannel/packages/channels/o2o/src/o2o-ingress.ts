/**
 * HTTP `POST /o2o/:channelId` — secured ingress for peer omni gateways.
 */

import type { OmnichannelEvent, OmnichannelPluginId } from '@omnibot/core'

/** URL prefix; must not overlap with `/webhooks/`. */
export const O2O_PATH_PREFIX = '/o2o/' as const

export interface O2oIngressHooks {
  insertQueuedEvent(event: OmnichannelEvent, expiresAt: number): void
  deleteQueuedEvent(id: string): void
  getIpcClientCount(): number
  broadcastEvent(event: OmnichannelEvent): void
}

export interface O2oIngressResolve {
  plugin: OmnichannelPluginId
  /** When set, `Authorization: Bearer <ingressSecret>` is required. */
  ingressSecret: string
}

export interface O2oIngressContext {
  ttlMs: number
  resolveChannel(channelId: string): O2oIngressResolve | null
  hooks: O2oIngressHooks
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function bearerFromRequest(req: Request): string | null {
  const h = req.headers.get('authorization')?.trim()
  if (!h) return null
  const m = /^Bearer\s+(.+)$/i.exec(h)
  return m?.[1]?.trim() ?? null
}

/**
 * Handles POST body ingestion for `/o2o/…` paths.
 * Returns `null` if the URL is not under this prefix (delegate to other plugins).
 */
export async function handleO2oPost(
  req: Request,
  ctx: O2oIngressContext,
): Promise<Response | null> {
  const url = new URL(req.url)
  if (!url.pathname.startsWith(O2O_PATH_PREFIX)) {
    return null
  }

  const channelId = decodeURIComponent(url.pathname.slice(O2O_PATH_PREFIX.length))
  if (!channelId || channelId.includes('/')) {
    return jsonResponse({ error: 'invalid channel' }, 400)
  }

  const resolved = ctx.resolveChannel(channelId)
  if (!resolved) {
    return jsonResponse({ error: `unknown channel: ${channelId}` }, 404)
  }

  if (resolved.plugin !== 'channel-o2o') {
    return jsonResponse({ error: 'not an o2o channel' }, 404)
  }

  const token = bearerFromRequest(req)
  if (!token || token !== resolved.ingressSecret) {
    return jsonResponse({ error: 'unauthorized' }, 401)
  }

  let body: unknown
  const ct = req.headers.get('content-type') ?? ''
  if (ct.includes('application/json')) {
    try {
      body = await req.json()
    } catch {
      return jsonResponse({ error: 'invalid JSON body' }, 400)
    }
  } else {
    body = await req.text()
  }

  const event: OmnichannelEvent = {
    id: crypto.randomUUID(),
    channelId,
    plugin: 'channel-o2o',
    receivedAt: new Date().toISOString(),
    payload: body,
  }

  const expiresAt = Date.now() + ctx.ttlMs
  ctx.hooks.insertQueuedEvent(event, expiresAt)

  if (ctx.hooks.getIpcClientCount() > 0) {
    ctx.hooks.broadcastEvent(event)
    ctx.hooks.deleteQueuedEvent(event.id)
  }

  return jsonResponse({ ok: true, eventId: event.id })
}
