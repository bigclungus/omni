import type { CapabilityDef } from '@omnibot/core'

import type { LoadedGatewayConfig } from './config.ts'
import type { GatewayDebugLogger } from './debug-log.ts'
import type { InvokeResult } from './ipc.ts'
import type { GatewayIo } from './run.ts'

export type { InvokeResult }

/**
 * Shared contract for `@omnibot/channel-*` packages loaded by the gateway host process.
 */
export interface GatewayPluginHostContext {
  channels: Record<string, { plugin: string; [key: string]: unknown }>
  /** Parsed `omni.yaml` root (plugin-specific keys live here). */
  document: Record<string, unknown>
  replyHandleTtlMs: number
  /** Set by `omnibot-gateway --debug`; channel plugins may log extra detail. */
  debugLog?: GatewayDebugLogger
}

/** Passed to {@link GatewayPluginHost.handleHttp} (e.g. webhook ingress). */
export interface GatewayPluginHttpContext {
  ttlMs: number
  config: LoadedGatewayConfig
}

export interface InvokeContext {
  /** Omni channel ID the invoke is addressed to. */
  channelId: string
  capability: string
  args: Record<string, unknown>
  /** Parsed route_json from the reply_handles table. Present when a replyHandle was supplied. */
  route?: Record<string, unknown>
}

export interface PluginChannelHealth {
  /** Omni channel ID. */
  channelId: string
  /** Whether the plugin has an active connection for this channel. */
  connected: boolean
  /** ISO timestamp of the last received message, if tracked. */
  lastMessageAt?: string
}

export interface GatewayPluginHost {
  /**
   * Capabilities this plugin exposes, keyed by capability name.
   * Reported verbatim in `omni_context` so Claude knows what to call and with what args.
   */
  capabilities: Record<string, CapabilityDef>
  prepare(): void
  afterHubReady(io: GatewayIo): Promise<void>
  /**
   * Handle an invoke for a channel this plugin owns.
   * Return `null` to defer to the next plugin (e.g. wrong channelId).
   */
  invoke(ctx: InvokeContext): Promise<InvokeResult | null>
  /**
   * Optional HTTP ingress. Return `null` to defer to the next plugin.
   */
  handleHttp?(
    req: Request,
    io: GatewayIo,
    ctx: GatewayPluginHttpContext,
  ): Promise<Response | null>
  /**
   * Optional health report for each channel this plugin manages.
   * Used by the `GET /health/channels` endpoint.
   */
  getHealth?(): PluginChannelHealth[]
}

export type CreateGatewayPluginHost = (
  moduleExports: Record<string, unknown>,
  ctx: GatewayPluginHostContext,
) => GatewayPluginHost
