import {
  ChannelType,
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type ThreadChannel,
  type User,
} from 'discord.js'

import type { OmnichannelEvent } from '@omnibot/core'
import type { GatewayDebugLogger } from '@omnibot/gateway'

import type { DiscordIngressHub, DiscordIngressStore } from './types.ts'
import type { DiscordRouteData } from './route.ts'
import { newReplyHandleId } from './route.ts'

export interface DiscordRuntime {
  client: Client
  stop: () => Promise<void>
}

export interface StartDiscordBotOptions {
  /** Pairs of Discord channel snowflake → omnichannel config channel id. */
  subscriptions: Array<{ discordChannelId: string; omniChannelId: string }>
  store: DiscordIngressStore
  hub: DiscordIngressHub
  client: Client
  token: string
  replyHandleTtlMs: number
  debugLog?: GatewayDebugLogger
}

function buildThreadInfo(msg: Message): Record<string, unknown> | null {
  const isThread =
    msg.channel.type === ChannelType.PublicThread ||
    msg.channel.type === ChannelType.PrivateThread ||
    msg.channel.type === ChannelType.AnnouncementThread
  if (!isThread) return null
  return {
    id: msg.channelId,
    name: (msg.channel as ThreadChannel).name,
    parentId: (msg.channel as ThreadChannel).parentId,
  }
}

async function fetchReferencedMessage(msg: Message): Promise<Record<string, unknown> | null> {
  const refId = msg.reference?.messageId
  if (!refId) return null
  try {
    const refMsg = await msg.channel.messages.fetch(refId)
    return {
      id: refMsg.id,
      text: refMsg.content,
      author: { id: refMsg.author.id, username: refMsg.author.username },
      timestamp: refMsg.createdAt.toISOString(),
    }
  } catch {
    return null
  }
}

async function buildDiscordMessagePayload(
  msg: Message,
  replyHandle: string,
  omniChannelId: string,
): Promise<Record<string, unknown>> {
  const thread = buildThreadInfo(msg)
  const referencedMessage = await fetchReferencedMessage(msg)

  const attachments = [...msg.attachments.values()].map(a => ({
    name: a.name,
    contentType: a.contentType,
    size: a.size,
    url: a.url,
  }))

  return {
    replyHandle,
    text: msg.content ?? '',
    author: {
      id: msg.author.id,
      username: msg.author.username,
      bot: msg.author.bot,
    },
    channelId: msg.channelId,
    messageId: msg.id,
    guildId: msg.guildId,
    omniChannelId,
    ...(thread ? { thread } : {}),
    ...(referencedMessage ? { referencedMessage } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    discord: {
      channelId: msg.channelId,
      messageId: msg.id,
      guildId: msg.guildId,
    },
  }
}

export function createDiscordClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      /** Privileged: enable "Message Content Intent" in the Discord Developer Portal (Bot tab). */
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction],
  })
}

export async function startDiscordBot(
  options: StartDiscordBotOptions,
): Promise<DiscordRuntime> {
  const {
    subscriptions,
    store,
    hub,
    client,
    token,
    replyHandleTtlMs,
    debugLog: dlog,
  } = options

  const discordChannels = new Map<string, string>()
  for (const s of subscriptions) {
    discordChannels.set(s.discordChannelId, s.omniChannelId)
  }

  dlog?.log('discord', 'bot: subscriptions map', {
    discordChannelIds: [...discordChannels.keys()],
  })

  function lookupOmniChannel(channelId: string, channel: { isThread?: () => boolean }): string | undefined {
    const lookupId = channel.isThread?.()
      ? ((channel as ThreadChannel).parentId ?? channelId)
      : channelId
    return discordChannels.get(lookupId)
  }

  // Typing indicator: single one-shot sendTyping() call (~10s natural Discord expiry).
  function startTyping(channelId: string, channel: { sendTyping?: () => Promise<void> }): void {
    if (!channel.sendTyping) return
    void channel.sendTyping().catch(() => {})
  }

  function emitEvent(event: OmnichannelEvent, expiresAt: number): void {
    store.insertQueuedEvent(event, expiresAt)
    if (hub.clientCount > 0) {
      hub.broadcastEvent(event)
      store.deleteQueuedEvent(event.id)
    }
  }

  client.on('messageCreate', async (msg: Message) => {
    try {
      if (msg.author.id === client.user?.id) return
      if (msg.author.bot) return

      const omniChannelId = lookupOmniChannel(msg.channelId, msg.channel)
      if (!omniChannelId) return

      const replyHandle = newReplyHandleId()
      const route: DiscordRouteData = {
        kind: 'discord',
        guildId: msg.guildId ?? '',
        channelId: msg.channelId,
        messageId: msg.id,
      }

      const expiresAt = Date.now() + replyHandleTtlMs
      store.insertReplyHandle(replyHandle, omniChannelId, JSON.stringify(route), expiresAt)

      const payload = await buildDiscordMessagePayload(msg, replyHandle, omniChannelId)
      const event: OmnichannelEvent = {
        id: crypto.randomUUID(),
        channelId: omniChannelId,
        plugin: 'channel-discord',
        receivedAt: new Date().toISOString(),
        payload,
      }

      dlog?.log('discord', 'messageCreate → omnichannel event', {
        omniChannelId,
        discordChannelId: msg.channelId,
        messageId: msg.id,
        replyHandle,
        ipcClients: hub.clientCount,
        broadcast: hub.clientCount > 0,
      })

      emitEvent(event, expiresAt)
      startTyping(msg.channelId, msg.channel)
    } catch (err) {
      process.stderr.write(`omnichannel channel-discord: messageCreate error: ${err}\n`)
    }
  })

  client.on('messageReactionAdd', async (reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) => {
    try {
      if (user.bot) return

      if (reaction.partial) {
        try { await reaction.fetch() } catch { return }
      }
      if (user.partial) {
        try { await user.fetch() } catch { return }
      }

      const msg = reaction.message.partial
        ? await reaction.message.fetch().catch(() => null)
        : reaction.message
      if (!msg) return

      const omniChannelId = lookupOmniChannel(msg.channelId, msg.channel)
      if (!omniChannelId) return

      const thread = buildThreadInfo(msg)
      const referencedMessage = await fetchReferencedMessage(msg)

      const attachments = [...msg.attachments.values()].map(a => ({
        name: a.name,
        contentType: a.contentType,
        size: a.size,
      }))

      const replyHandle = newReplyHandleId()
      const route: DiscordRouteData = {
        kind: 'discord',
        guildId: msg.guildId ?? '',
        channelId: msg.channelId,
        messageId: msg.id,
      }

      const expiresAt = Date.now() + replyHandleTtlMs
      store.insertReplyHandle(replyHandle, omniChannelId, JSON.stringify(route), expiresAt)

      const event: OmnichannelEvent = {
        id: crypto.randomUUID(),
        channelId: omniChannelId,
        plugin: 'channel-discord',
        receivedAt: new Date().toISOString(),
        payload: {
          replyHandle,
          kind: 'reaction',
          emoji: reaction.emoji.toString(),
          reactor: {
            id: user.id,
            username: (user as User).username,
          },
          message: {
            id: msg.id,
            text: msg.content || '',
            author: {
              id: msg.author?.id,
              username: msg.author?.username,
            },
            timestamp: msg.createdAt.toISOString(),
            ...(attachments.length > 0 ? { attachments } : {}),
            ...(referencedMessage ? { referencedMessage } : {}),
          },
          channelId: msg.channelId,
          guildId: msg.guildId,
          omniChannelId,
          ...(thread ? { thread } : {}),
          discord: {
            channelId: msg.channelId,
            messageId: msg.id,
            guildId: msg.guildId,
          },
        },
      }

      dlog?.log('discord', 'messageReactionAdd → omnichannel event', {
        omniChannelId,
        discordChannelId: msg.channelId,
        messageId: msg.id,
        emoji: reaction.emoji.toString(),
        reactor: user.id,
      })

      emitEvent(event, expiresAt)
    } catch (err) {
      process.stderr.write(`omnichannel channel-discord: messageReactionAdd error: ${err}\n`)
    }
  })

  client.once('clientReady', c => {
    process.stderr.write(`omnichannel channel-discord: connected as ${c.user.tag}\n`)
    dlog?.log('discord', 'clientReady', {
      tag: c.user.tag,
      userId: c.user.id,
      guilds: c.guilds.cache.size,
    })
  })

  client.on('error', err => {
    process.stderr.write(`omnichannel channel-discord: client error: ${err}\n`)
    dlog?.log('discord', 'client error', {
      message: err instanceof Error ? err.message : String(err),
    })
  })

  dlog?.log('discord', 'client.login (starting)')
  await client.login(token)
  dlog?.log('discord', 'client.login (promise resolved)')

  return {
    client,
    stop: async () => {
      client.destroy()
    },
  }
}
