/** Stored in `reply_handles.route_json` for Discord egress. */
export interface DiscordRouteData {
  kind: 'discord'
  guildId: string
  channelId: string
  messageId: string
}

function randomSuffix(): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'
  let s = ''
  for (let i = 0; i < 8; i++) {
    s += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return s
}

export function newReplyHandleId(): string {
  return `omni_${randomSuffix()}`
}
