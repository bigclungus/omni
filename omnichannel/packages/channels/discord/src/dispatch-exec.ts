import type { Client } from 'discord.js'

import type { GatewayDebugLogger } from '@omnibot/gateway'

import type { DiscordRouteData } from './route.ts'

export async function executeDiscordDispatch(
  client: Client,
  route: DiscordRouteData,
  action: string,
  args: Record<string, unknown>,
  debugLog?: GatewayDebugLogger,
): Promise<string> {
  debugLog?.log('discord', 'dispatch: fetch channel', { channelId: route.channelId })
  const ch = await client.channels.fetch(route.channelId)
  if (!ch?.isTextBased()) {
    throw new Error('Discord channel is not text-based')
  }
  debugLog?.log('discord', 'dispatch: fetch message', {
    messageId: route.messageId,
  })
  const msg = await ch.messages.fetch(route.messageId)

  if (action === 'reply') {
    const text = args.text
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error('reply requires args.text')
    }
    debugLog?.log('discord', 'dispatch: reply', { length: text.length })
    await msg.reply({ content: text })
    return 'replied'
  }

  if (action === 'react') {
    const emoji = args.emoji
    if (typeof emoji !== 'string' || !emoji.trim()) {
      throw new Error('react requires args.emoji')
    }
    debugLog?.log('discord', 'dispatch: react', { emoji })
    await msg.react(emoji)
    return 'reacted'
  }

  if (action === 'ack' || action === 'noop') {
    debugLog?.log('discord', 'dispatch: noop', { action })
    return 'ok'
  }

  throw new Error(`unknown action: ${action}`)
}
