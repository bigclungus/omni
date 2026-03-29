import type { Socket } from 'node:net'
import { createServer } from 'node:net'
import { existsSync, unlinkSync } from 'node:fs'

import type { CapabilitySet, OmnichannelEvent } from '@omnichannel/core'

import type { LoadedConfig } from './config.ts'

export type IpcDispatchInbound = {
  replyHandle: string
  action: string
  args: Record<string, unknown>
}

export type IpcInbound =
  | { type: 'hello'; token?: string; version?: number }
  | { type: 'get_context' }
  | { type: 'dispatch'; replyHandle: string; action: string; args: Record<string, unknown> }

export type IpcOutbound =
  | { type: 'hello_ack' }
  | { type: 'error'; message: string }
  | { type: 'context'; channels: CapabilitySet[] }
  | { type: 'event'; event: OmnichannelEvent }
  | { type: 'dispatch_ack'; ok: boolean; detail?: string; error?: string }

export type DispatchResult =
  | { ok: true; detail?: string }
  | { ok: false; error: string }

export interface IpcHubOptions {
  socketPath: string
  sharedSecret?: string | null
  getCapabilities: () => CapabilitySet[]
  onClientReady?: () => void
  onDispatch?: (input: IpcDispatchInbound) => Promise<DispatchResult>
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
      this.send(socket, {
        type: 'error',
        message: 'invalid JSON',
      })
      return
    }

    if (!msg || typeof msg !== 'object' || !('type' in msg)) {
      this.send(socket, { type: 'error', message: 'missing type' })
      return
    }

    const m = msg as IpcInbound
    if (m.type === 'hello') {
      const secret = this.options.sharedSecret
      if (secret && m.token !== secret) {
        this.send(socket, { type: 'error', message: 'unauthorized' })
        socket.end()
        return
      }
      this.sockets.add(socket)
      this.send(socket, { type: 'hello_ack' })
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
      this.send(socket, {
        type: 'context',
        channels: this.options.getCapabilities(),
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
        if (r.ok) {
          this.send(socket, { type: 'dispatch_ack', ok: true, detail: r.detail })
        } else {
          this.send(socket, { type: 'dispatch_ack', ok: false, error: r.error })
        }
      })
      return
    }

    this.send(socket, {
      type: 'error',
      message: `unknown type: ${String((m as { type: string }).type)}`,
    })
  }

  private send(socket: Socket, msg: IpcOutbound): void {
    socket.write(`${JSON.stringify(msg)}\n`)
  }
}

export function createIpcHub(opts: {
  config: LoadedConfig
  socketPath: string
  getCapabilities: () => CapabilitySet[]
  onClientReady?: () => void
  onDispatch?: (input: IpcDispatchInbound) => Promise<DispatchResult>
}): IpcHub {
  return new IpcHub({
    socketPath: opts.socketPath,
    sharedSecret: opts.config.gateway.sharedSecret,
    getCapabilities: opts.getCapabilities,
    onClientReady: opts.onClientReady,
    onDispatch: opts.onDispatch,
  })
}
