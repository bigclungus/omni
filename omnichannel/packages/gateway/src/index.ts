#!/usr/bin/env bun
/**
 * Omnichannel Gateway — composition root: wiring only.
 */

import type { Database } from 'bun:sqlite'
import { resolve } from 'node:path'

import {
  createDiscordClient,
  executeDiscordDispatch,
  startDiscordBot,
  type DiscordRouteData,
  type DiscordRuntime,
} from '@omnichannel/channel-discord'
import type { OmnichannelEvent } from '@omnichannel/core'
import { validateOmniDispatch } from '@omnichannel/core'

import {
  getCapabilities,
  getDiscordBotToken,
  loadConfig,
  resolveGatewayIpcSocketPath,
} from './config.ts'
import {
  deleteQueuedEvent as dbDeleteQueuedEvent,
  gcExpired,
  gcExpiredReplyHandles,
  getReplyHandleRow,
  insertQueuedEvent as dbInsertQueuedEvent,
  insertReplyHandle,
  listPendingEvents,
  openDatabase,
} from './db.ts'
import { jsonResponse } from './http-util.ts'
import { createIpcHub, type IpcHub } from './ipc.ts'
import type { WebhookIngressContext } from './webhooks.ts'
import { handleWebhookPost } from './webhooks.ts'

async function main(): Promise<void> {
  const config = loadConfig(process.argv[2])
  const dbPath = resolve(config.configPath, '..', config.gateway.dbPath)
  const db = openDatabase(dbPath)
  const ipcPath = resolveGatewayIpcSocketPath(config)

  const ttlSeconds = config.gateway.queueTtlSeconds ?? 86_400
  const ttlMs = ttlSeconds * 1000
  const replyHandleTtlMs =
    (config.gateway.replyHandleTtlSeconds ?? 604_800) * 1000

  const getCaps = () => getCapabilities(config)

  const discordBox: { runtime: DiscordRuntime | null } = { runtime: null }

  let hub: IpcHub
  const flushQueue = (): void => {
    const now = Date.now()
    for (const event of listPendingEvents(db, now)) {
      hub.broadcast({ type: 'event', event })
      dbDeleteQueuedEvent(db, event.id)
    }
  }

  hub = createIpcHub({
    config,
    socketPath: ipcPath,
    getCapabilities: getCaps,
    onClientReady: flushQueue,
    onDispatch: async d => {
      const v = validateOmniDispatch({
        replyHandle: d.replyHandle,
        action: d.action,
        args: d.args,
      })
      if (!v.ok) {
        return { ok: false, error: v.errors.join('; ') }
      }
      const row = getReplyHandleRow(db, v.value.replyHandle)
      if (!row) {
        return { ok: false, error: 'unknown or expired reply handle' }
      }
      let route: { kind?: string }
      try {
        route = JSON.parse(row.route_json) as { kind?: string }
      } catch {
        return { ok: false, error: 'invalid route data' }
      }
      if (route.kind === 'discord') {
        const client = discordBox.runtime?.client
        if (!client) {
          return { ok: false, error: 'discord client not running' }
        }
        try {
          const detail = await executeDiscordDispatch(
            client,
            route as DiscordRouteData,
            v.value.action,
            v.value.args,
          )
          return { ok: true, detail }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          return { ok: false, error: msg }
        }
      }
      return { ok: false, error: 'no egress for this route' }
    },
  })

  await hub.start()

  const discordSubs = Object.entries(config.channels)
    .filter(([, ch]) => ch.plugin === 'discord' && ch.discordChannelId)
    .map(([omniChannelId, ch]) => ({
      omniChannelId,
      discordChannelId: ch.discordChannelId!.trim(),
    }))

  const token = getDiscordBotToken(config)
  if (discordSubs.length > 0) {
    if (!token) {
      throw new Error(
        'Discord channels are configured but no bot token was found. Set DISCORD_BOT_TOKEN (or gateway.discordBotTokenEnv).',
      )
    }
    const store = createGatewayDiscordStore(db)
    const hubIngress = createGatewayDiscordHub(hub)
    discordBox.runtime = await startDiscordBot({
      subscriptions: discordSubs,
      store,
      hub: hubIngress,
      client: createDiscordClient(),
      token,
      replyHandleTtlMs,
    })
  }

  const gc = (): void => {
    const now = Date.now()
    const nq = gcExpired(db, now)
    const nr = gcExpiredReplyHandles(db, now)
    if (nq > 0 || nr > 0) {
      process.stderr.write(
        `omnichannel gateway: gc ingress=${nq} reply_handles=${nr}\n`,
      )
    }
  }
  setInterval(gc, 5 * 60 * 1000)

  const ingressCtx: WebhookIngressContext = {
    config,
    db,
    hub,
    ttlMs,
  }

  const server = Bun.serve({
    port: config.gateway.httpPort,
    fetch(req): Promise<Response> {
      if (req.method !== 'POST') {
        return Promise.resolve(jsonResponse({ error: 'method not allowed' }, 405))
      }
      return handleWebhookPost(req, ingressCtx)
    },
  })

  process.stderr.write(
    `omnichannel gateway: listening http://127.0.0.1:${server.port} ` +
      `ipc ${ipcPath} db=${dbPath}\n`,
  )
}

function createGatewayDiscordStore(db: Database) {
  return {
    insertReplyHandle(
      id: string,
      omniChannelId: string,
      routeJson: string,
      expiresAt: number,
    ): void {
      insertReplyHandle(db, id, omniChannelId, routeJson, expiresAt)
    },
    insertQueuedEvent(event: OmnichannelEvent, expiresAt: number): void {
      dbInsertQueuedEvent(db, event, expiresAt)
    },
    deleteQueuedEvent(id: string): void {
      dbDeleteQueuedEvent(db, id)
    },
  }
}

function createGatewayDiscordHub(hub: IpcHub) {
  return {
    get clientCount() {
      return hub.clientCount
    },
    broadcastEvent(event: OmnichannelEvent): void {
      hub.broadcast({ type: 'event', event })
    },
  }
}

main().catch(err => {
  process.stderr.write(`omnichannel gateway: ${String(err)}\n`)
  process.exit(1)
})
