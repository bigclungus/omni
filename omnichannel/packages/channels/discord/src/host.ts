/**
 * Gateway host wiring for Discord.
 */

import type { Database } from 'bun:sqlite'

import type { CapabilityDef } from '@omnibot/core'
import type {
  GatewayIo,
  GatewayPluginHost,
  GatewayPluginHostContext,
  InvokeContext,
  InvokeResult,
  IpcHub,
  PluginChannelHealth,
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

const DISCORD_CAPABILITIES: Record<string, CapabilityDef> = {
  reply: {
    description: 'Reply to a specific message',
    requiresReplyHandle: true,
    args: {
      text: { type: 'string', required: true },
    },
  },
  react: {
    description: 'Add an emoji reaction to a specific message',
    requiresReplyHandle: true,
    args: {
      emoji: { type: 'string', required: true },
    },
  },
  ack: {
    description: 'Acknowledge a message without replying',
    requiresReplyHandle: true,
    args: {},
  },
  noop: {
    description: 'No-op',
    requiresReplyHandle: true,
    args: {},
  },
  send_message: {
    description: 'Send a message to a channel without replying to a specific message',
    requiresReplyHandle: false,
    args: {
      text: { type: 'string', required: true },
      channelId: { type: 'string', required: false, description: 'Discord channel/thread ID; defaults to configured channel' },
    },
  },
  fetch_history: {
    description: 'Fetch recent messages from a channel or thread',
    requiresReplyHandle: false,
    args: {
      limit: { type: 'number', required: false, description: 'Number of messages to fetch (1–100, default 20)' },
      threadId: { type: 'string', required: false, description: 'Thread ID to fetch from; defaults to the configured channel' },
    },
  },
  download_attachment: {
    description: 'Download an attachment URL to a temp file',
    requiresReplyHandle: false,
    args: {
      url: { type: 'string', required: true, description: 'Attachment URL from the event payload' },
    },
  },
  voice_join: {
    description: 'Join a Discord voice channel and start a low-latency OpenAI Realtime voice conversation. The bot stays until voice_leave is called.',
    requiresReplyHandle: false,
    args: {
      channelId: { type: 'string', required: true, description: 'Discord voice channel ID to join' },
      instructions: { type: 'string', required: false, description: 'System instructions for the realtime model' },
      voice: { type: 'string', required: false, description: 'OpenAI Realtime voice name (e.g. alloy, echo, shimmer)' },
    },
  },
  voice_leave: {
    description: 'Leave the Discord voice channel and end the active realtime voice session for a guild.',
    requiresReplyHandle: false,
    args: {
      guildId: { type: 'string', required: false, description: 'Guild ID to disconnect from; defaults to the only active session' },
    },
  },
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

export function createGatewayPluginHost(
  moduleExports: Record<string, unknown>,
  options: GatewayPluginHostContext,
): GatewayPluginHost {
  const mod = moduleExports as unknown as DiscordHostModule
  const dlog = options.debugLog
  const subscriptions = parseDiscordSubscriptions(options.channels)
  const omniChannelIds = new Set(subscriptions.map(s => s.omniChannelId))
  const tokenSrc = () => tokenSourceFromDocument(options.channels, options.document)
  const { replyHandleTtlMs } = options

  let runtime: DiscordRuntime | null = null
  let lastMessageAt: Date | null = null

  function wrapDiscordStoreTracked(db: Database): DiscordIngressStore {
    return {
      insertReplyHandle(id, omniChannelId, routeJson, expiresAt): void {
        insertReplyHandle(db, id, omniChannelId, routeJson, expiresAt)
      },
      insertQueuedEvent(event, expiresAt): void {
        lastMessageAt = new Date()
        dbInsertQueuedEvent(db, event, expiresAt)
      },
      deleteQueuedEvent(id): void {
        dbDeleteQueuedEvent(db, id)
      },
    }
  }

  function wrapDiscordHubTracked(hub: IpcHub): DiscordIngressHub {
    return {
      get clientCount() {
        return hub.clientCount
      },
      broadcastEvent(event): void {
        hub.broadcast({ type: 'event', event })
      },
    }
  }

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
    const store = wrapDiscordStoreTracked(io.db)
    const hub = wrapDiscordHubTracked(io.hub)
    runtime = await mod.startDiscordBot({
      subscriptions,
      store,
      hub,
      client: mod.createDiscordClient(),
      token,
      replyHandleTtlMs,
      debugLog: dlog,
    })
    dlog?.log('discord', 'afterHubReady: bot running', { userId: runtime.client.user?.id })
  }

  const invoke = async (ctx: InvokeContext): Promise<InvokeResult | null> => {
    if (!omniChannelIds.has(ctx.channelId)) return null

    const client = runtime?.client
    if (!client) {
      dlog?.log('discord', 'invoke: client not running')
      return { ok: false, error: 'discord client not running' }
    }

    dlog?.log('discord', 'invoke', { channelId: ctx.channelId, capability: ctx.capability })

    // Route-scoped capabilities: need ctx.route (from replyHandle)
    const routeScoped = ['reply', 'react', 'ack', 'noop']
    if (routeScoped.includes(ctx.capability)) {
      if (!ctx.route || ctx.route.kind !== 'discord') {
        return { ok: false, error: `${ctx.capability} requires a valid discord replyHandle` }
      }
      try {
        const detail = await mod.executeDiscordDispatch(
          client,
          ctx.route as unknown as DiscordRouteData,
          ctx.capability,
          ctx.args,
          dlog,
        )
        return { ok: true, data: detail }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }

    // Channel-scoped capabilities: use configured Discord channel ID
    const sub = subscriptions.find(s => s.omniChannelId === ctx.channelId)
    if (!sub) return null
    try {
      return await mod.executeDiscordCall(client, sub.discordChannelId, ctx.capability, ctx.args)
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  const getHealth = (): PluginChannelHealth[] =>
    subscriptions.map(s => ({
      channelId: s.omniChannelId,
      connected: runtime?.client.isReady() ?? false,
      ...(lastMessageAt ? { lastMessageAt: lastMessageAt.toISOString() } : {}),
    }))

  return {
    capabilities: DISCORD_CAPABILITIES,
    prepare,
    afterHubReady,
    invoke,
    getHealth,
  }
}
