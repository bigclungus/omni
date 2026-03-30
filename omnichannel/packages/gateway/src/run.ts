import type { Database } from 'bun:sqlite'
import { resolve } from 'node:path'

import type { CapabilitySet } from '@omnibot/core'

import {
  resolveGatewayIpcSocketPath,
  type LoadedGatewayConfig,
} from './config.ts'
import {
  deleteQueuedEvent as dbDeleteQueuedEvent,
  gcExpired,
  gcExpiredReplyHandles,
  listPendingEvents,
  openDatabase,
} from './db.ts'
import type { GatewayDebugLogger } from './debug-log.ts'
import { serveGatewayHttp } from './http-listener.ts'
import {
  createIpcHub,
  type CallResult,
  type DispatchResult,
  type IpcCallInbound,
  type IpcDispatchInbound,
  type IpcHub,
} from './ipc.ts'

export interface GatewayIo {
  db: Database
  hub: IpcHub
}

export interface StartGatewayOptions {
  config: LoadedGatewayConfig
  getCapabilities: () => CapabilitySet[]
  onDispatch: (input: IpcDispatchInbound, io: GatewayIo) => Promise<DispatchResult>
  onCall?: (input: IpcCallInbound, io: GatewayIo) => Promise<CallResult>
  fetch: (req: Request, io: GatewayIo) => Response | Promise<Response>
  /** Runs after IPC hub is listening, before HTTP bind. */
  afterHubReady?: (io: GatewayIo) => Promise<void>
  /** When enabled, logs paths, HTTP, IPC traffic, and periodic GC. */
  debugLog?: GatewayDebugLogger
}

/**
 * IPC hub, SQLite ingress queue, periodic GC, HTTP listener.
 * Callers supply capabilities, HTTP `fetch`, and dispatch handling.
 */
export async function startGateway(options: StartGatewayOptions): Promise<GatewayIo> {
  const { config } = options
  const dbg = options.debugLog
  const dbPath = resolve(config.configPath, '..', config.gateway.dbPath)
  dbg?.log('gateway', 'opening database', { dbPath })
  const db = openDatabase(dbPath)
  dbg?.log('gateway', 'database open')
  const ipcPath = resolveGatewayIpcSocketPath(config)
  dbg?.log('gateway', 'ipc socket path', { ipcPath })

  let hub: IpcHub
  const flushQueue = (): void => {
    const now = Date.now()
    const pending = listPendingEvents(db, now)
    dbg?.log('gateway', 'flushQueue (onClientReady)', {
      pending: pending.length,
    })
    for (const event of pending) {
      hub.broadcast({ type: 'event', event })
      dbDeleteQueuedEvent(db, event.id)
    }
  }

  hub = createIpcHub({
    socketPath: ipcPath,
    sharedSecret: config.gateway.sharedSecret,
    getCapabilities: options.getCapabilities,
    onClientReady: flushQueue,
    onDispatch: d => options.onDispatch(d, { db, hub }),
    onCall: options.onCall ? d => options.onCall!(d, { db, hub }) : undefined,
    debugLog: dbg,
  })

  dbg?.log('gateway', 'starting IPC server')
  await hub.start()
  dbg?.log('gateway', 'IPC server listening')

  const io: GatewayIo = { db, hub }
  dbg?.log('gateway', 'afterHubReady (channel plugins)')
  await options.afterHubReady?.(io)
  dbg?.log('gateway', 'afterHubReady done')

  const gc = (): void => {
    const now = Date.now()
    const nq = gcExpired(db, now)
    const nr = gcExpiredReplyHandles(db, now)
    if (dbg?.enabled) {
      dbg.log('gateway', 'gc', { ingress: nq, reply_handles: nr, at: now })
    } else if (nq > 0 || nr > 0) {
      process.stderr.write(
        `omnichannel gateway: gc ingress=${nq} reply_handles=${nr}\n`,
      )
    }
  }
  setInterval(gc, 5 * 60 * 1000)

  const httpHostname = config.gateway.httpHostname?.trim() || '127.0.0.1'
  dbg?.log('gateway', 'binding HTTP', {
    hostname: httpHostname,
    port: config.gateway.httpPort,
  })

  const server = serveGatewayHttp({
    hostname: httpHostname,
    port: config.gateway.httpPort,
    fetch: async req => {
      dbg?.log('http', 'request', {
        method: req.method,
        url: req.url,
      })
      const res = await options.fetch(req, io)
      dbg?.log('http', 'response', { status: res.status })
      return res
    },
  })

  process.stderr.write(
    `omnichannel gateway: listening http://${httpHostname}:${server.port} ` +
      `ipc ${ipcPath} db=${dbPath}\n`,
  )

  void server

  return io
}
