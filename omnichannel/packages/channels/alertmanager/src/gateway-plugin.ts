import type { OmnichannelEvent } from '@omnibot/core'
import {
  deleteQueuedEvent as dbDeleteQueuedEvent,
  insertQueuedEvent as dbInsertQueuedEvent,
  type GatewayIo,
  type GatewayPluginHost,
  type GatewayPluginHostContext,
  type GatewayPluginHttpContext,
} from '@omnibot/gateway'

import { handleAlertmanagerPost } from './alertmanager-ingress.ts'

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

/** Ingress-only channel: Alertmanager webhooks; no egress via `omni_dispatch`. */
export function createGatewayPluginHost(
  _moduleExports: Record<string, unknown>,
  _ctx: GatewayPluginHostContext,
): GatewayPluginHost {
  return {
    capabilities: {},
    prepare() {},
    async afterHubReady() {},
    async invoke() {
      return null
    },
    async handleHttp(req: Request, io: GatewayIo, httpCtx: GatewayPluginHttpContext) {
      return handleAlertmanagerPost(req, buildAlertmanagerIngressContext(io, httpCtx))
    },
  }
}

function buildAlertmanagerIngressContext(
  io: GatewayIo,
  { ttlMs, config }: GatewayPluginHttpContext,
) {
  return {
    ttlMs,
    resolveChannel(channelId: string) {
      const ch = config.channels[channelId]
      if (!ch) return null
      const bearerToken =
        isRecord(ch) && typeof ch.bearerToken === 'string'
          ? ch.bearerToken
          : undefined
      return { plugin: ch.plugin, bearerToken }
    },
    hooks: {
      insertQueuedEvent(event: OmnichannelEvent, expiresAt: number): void {
        dbInsertQueuedEvent(io.db, event, expiresAt)
      },
      deleteQueuedEvent(id: string): void {
        dbDeleteQueuedEvent(io.db, id)
      },
      getIpcClientCount(): number {
        return io.hub.clientCount
      },
      broadcastEvent(event: OmnichannelEvent): void {
        io.hub.broadcast({ type: 'event', event })
      },
    },
  }
}
