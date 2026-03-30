/**
 * Gateway host wiring for Discord.
 */

import type { Database } from 'bun:sqlite'

import type {
  DispatchResult,
  GatewayIo,
  GatewayPluginHost,
  GatewayPluginHostContext,
  IpcHub,
} from '@omnibot/gateway'
import {
  deleteQueuedEvent as dbDeleteQueuedEvent,
  insertQueuedEvent as dbInsertQueuedEvent,
  insertReplyHandle,
} from '@omnibot/gateway'

import { createDiscordClient } from './bot.ts'
import type { DiscordRuntime, StartDiscordBotOptions } from './bot.ts'
import { executeDiscordCall } from './call-exec.ts'
import {
  assertDiscordChannelsHaveIds,
  getDiscordBotToken,
  type DiscordTokenSource,
} from './config-helpers.ts'
import { executeDiscordDispatch } from './dispatch-exec.ts'
import type { DiscordRouteData } from './route.ts'
import type { DiscordIngressHub, DiscordIngressStore } from './types.ts'

export interface DiscordHostModule {
  assertDiscordChannelsHaveIds: typeof assertDiscordChannelsHaveIds
  getDiscordBotToken: typeof getDiscordBotToken
  createDiscordClient: typeof createDiscordClient
  startDiscordBot: (options: StartDiscordBotOptions) => Promise<DiscordRuntime>
  executeDiscordDispatch: typeof executeDiscordDispatch
  executeDiscordCall: typeof executeDiscordCall
}

export function parseDiscordSubscriptions(
  channels: Record<string, { plugin: string; discordChannelId?: unknown }>,
): Array<{ omniChannelId: string; discordChannelId: string }> {
  return Object.entries(channels)
    .filter(([, ch]) => ch.plugin === 'channel-discord' && ch.discordChannelId)
    .map(([omniChannelId, ch]) => ({
      omniChannelId,
      discordChannelId: String(ch.discordChannelId).trim(),
    }))
}

function tokenSourceFromDocument(
  channels: GatewayPluginHostContext['channels'],
  document: Record<string, unknown>,
): DiscordTokenSource {
  return {
    discord: document.discord as { token?: string } | undefined,
    gateway: {
      discordBotTokenEnv: (document.gateway as { discordBotTokenEnv?: string } | undefined)
        ?.discordBotTokenEnv,
    },
    channels: channels as DiscordTokenSource['channels'],
  }
}

function wrapDiscordStore(db: Database): DiscordIngressStore {
  return {
    insertReplyHandle(
      id: string,
      omniChannelId: string,
      routeJson: string,
      expiresAt: number,
    ): void {
      insertReplyHandle(db, id, omniChannelId, routeJson, expiresAt)
    },
    insertQueuedEvent(event, expiresAt): void {
      dbInsertQueuedEvent(db, event, expiresAt)
    },
    deleteQueuedEvent(id: string): void {
      dbDeleteQueuedEvent(db, id)
    },
  }
}

function wrapDiscordHub(hub: IpcHub): DiscordIngressHub {
  return {
    get clientCount() {
      return hub.clientCount
    },
    broadcastEvent(event): void {
      hub.broadcast({ type: 'event', event })
    },
  }
}

export function createGatewayPluginHost(
  moduleExports: Record<string, unknown>,
  options: GatewayPluginHostContext,
): GatewayPluginHost {
  const mod = moduleExports as unknown as DiscordHostModule
  const dlog = options.debugLog
  const subscriptions = parseDiscordSubscriptions(options.channels)
  const omniChannelIds = new Set(subscriptions.map(s => s.omniChannelId))
  const tokenSrc = () =>
    tokenSourceFromDocument(options.channels, options.document)
  const { replyHandleTtlMs } = options

  let runtime: DiscordRuntime | null = null

  const prepare = (): void => {
    dlog?.log('discord', 'prepare', {
      subscriptions: subscriptions.length,
      channelIds: subscriptions.map(s => s.omniChannelId),
    })
    if (subscriptions.length === 0) {
      dlog?.log('discord', 'prepare skip (no discord channel subscriptions)')
      return
    }
    mod.assertDiscordChannelsHaveIds({ channels: options.channels })
    const token = mod.getDiscordBotToken(tokenSrc())
    dlog?.log('discord', 'token resolved', { hasToken: Boolean(token) })
    if (!token) {
      throw new Error(
        'Discord channels are configured but no bot token was found. Set DISCORD_BOT_TOKEN (or gateway.discordBotTokenEnv).',
      )
    }
  }

  const afterHubReady = async (io: GatewayIo): Promise<void> => {
    if (subscriptions.length === 0) return
    const token = mod.getDiscordBotToken(tokenSrc())
    if (!token) return
    dlog?.log('discord', 'afterHubReady: startDiscordBot')
    const store = wrapDiscordStore(io.db)
    const hub = wrapDiscordHub(io.hub)
    runtime = await mod.startDiscordBot({
      subscriptions,
      store,
      hub,
      client: mod.createDiscordClient(),
      token,
      replyHandleTtlMs,
      debugLog: dlog,
    })
    dlog?.log('discord', 'afterHubReady: bot running', {
      userId: runtime.client.user?.id,
    })
  }

  const tryDispatchRoute = async (
    route: { kind?: string },
    action: string,
    args: Record<string, unknown>,
  ): Promise<DispatchResult | null> => {
    if (route.kind !== 'discord') return null
    const client = runtime?.client
    if (!client) {
      dlog?.log('discord', 'tryDispatchRoute: client not running')
      return { ok: false, error: 'discord client not running' }
    }
    dlog?.log('discord', 'tryDispatchRoute', {
      route,
      action,
      args,
    })
    try {
      const detail = await mod.executeDiscordDispatch(
        client,
        route as DiscordRouteData,
        action,
        args,
        dlog,
      )
      dlog?.log('discord', 'tryDispatchRoute ok', { detail })
      return { ok: true, detail }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      dlog?.log('discord', 'tryDispatchRoute error', { error: msg })
      return { ok: false, error: msg }
    }
  }

  const tryCall = async (
    channelId: string,
    method: string,
    args: Record<string, unknown>,
  ) => {
    if (!omniChannelIds.has(channelId)) return null
    const client = runtime?.client
    if (!client) {
      dlog?.log('discord', 'tryCall: client not running')
      return { ok: false as const, error: 'discord client not running' }
    }
    // Resolve the Discord channel ID from the omni channel ID
    const sub = subscriptions.find(s => s.omniChannelId === channelId)
    if (!sub) return null
    dlog?.log('discord', 'tryCall', { channelId, discordChannelId: sub.discordChannelId, method, args })
    try {
      return await mod.executeDiscordCall(client, sub.discordChannelId, method, args)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      dlog?.log('discord', 'tryCall error', { error: msg })
      return { ok: false as const, error: msg }
    }
  }

  return {
    calls: ['fetch_history', 'download_attachment'],
    prepare,
    afterHubReady,
    tryDispatchRoute,
    tryCall,
  }
}
