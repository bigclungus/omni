/**
 * Omni-to-omni channel: egress (`send` → HTTP POST to peer) and optional secured HTTP ingress (`/o2o/:channelId`).
 */

import type { CapabilityDef } from '@omnibot/core'
import {
  deleteQueuedEvent as dbDeleteQueuedEvent,
  insertQueuedEvent as dbInsertQueuedEvent,
  type GatewayIo,
  type GatewayPluginHost,
  type GatewayPluginHostContext,
  type GatewayPluginHttpContext,
  type InvokeContext,
  type InvokeResult,
} from '@omnibot/gateway'

import { handleO2oPost } from './o2o-ingress.ts'
import { buildRequestBody, parsePayload, resolvePeerUrl } from './o2o-send.ts'

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

export interface EgressConfig {
  peerUrl: string
  headers?: Record<string, string>
  timeoutMs: number
}

const O2O_CAPABILITIES: Record<string, CapabilityDef> = {
  send: {
    description:
      'POST a JSON body to the configured peer gateway (omni-to-omni). Use for delegating work to another omni + MCP session.',
    requiresReplyHandle: false,
    args: {
      payload: {
        type: 'string',
        required: true,
        description:
          'Task payload as a JSON object (preferred in tool args) or a JSON string of an object.',
      },
      taskId: {
        type: 'string',
        required: false,
        description: 'Optional id for tracing / async reply correlation.',
      },
      pathSuffix: {
        type: 'string',
        required: false,
        description: 'Appended to the configured peer URL path (no leading slash required).',
      },
      contentType: {
        type: 'string',
        required: false,
        description: 'Request Content-Type (default application/json).',
      },
    },
  },
}

function parseO2oChannels(channels: GatewayPluginHostContext['channels']): {
  egress: Map<string, EgressConfig>
  ingressSecrets: Map<string, string>
} {
  const egress = new Map<string, EgressConfig>()
  const ingressSecrets = new Map<string, string>()
  for (const [id, row] of Object.entries(channels)) {
    if (row.plugin !== 'channel-o2o') continue
    const peerUrl = typeof row.peerUrl === 'string' ? row.peerUrl.trim() : ''
    if (peerUrl) {
      try {
        void new URL(peerUrl)
      } catch {
        throw new Error(`channel-o2o: channels.${id}.peerUrl is not a valid URL: ${peerUrl}`)
      }
      egress.set(id, {
        peerUrl,
        headers:
          isRecord(row.headers) ?
            Object.fromEntries(
              Object.entries(row.headers).filter(
                (e): e is [string, string] =>
                  typeof e[0] === 'string' && typeof e[1] === 'string',
              ),
            )
          : undefined,
        timeoutMs:
          typeof row.timeoutMs === 'number' && Number.isFinite(row.timeoutMs) ?
            Math.max(1_000, row.timeoutMs)
          : 60_000,
      })
    }
    const secret = typeof row.ingressSecret === 'string' ? row.ingressSecret.trim() : ''
    if (secret) {
      ingressSecrets.set(id, secret)
    }
  }
  return { egress, ingressSecrets }
}

export function createGatewayPluginHost(
  _moduleExports: Record<string, unknown>,
  ctx: GatewayPluginHostContext,
): GatewayPluginHost {
  const dlog = ctx.debugLog
  let parsed: ReturnType<typeof parseO2oChannels> | null = null

  const prepare = (): void => {
    parsed = parseO2oChannels(ctx.channels)
    dlog?.log('o2o', 'prepare', {
      egressChannels: [...parsed.egress.keys()],
      ingressChannels: [...parsed.ingressSecrets.keys()],
    })
  }

  const invoke = async (c: InvokeContext): Promise<InvokeResult | null> => {
    const p = parsed ?? parseO2oChannels(ctx.channels)
    const cfg = p.egress.get(c.channelId)
    if (!cfg) {
      if (p.ingressSecrets.has(c.channelId)) {
        return {
          ok: false,
          error:
            'channel-o2o: this channel is ingress-only (has ingressSecret but no peerUrl). Use a separate egress channel with peerUrl for send.',
        }
      }
      return null
    }

    if (c.capability !== 'send') {
      return { ok: false, error: `channel-o2o: unsupported capability ${c.capability}` }
    }

    const payloadResult = parsePayload(c.args)
    if (!payloadResult.ok) {
      return { ok: false, error: payloadResult.error }
    }

    const taskId =
      typeof c.args.taskId === 'string' && c.args.taskId.trim() ?
        c.args.taskId.trim()
      : undefined
    const pathSuffix =
      typeof c.args.pathSuffix === 'string' ? c.args.pathSuffix : undefined
    const contentType =
      typeof c.args.contentType === 'string' && c.args.contentType.trim() ?
        c.args.contentType.trim()
      : 'application/json'

    const url = resolvePeerUrl(cfg.peerUrl, pathSuffix)
    const body = buildRequestBody(payloadResult.value, taskId)

    const headers: Record<string, string> = {
      'content-type': contentType,
      ...cfg.headers,
    }

    dlog?.log('o2o', 'send', { channelId: c.channelId, url })

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), cfg.timeoutMs)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ac.signal,
      })
      const text = await res.text()
      let data: unknown = text
      try {
        data = JSON.parse(text) as unknown
      } catch {
        // keep raw text
      }
      return {
        ok: true,
        data: {
          status: res.status,
          statusText: res.statusText,
          peerResponse: data,
        },
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, error: `channel-o2o send failed: ${msg}` }
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    capabilities: O2O_CAPABILITIES,
    prepare,
    async afterHubReady() {},
    invoke,
    async handleHttp(req, io, httpCtx) {
      const p = parsed ?? parseO2oChannels(ctx.channels)
      if (p.ingressSecrets.size === 0) return null
      return handleO2oPost(req, {
        ttlMs: httpCtx.ttlMs,
        resolveChannel(channelId: string) {
          const ch = httpCtx.config.channels[channelId]
          if (!ch || ch.plugin !== 'channel-o2o') return null
          const secret = p.ingressSecrets.get(channelId)
          if (!secret) return null
          return { plugin: 'channel-o2o', ingressSecret: secret }
        },
        hooks: {
          insertQueuedEvent(event, expiresAt): void {
            dbInsertQueuedEvent(io.db, event, expiresAt)
          },
          deleteQueuedEvent(id: string): void {
            dbDeleteQueuedEvent(io.db, id)
          },
          getIpcClientCount(): number {
            return io.hub.clientCount
          },
          broadcastEvent(event): void {
            io.hub.broadcast({ type: 'event', event })
          },
        },
      })
    },
  }
}
