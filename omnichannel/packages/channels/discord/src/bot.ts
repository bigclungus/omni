import {
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
} from 'discord.js'

import type { OmnichannelEvent } from '@omnichannel/core'

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
}

function buildDiscordMessagePayload(
  msg: Message,
  replyHandle: string,
  omniChannelId: string,
): Record<string, unknown> {
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
      /** Privileged: enable “Message Content Intent” in the Discord Developer Portal (Bot tab). */
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
  } = options

  const discordChannels = new Map<string, string>()
  for (const s of subscriptions) {
    discordChannels.set(s.discordChannelId, s.omniChannelId)
  }

  client.on('messageCreate', (msg: Message) => {
    if (msg.author.bot) return
    const omniChannelId = discordChannels.get(msg.channelId)
    if (!omniChannelId) return

    const replyHandle = newReplyHandleId()
    const route: DiscordRouteData = {
      kind: 'discord',
      guildId: msg.guildId ?? '',
      channelId: msg.channelId,
      messageId: msg.id,
    }

    const expiresAt = Date.now() + replyHandleTtlMs
    store.insertReplyHandle(
      replyHandle,
      omniChannelId,
      JSON.stringify(route),
      expiresAt,
    )

    const event: OmnichannelEvent = {
      id: crypto.randomUUID(),
      channelId: omniChannelId,
      plugin: 'discord',
      receivedAt: new Date().toISOString(),
      payload: buildDiscordMessagePayload(msg, replyHandle, omniChannelId),
    }

    store.insertQueuedEvent(event, expiresAt)

    if (hub.clientCount > 0) {
      hub.broadcastEvent(event)
      store.deleteQueuedEvent(event.id)
    }
  })

  client.once('clientReady', c => {
    process.stderr.write(`omnichannel channel-discord: connected as ${c.user.tag}\n`)
  })

  client.on('error', err => {
    process.stderr.write(`omnichannel channel-discord: client error: ${err}\n`)
  })

  await client.login(token)

  return {
    client,
    stop: async () => {
      client.destroy()
    },
  }
}
