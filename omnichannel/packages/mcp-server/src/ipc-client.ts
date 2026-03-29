import { existsSync } from 'node:fs'
import { connect as netConnect, type Socket } from 'node:net'

import type { CapabilitySet, OmnichannelEvent } from '@omnichannel/core'

import type { IpcInbound, IpcOutbound } from './ipc-protocol.ts'

export interface IpcClientOptions {
  socketPath: string
  token?: string
  onEvent: (event: OmnichannelEvent) => void
}

export class OmniIpcClient {
  private socket: Socket | null = null
  private buffer = ''
  private readonly controlQueue: IpcOutbound[] = []
  private readonly controlWaiters: Array<(msg: IpcOutbound) => void> = []

  constructor(private readonly options: IpcClientOptions) {}

  async connect(): Promise<void> {
    const path = this.options.socketPath.trim()
    if (!path) {
      throw new Error('IPC socket path is empty (check OMNI_IPC_SOCKET / omni.yaml)')
    }
    if (!existsSync(path)) {
      throw new Error(
        `IPC socket not found: ${path}\n` +
          `  Start the Gateway first (bun run gateway) from the same cwd, or set OMNI_IPC_SOCKET.`,
      )
    }

    await new Promise<void>((resolve, reject) => {
      const s = netConnect({ path })
      this.socket = s
      s.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') {
          reject(
            new Error(
              `connect ENOENT ${path}\n` +
                `  Remove a stale socket if needed: rm ${path}\n` +
                `  Ensure gateway.ipcSocketPath matches this path.`,
            ),
          )
          return
        }
        reject(err)
      })
      s.on('data', chunk => this.appendChunk(chunk.toString('utf8')))
      s.on('connect', () => {
        const hello: IpcInbound = { type: 'hello', version: 1 }
        if (this.options.token) hello.token = this.options.token
        s.write(`${JSON.stringify(hello)}\n`)
      })
      void (async () => {
        try {
          const msg = await this.nextControl()
          if (msg.type === 'error') throw new Error(msg.message)
          if (msg.type !== 'hello_ack') {
            throw new Error(`expected hello_ack, got ${msg.type}`)
          }
          resolve()
        } catch (e) {
          reject(e)
        }
      })()
    })
  }

  async getContext(): Promise<CapabilitySet[]> {
    if (!this.socket) throw new Error('IPC not connected')
    const req: IpcInbound = { type: 'get_context' }
    this.socket.write(`${JSON.stringify(req)}\n`)
    while (true) {
      const msg = await this.nextControl()
      if (msg.type === 'context') return msg.channels
      if (msg.type === 'error') throw new Error(msg.message)
    }
  }

  async dispatch(payload: {
    replyHandle: string
    action: string
    args: Record<string, unknown>
  }): Promise<{ ok: boolean; detail?: string; error?: string }> {
    if (!this.socket) throw new Error('IPC not connected')
    const req: IpcInbound = {
      type: 'dispatch',
      replyHandle: payload.replyHandle,
      action: payload.action,
      args: payload.args,
    }
    this.socket.write(`${JSON.stringify(req)}\n`)
    while (true) {
      const msg = await this.nextControl()
      if (msg.type === 'dispatch_ack') {
        return {
          ok: msg.ok,
          detail: msg.detail,
          error: msg.error,
        }
      }
      if (msg.type === 'error') throw new Error(msg.message)
    }
  }

  close(): void {
    this.socket?.destroy()
    this.socket = null
  }

  private appendChunk(chunk: string): void {
    this.buffer += chunk
    const parts = this.buffer.split('\n')
    this.buffer = parts.pop() ?? ''
    for (const line of parts) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let msg: IpcOutbound
      try {
        msg = JSON.parse(trimmed) as IpcOutbound
      } catch {
        continue
      }
      if (msg.type === 'event') {
        this.options.onEvent(msg.event)
        continue
      }
      this.pushControl(msg)
    }
  }

  private pushControl(msg: IpcOutbound): void {
    const w = this.controlWaiters.shift()
    if (w) {
      w(msg)
      return
    }
    this.controlQueue.push(msg)
  }

  private nextControl(): Promise<IpcOutbound> {
    const q = this.controlQueue.shift()
    if (q) return Promise.resolve(q)
    return new Promise<IpcOutbound>(resolve => {
      this.controlWaiters.push(resolve)
    })
  }
}
