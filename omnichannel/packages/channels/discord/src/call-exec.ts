import type { Client } from 'discord.js'

import type { CallResult } from '@omnibot/gateway'

export async function executeDiscordCall(
  client: Client,
  channelId: string,
  method: string,
  args: Record<string, unknown>,
): Promise<CallResult> {
  if (method === 'fetch_history') {
    return fetchHistory(client, channelId, args)
  }
  if (method === 'download_attachment') {
    return downloadAttachment(client, args)
  }
  return { ok: false, error: `unknown method: ${method}` }
}

async function fetchHistory(
  client: Client,
  channelId: string,
  args: Record<string, unknown>,
): Promise<CallResult> {
  const limit = typeof args.limit === 'number'
    ? Math.min(Math.max(1, args.limit), 100)
    : 20

  const ch = await client.channels.fetch(channelId).catch(() => null)
  if (!ch?.isTextBased()) {
    return { ok: false, error: `channel ${channelId} not found or not text-based` }
  }

  const messages = await ch.messages.fetch({ limit }).catch((e: unknown) => {
    throw new Error(`failed to fetch messages: ${e instanceof Error ? e.message : String(e)}`)
  })

  const sorted = [...messages.values()].sort(
    (a, b) => a.createdTimestamp - b.createdTimestamp,
  )

  const data = sorted.map(m => ({
    id: m.id,
    author: { id: m.author.id, username: m.author.username, bot: m.author.bot },
    content: m.content,
    timestamp: m.createdAt.toISOString(),
    attachments: [...m.attachments.values()].map(a => ({
      name: a.name,
      contentType: a.contentType,
      size: a.size,
      url: a.url,
    })),
  }))

  return { ok: true, data }
}

async function downloadAttachment(
  _client: Client,
  args: Record<string, unknown>,
): Promise<CallResult> {
  const url = args.url
  if (typeof url !== 'string' || !url.trim()) {
    return { ok: false, error: 'download_attachment requires args.url' }
  }

  const res = await fetch(url).catch((e: unknown) => {
    throw new Error(`fetch failed: ${e instanceof Error ? e.message : String(e)}`)
  })

  if (!res.ok) {
    return { ok: false, error: `HTTP ${res.status} fetching attachment` }
  }

  const contentType = res.headers.get('content-type') ?? 'application/octet-stream'
  const isText = contentType.startsWith('text/') ||
    contentType.includes('json') ||
    contentType.includes('xml') ||
    contentType.includes('javascript') ||
    contentType.includes('yaml')

  if (isText) {
    const text = await res.text()
    return { ok: true, data: { contentType, encoding: 'text', content: text } }
  }

  const buf = await res.arrayBuffer()
  const base64 = Buffer.from(buf).toString('base64')
  return {
    ok: true,
    data: {
      contentType,
      encoding: 'base64',
      content: base64,
      size: buf.byteLength,
    },
  }
}
