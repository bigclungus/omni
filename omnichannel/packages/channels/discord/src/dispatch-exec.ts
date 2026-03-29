import type { Client } from 'discord.js'

import type { DiscordRouteData } from './route.ts'

export async function executeDiscordDispatch(
  client: Client,
  route: DiscordRouteData,
  action: string,
  args: Record<string, unknown>,
): Promise<string> {
  const ch = await client.channels.fetch(route.channelId)
  if (!ch?.isTextBased()) {
    throw new Error('Discord channel is not text-based')
  }
  const msg = await ch.messages.fetch(route.messageId)

  if (action === 'reply') {
    const text = args.text
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error('reply requires args.text')
    }
    await msg.reply({ content: text })
    return 'replied'
  }

  if (action === 'react') {
    const emoji = args.emoji
    if (typeof emoji !== 'string' || !emoji.trim()) {
      throw new Error('react requires args.emoji')
    }
    await msg.react(emoji)
    return 'reacted'
  }

  if (action === 'ack' || action === 'noop') {
    return 'ok'
  }

  if (action === 'resolve') {
    throw new Error('resolve is not supported for Discord')
  }

  throw new Error(`unknown action: ${action}`)
}
