/**
 * @omnibot/channel-clungcord
 *
 * Bridges a clungcord channel (e.g. #clungslop) into the omni gateway.
 * Ingress: WebSocket listener → queues OmnichannelEvents for Claude to consume.
 * Egress: HTTP POST to clungcord /api/channels/:id/messages as the bot user.
 *
 * omni.yaml config:
 *   clungcord-clungslop:
 *     plugin: channel-clungcord
 *     clungcordUrl: "http://localhost:8120"
 *     clungcordChannelId: 4
 *     clungcordBotCookie: "bigclungus.<hmac-sig>"
 *     clungcordBotUsername: "bigclungus"
 */

import { createHmac } from 'node:crypto'

import type { OmnichannelEvent } from '@omnibot/core'
import type { CapabilityDef } from '@omnibot/core'
import type {
  GatewayIo,
  GatewayPluginHost,
  GatewayPluginHostContext,
  InvokeContext,
  InvokeResult,
  PluginChannelHealth,
} from '@omnibot/gateway'
import {
  deleteQueuedEvent as dbDeleteQueuedEvent,
  insertQueuedEvent as dbInsertQueuedEvent,
  insertReplyHandle,
} from '@omnibot/gateway'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ClungcordChannelConfig {
  plugin: string
  clungcordUrl?: string
  clungcordChannelId?: number
  clungcordBotCookie?: string
  clungcordBotUsername?: string
  [key: string]: unknown
}

interface ClungcordMessage {
  id: number
  channel_id: number
  content: string
  author: {
    id: number
    username: string
    display_name: string | null
  }
  created_at: number
}

interface ClungcordServerEvent {
  type: string
  message?: ClungcordMessage
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBotCookie(username: string, secret: string): string {
  const sig = createHmac('sha256', secret).update(username).digest('hex')
  return `${username}.${sig}`
}

function resolveConfig(
  omniChannelId: string,
  channels: Record<string, ClungcordChannelConfig>,
  document: Record<string, unknown>,
): {
  url: string
  channelId: number
  cookie: string
  botUsername: string
} {
  const ch = channels[omniChannelId] as ClungcordChannelConfig | undefined
  if (!ch) throw new Error(`channel-clungcord: no config for channel ${omniChannelId}`)

  const url =
    (ch.clungcordUrl as string | undefined) ??
    ((document.clungcord as { url?: string } | undefined)?.url) ??
    'http://localhost:8120'

  const channelId =
    typeof ch.clungcordChannelId === 'number'
      ? ch.clungcordChannelId
      : parseInt(String(ch.clungcordChannelId ?? ''), 10)

  if (!channelId || isNaN(channelId)) {
    throw new Error(`channel-clungcord: clungcordChannelId is required for ${omniChannelId}`)
  }

  const botUsername =
    (ch.clungcordBotUsername as string | undefined) ??
    ((document.clungcord as { botUsername?: string } | undefined)?.botUsername) ??
    'bigclungus'

  // Cookie can be supplied directly, or we derive it from COOKIE_SECRET env
  let cookie = ch.clungcordBotCookie as string | undefined
  if (!cookie) {
    const secret =
      ((document.clungcord as { cookieSecret?: string } | undefined)?.cookieSecret) ??
      process.env.COOKIE_SECRET ?? ''
    if (!secret) {
      throw new Error(
        `channel-clungcord: clungcordBotCookie or COOKIE_SECRET is required for ${omniChannelId}`,
      )
    }
    cookie = makeBotCookie(botUsername, secret)
  }

  return { url, channelId, cookie, botUsername }
}

// ---------------------------------------------------------------------------
// WS connection manager
// ---------------------------------------------------------------------------

interface ClungcordConnection {
  ws: WebSocket | null
  connected: boolean
  lastMessageAt: Date | null
  reconnectTimer: ReturnType<typeof setTimeout> | null
}

function startWsConnection(
  omniChannelId: string,
  url: string,
  cookie: string,
  watchChannelId: number,
  botUsername: string,
  io: GatewayIo,
  ttlMs: number,
  dlog?: { log: (ns: string, msg: string, data?: unknown) => void },
): ClungcordConnection {
  const conn: ClungcordConnection = {
    ws: null,
    connected: false,
    lastMessageAt: null,
    reconnectTimer: null,
  }

  function connect() {
    const wsUrl = url.replace(/^http/, 'ws') + '/ws'
    dlog?.log('clungcord', `ws connect ${wsUrl}`)

    const ws = new WebSocket(wsUrl, {
      headers: { Cookie: `tauth_github=${cookie}` },
    } as unknown as string[]) as WebSocket

    conn.ws = ws

    ws.onopen = () => {
      dlog?.log('clungcord', 'ws open')
      conn.connected = true
    }

    ws.onclose = (ev) => {
      dlog?.log('clungcord', 'ws close', { code: (ev as CloseEvent).code })
      conn.connected = false
      conn.ws = null
      // Reconnect after 5s
      conn.reconnectTimer = setTimeout(connect, 5_000)
    }

    ws.onerror = (err) => {
      dlog?.log('clungcord', 'ws error', String(err))
    }

    ws.onmessage = (raw) => {
      let event: ClungcordServerEvent
      try {
        event = JSON.parse(String((raw as MessageEvent).data)) as ClungcordServerEvent
      } catch {
        return
      }

      if (event.type !== 'message_create') return

      const msg = event.message
      if (!msg) return
      if (msg.channel_id !== watchChannelId) return

      // Skip messages from the bot itself to avoid echo loops
      if (msg.author.username === botUsername) return

      dlog?.log('clungcord', 'message_create', { id: msg.id, author: msg.author.username })
      conn.lastMessageAt = new Date()

      const displayName = msg.author.display_name ?? msg.author.username

      const omniEvent: OmnichannelEvent = {
        id: `clungcord-${msg.id}`,
        channelId: omniChannelId,
        plugin: 'channel-clungcord',
        receivedAt: new Date().toISOString(),
        payload: {
          type: 'message',
          content: msg.content,
          user: displayName,
          username: msg.author.username,
          messageId: msg.id,
          channelId: msg.channel_id,
        },
      }

      const expiresAt = Date.now() + ttlMs
      dbInsertQueuedEvent(io.db, omniEvent, expiresAt)
      io.hub.broadcast({ type: 'event', event: omniEvent })

      // Store a reply handle so Claude can reply back to the clungcord message
      const replyHandleId = `clungcord-rh-${msg.id}`
      const routeJson = JSON.stringify({
        kind: 'clungcord',
        messageId: msg.id,
        channelId: msg.channel_id,
        omniChannelId,
      })
      insertReplyHandle(io.db, replyHandleId, omniChannelId, routeJson, expiresAt)
    }
  }

  connect()
  return conn
}

// ---------------------------------------------------------------------------
// Egress — post a message to clungcord
// ---------------------------------------------------------------------------

async function postToClungcord(
  url: string,
  channelId: number,
  cookie: string,
  text: string,
): Promise<void> {
  const res = await fetch(`${url}/api/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `tauth_github=${cookie}`,
    },
    body: JSON.stringify({ content: text }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '(unreadable)')
    throw new Error(`clungcord POST /messages failed: ${res.status} ${body}`)
  }
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

const CLUNGCORD_CAPABILITIES: Record<string, CapabilityDef> = {
  send_message: {
    description: 'Send a message to the clungcord channel',
    requiresReplyHandle: false,
    args: {
      text: { type: 'string', required: true },
    },
  },
  reply: {
    description: 'Reply (send a message) to the clungcord channel — same as send_message for now',
    requiresReplyHandle: true,
    args: {
      text: { type: 'string', required: true },
    },
  },
}

export function createGatewayPluginHost(
  _moduleExports: Record<string, unknown>,
  ctx: GatewayPluginHostContext,
): GatewayPluginHost {
  const dlog = ctx.debugLog
  const channels = ctx.channels as Record<string, ClungcordChannelConfig>

  // Find all channels using this plugin
  const clungcordChannelIds = Object.entries(channels)
    .filter(([, ch]) => ch.plugin === 'channel-clungcord')
    .map(([id]) => id)

  // Per-channel runtime state
  const configs = new Map<string, ReturnType<typeof resolveConfig>>()
  const connections = new Map<string, ClungcordConnection>()

  const prepare = (): void => {
    for (const omniChannelId of clungcordChannelIds) {
      dlog?.log('clungcord', `prepare ${omniChannelId}`)
      const cfg = resolveConfig(omniChannelId, channels, ctx.document)
      configs.set(omniChannelId, cfg)
      dlog?.log('clungcord', `resolved config`, {
        url: cfg.url,
        channelId: cfg.channelId,
        botUsername: cfg.botUsername,
      })
    }
  }

  const afterHubReady = async (io: GatewayIo): Promise<void> => {
    const ttlMs = (ctx.document.gateway as { queueTtlSeconds?: number } | undefined)
      ?.queueTtlSeconds
      ? ((ctx.document.gateway as { queueTtlSeconds: number }).queueTtlSeconds) * 1000
      : 86_400_000

    for (const omniChannelId of clungcordChannelIds) {
      const cfg = configs.get(omniChannelId)
      if (!cfg) continue
      dlog?.log('clungcord', `afterHubReady: starting WS for ${omniChannelId}`)
      const conn = startWsConnection(
        omniChannelId,
        cfg.url,
        cfg.cookie,
        cfg.channelId,
        cfg.botUsername,
        io,
        ttlMs,
        dlog,
      )
      connections.set(omniChannelId, conn)
    }
  }

  const invoke = async (ctx2: InvokeContext): Promise<InvokeResult | null> => {
    const cfg = configs.get(ctx2.channelId)
    if (!cfg) return null

    if (ctx2.capability === 'send_message' || ctx2.capability === 'reply') {
      const text = ctx2.args.text
      if (typeof text !== 'string' || !text.trim()) {
        return { ok: false, error: 'text is required' }
      }
      try {
        await postToClungcord(cfg.url, cfg.channelId, cfg.cookie, text)
        return { ok: true, data: { sent: true } }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }

    return { ok: false, error: `unknown capability: ${ctx2.capability}` }
  }

  const getHealth = (): PluginChannelHealth[] =>
    clungcordChannelIds.map(id => {
      const conn = connections.get(id)
      return {
        channelId: id,
        connected: conn?.connected ?? false,
        ...(conn?.lastMessageAt ? { lastMessageAt: conn.lastMessageAt.toISOString() } : {}),
      }
    })

  return {
    capabilities: CLUNGCORD_CAPABILITIES,
    prepare,
    afterHubReady,
    invoke,
    getHealth,
  }
}
