import type { Socket } from 'node:net'
import { createServer } from 'node:net'
import { existsSync, unlinkSync } from 'node:fs'

import type { CapabilitySet, OmnichannelEvent } from '@omnibot/core'

import type { GatewayDebugLogger } from './debug-log.ts'

export type IpcInvokeInbound = {
  id: string
  channelId: string
  capability: string
  args: Record<string, unknown>
  replyHandle?: string
}

export type IpcInbound =
  | { type: 'hello'; token?: string; version?: number }
  | { type: 'get_context' }
  | { type: 'invoke'; id: string; channelId: string; capability: string; args: Record<string, unknown>; replyHandle?: string }

export type IpcOutbound =
  | { type: 'hello_ack' }
  | { type: 'error'; message: string }
  | { type: 'context'; channels: CapabilitySet[] }
  | { type: 'event'; event: OmnichannelEvent }
  | { type: 'invoke_result'; id: string; ok: boolean; data?: unknown; error?: string }

export type InvokeResult =
  | { ok: true; data?: unknown }
  | { ok: false; error: string }

export interface IpcHubOptions {
  socketPath: string
  sharedSecret?: string | null
  getCapabilities: () => CapabilitySet[]
  onClientReady?: () => void
  onInvoke?: (input: IpcInvokeInbound) => Promise<InvokeResult>
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
      this.options.debugLog?.log('ipc', 'invalid JSON line', { preview: line.slice(0, 200) })
      this.send(socket, { type: 'error', message: 'invalid JSON' })
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
      this.options.debugLog?.log('ipc', 'hello accepted', { clients: this.sockets.size })
      this.options.onClientReady?.()
      return
    }

    if (m.type === 'get_context') {
      if (!this.sockets.has(socket)) {
        this.send(socket, { type: 'error', message: 'send hello before get_context' })
        return
      }
      const caps = this.options.getCapabilities()
      this.options.debugLog?.log('ipc', 'get_context reply', { channelSets: caps.length })
      this.send(socket, { type: 'context', channels: caps })
      return
    }

    if (m.type === 'invoke') {
      if (!this.sockets.has(socket)) {
        this.send(socket, { type: 'error', message: 'send hello before invoke' })
        return
      }
      const { id, channelId, capability, args, replyHandle } = m
      if (
        typeof id !== 'string' ||
        typeof channelId !== 'string' ||
        typeof capability !== 'string' ||
        !args || typeof args !== 'object'
      ) {
        this.send(socket, { type: 'invoke_result', id: String(id ?? ''), ok: false, error: 'invalid invoke payload' })
        return
      }
      const onInvoke = this.options.onInvoke
      if (!onInvoke) {
        this.send(socket, { type: 'invoke_result', id, ok: false, error: 'invoke not enabled' })
        return
      }
      void onInvoke({ id, channelId, capability, args, replyHandle }).then(r => {
        this.options.debugLog?.log('ipc', 'invoke result', { id, ok: r.ok })
        if (r.ok) {
          this.send(socket, { type: 'invoke_result', id, ok: true, data: r.data })
        } else {
          this.send(socket, { type: 'invoke_result', id, ok: false, error: r.error })
        }
      }).catch((err: unknown) => {
        process.stderr.write(`omnichannel gateway: invoke error id=${id}: ${String(err)}\n`)
        this.send(socket, { type: 'invoke_result', id, ok: false, error: String(err) })
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
    return { type: m.type, version: m.version, token: m.token ? '(redacted)' : undefined }
  }
  if (m.type === 'invoke') {
    return { type: m.type, id: m.id, channelId: m.channelId, capability: m.capability, hasReplyHandle: !!m.replyHandle }
  }
  return { type: m.type }
}

export function createIpcHub(opts: {
  socketPath: string
  sharedSecret?: string | null
  getCapabilities: () => CapabilitySet[]
  onClientReady?: () => void
  onInvoke?: (input: IpcInvokeInbound) => Promise<InvokeResult>
  debugLog?: GatewayDebugLogger
}): IpcHub {
  return new IpcHub(opts)
}
