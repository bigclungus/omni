import type { Socket } from 'node:net'
import { createServer } from 'node:net'
import { existsSync, unlinkSync } from 'node:fs'

import type { CapabilitySet, OmnichannelEvent } from '@omnibot/core'

import type { GatewayDebugLogger } from './debug-log.ts'

export type IpcDispatchInbound = {
  replyHandle: string
  action: string
  args: Record<string, unknown>
}

export type IpcCallInbound = {
  id: string
  channelId: string
  method: string
  args: Record<string, unknown>
}

export type IpcInbound =
  | { type: 'hello'; token?: string; version?: number }
  | { type: 'get_context' }
  | { type: 'dispatch'; replyHandle: string; action: string; args: Record<string, unknown> }
  | { type: 'call'; id: string; channelId: string; method: string; args: Record<string, unknown> }

export type IpcOutbound =
  | { type: 'hello_ack' }
  | { type: 'error'; message: string }
  | { type: 'context'; channels: CapabilitySet[] }
  | { type: 'event'; event: OmnichannelEvent }
  | { type: 'dispatch_ack'; ok: boolean; detail?: string; error?: string }
  | { type: 'call_result'; id: string; ok: boolean; data?: unknown; error?: string }

export type DispatchResult =
  | { ok: true; detail?: string }
  | { ok: false; error: string }

export type CallResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string }

export interface IpcHubOptions {
  socketPath: string
  sharedSecret?: string | null
  getCapabilities: () => CapabilitySet[]
  onClientReady?: () => void
  onDispatch?: (input: IpcDispatchInbound) => Promise<DispatchResult>
  onCall?: (input: IpcCallInbound) => Promise<CallResult>
  debugLog?: GatewayDebugLogger
}

export class IpcHub {
  private readonly sockets = new Set<Socket>()
  private readonly buffers = new WeakMap<Socket, string>()
  private server: ReturnType<typeof createServer> | null = null

  constructor(private readonly options: IpcHubOptions) {}

  get clientCount(): number {
    return this.sockets.size
  }

  start(): Promise<void> {
    const { socketPath } = this.options
    if (existsSync(socketPath)) {
      try {
        unlinkSync(socketPath)
      } catch {
        // ignore
      }
    }

    return new Promise((resolve, reject) => {
      const server = createServer(socket => this.attachSocket(socket))
      server.on('error', reject)
      server.listen(socketPath, () => {
        this.server = server
        resolve()
      })
    })
  }

  stop(): Promise<void> {
    return new Promise(resolve => {
      for (const s of this.sockets) {
        s.destroy()
      }
      this.sockets.clear()
      if (this.server) {
        this.server.close(() => resolve())
        this.server = null
      } else {
        resolve()
      }
    })
  }

  broadcast(msg: IpcOutbound): void {
    const log = this.options.debugLog
    if (log?.enabled && msg.type === 'event') {
      log.log('ipc', 'broadcast event', {
        id: msg.event.id,
        channelId: msg.event.channelId,
        plugin: msg.event.plugin,
        clients: this.sockets.size,
      })
    } else if (log?.enabled) {
      log.log('ipc', 'broadcast', msg)
    }
    const line = `${JSON.stringify(msg)}\n`
    const dead: Socket[] = []
    for (const s of this.sockets) {
      try {
        s.write(line)
      } catch {
        dead.push(s)
      }
    }
    for (const s of dead) {
      this.sockets.delete(s)
    }
  }

  private attachSocket(socket: Socket): void {
    this.options.debugLog?.log('ipc', 'socket attached')
    this.buffers.set(socket, '')
    socket.on('data', chunk => {
      const prev = this.buffers.get(socket) ?? ''
      const combined = prev + chunk.toString('utf8')
      const lines = combined.split('\n')
      const rest = lines.pop() ?? ''
      this.buffers.set(socket, rest)
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        this.handleLine(socket, trimmed)
      }
    })
    socket.on('close', () => {
      this.sockets.delete(socket)
    })
    socket.on('error', () => {
      this.sockets.delete(socket)
    })
  }

  private handleLine(socket: Socket, line: string): void {
    let msg: unknown
    try {
      msg = JSON.parse(line) as IpcInbound
    } catch {
      this.options.debugLog?.log('ipc', 'invalid JSON line', {
        preview: line.slice(0, 200),
      })
      this.send(socket, {
        type: 'error',
        message: 'invalid JSON',
      })
      return
    }

    if (!msg || typeof msg !== 'object' || !('type' in msg)) {
      this.options.debugLog?.log('ipc', 'message missing type', { msg })
      this.send(socket, { type: 'error', message: 'missing type' })
      return
    }

    const m = msg as IpcInbound
    this.options.debugLog?.log('ipc', `inbound type=${m.type}`, loggableInbound(m))

    if (m.type === 'hello') {
      const secret = this.options.sharedSecret
      if (secret && m.token !== secret) {
        this.send(socket, { type: 'error', message: 'unauthorized' })
        socket.end()
        return
      }
      this.sockets.add(socket)
      this.send(socket, { type: 'hello_ack' })
      this.options.debugLog?.log('ipc', 'hello accepted', {
        clients: this.sockets.size,
      })
      this.options.onClientReady?.()
      return
    }

    if (m.type === 'get_context') {
      if (!this.sockets.has(socket)) {
        this.send(socket, {
          type: 'error',
          message: 'send hello before get_context',
        })
        return
      }
      const caps = this.options.getCapabilities()
      this.options.debugLog?.log('ipc', 'get_context reply', {
        channelSets: caps.length,
      })
      this.send(socket, {
        type: 'context',
        channels: caps,
      })
      return
    }

    if (m.type === 'dispatch') {
      if (!this.sockets.has(socket)) {
        this.send(socket, {
          type: 'error',
          message: 'send hello before dispatch',
        })
        return
      }
      const replyHandle = m.replyHandle
      const action = m.action
      const args = m.args
      if (
        typeof replyHandle !== 'string' ||
        typeof action !== 'string' ||
        !args ||
        typeof args !== 'object'
      ) {
        this.send(socket, {
          type: 'dispatch_ack',
          ok: false,
          error: 'invalid dispatch payload',
        })
        return
      }
      const onDispatch = this.options.onDispatch
      if (!onDispatch) {
        this.send(socket, {
          type: 'dispatch_ack',
          ok: false,
          error: 'dispatch not enabled',
        })
        return
      }
      void onDispatch({ replyHandle, action, args }).then(r => {
        this.options.debugLog?.log('ipc', 'dispatch result', r)
        if (r.ok) {
          this.send(socket, { type: 'dispatch_ack', ok: true, detail: r.detail })
        } else {
          this.send(socket, { type: 'dispatch_ack', ok: false, error: r.error })
        }
      })
      return
    }

    if (m.type === 'call') {
      if (!this.sockets.has(socket)) {
        this.send(socket, { type: 'error', message: 'send hello before call' })
        return
      }
      const { id, channelId, method, args } = m
      if (
        typeof id !== 'string' ||
        typeof channelId !== 'string' ||
        typeof method !== 'string' ||
        !args || typeof args !== 'object'
      ) {
        this.send(socket, { type: 'call_result', id: String(id ?? ''), ok: false, error: 'invalid call payload' })
        return
      }
      const onCall = this.options.onCall
      if (!onCall) {
        this.send(socket, { type: 'call_result', id, ok: false, error: 'call not enabled' })
        return
      }
      void onCall({ id, channelId, method, args }).then(r => {
        this.options.debugLog?.log('ipc', 'call result', { id, ok: r.ok })
        if (r.ok) {
          this.send(socket, { type: 'call_result', id, ok: true, data: r.data })
        } else {
          this.send(socket, { type: 'call_result', id, ok: false, error: r.error })
        }
      })
      return
    }

    this.options.debugLog?.log('ipc', 'unknown message type', {
      type: (m as { type: string }).type,
    })
    this.send(socket, {
      type: 'error',
      message: `unknown type: ${String((m as { type: string }).type)}`,
    })
  }

  private send(socket: Socket, msg: IpcOutbound): void {
    const log = this.options.debugLog
    if (log?.enabled) {
      if (msg.type === 'event') {
        log.log('ipc', 'outbound type=event', {
          id: msg.event.id,
          channelId: msg.event.channelId,
          plugin: msg.event.plugin,
        })
      } else {
        log.log('ipc', `outbound type=${msg.type}`, msg)
      }
    }
    socket.write(`${JSON.stringify(msg)}\n`)
  }
}

function loggableInbound(m: IpcInbound): Record<string, unknown> {
  if (m.type === 'hello') {
    return {
      type: m.type,
      version: m.version,
      token: m.token ? '(redacted)' : undefined,
    }
  }
  if (m.type === 'dispatch') {
    return { type: m.type, replyHandle: m.replyHandle, action: m.action, args: m.args }
  }
  return { type: m.type }
}

export function createIpcHub(opts: {
  socketPath: string
  sharedSecret?: string | null
  getCapabilities: () => CapabilitySet[]
  onClientReady?: () => void
  onDispatch?: (input: IpcDispatchInbound) => Promise<DispatchResult>
  onCall?: (input: IpcCallInbound) => Promise<CallResult>
  debugLog?: GatewayDebugLogger
}): IpcHub {
  return new IpcHub({
    socketPath: opts.socketPath,
    sharedSecret: opts.sharedSecret,
    getCapabilities: opts.getCapabilities,
    onClientReady: opts.onClientReady,
    onDispatch: opts.onDispatch,
    onCall: opts.onCall,
    debugLog: opts.debugLog,
  })
}
