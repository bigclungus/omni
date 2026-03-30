import { connect as netConnect, type Socket } from 'node:net'

import type { CapabilitySet, OmnichannelEvent } from '@omnibot/core'

import type { IpcInbound, IpcOutbound } from './ipc-protocol.ts'

export interface IpcClientOptions {
  socketPath: string
  token?: string
  onEvent: (event: OmnichannelEvent) => void
  /** Initial backoff when the socket is missing or the gateway is down (default 1000). */
  reconnectInitialDelayMs?: number
  /** Max backoff between reconnect attempts (default 30000). */
  reconnectMaxDelayMs?: number
}

export class OmniIpcClient {
  private socket: Socket | null = null
  private buffer = ''
  private readonly controlQueue: IpcOutbound[] = []
  private readonly controlWaiters: Array<{
    resolve: (msg: IpcOutbound) => void
    reject: (e: Error) => void
  }> = []
  private readonly pendingCalls = new Map<string, {
    resolve: (msg: Extract<IpcOutbound, { type: 'call_result' }>) => void
    reject: (e: Error) => void
  }>()

  private readonly connectionResolvers: Array<() => void> = []

  private stopped = false
  private loopStarted = false
  private firstConnectResolve: (() => void) | null = null
  private firstConnectReject: ((e: Error) => void) | null = null
  private firstConnectPromise: Promise<void> | null = null

  constructor(private readonly options: IpcClientOptions) {}

  /**
   * Waits until the first successful `hello` handshake, then returns.
   * Keeps reconnecting in the background after gateway restarts or disconnects.
   */
  async connect(): Promise<void> {
    if (!this.loopStarted) {
      this.loopStarted = true
      this.firstConnectPromise = new Promise<void>((resolve, reject) => {
        this.firstConnectResolve = resolve
        this.firstConnectReject = reject
      })
      void this.runConnectionLoop().catch(e => {
        this.firstConnectReject?.(
          e instanceof Error ? e : new Error(String(e)),
        )
      })
    }
    await this.firstConnectPromise
  }

  /** Stops reconnection and closes the socket. */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.rejectAllControlWaiters(new Error('IPC client stopped'))
    try {
      this.socket?.destroy()
    } catch {
      // ignore
    }
    this.socket = null
    this.buffer = ''
    this.firstConnectReject?.(new Error('IPC client stopped'))
    this.firstConnectReject = null
    this.firstConnectResolve = null
    this.firstConnectPromise = null
  }

  /** @deprecated Use {@link stop} */
  close(): void {
    this.stop()
  }

  async getContext(): Promise<CapabilitySet[]> {
    await this.waitUntilConnected()
    const s = this.socket
    if (!s) throw new Error('IPC not connected')
    const req: IpcInbound = { type: 'get_context' }
    s.write(`${JSON.stringify(req)}\n`)
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
    await this.waitUntilConnected()
    const s = this.socket
    if (!s) throw new Error('IPC not connected')
    const req: IpcInbound = {
      type: 'dispatch',
      replyHandle: payload.replyHandle,
      action: payload.action,
      args: payload.args,
    }
    s.write(`${JSON.stringify(req)}\n`)
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

  async call(payload: {
    channelId: string
    method: string
    args: Record<string, unknown>
  }): Promise<{ ok: boolean; data?: unknown; error?: string }> {
    await this.waitUntilConnected()
    const s = this.socket
    if (!s) throw new Error('IPC not connected')
    const id = crypto.randomUUID()
    const req: IpcInbound = {
      type: 'call',
      id,
      channelId: payload.channelId,
      method: payload.method,
      args: payload.args,
    }
    s.write(`${JSON.stringify(req)}\n`)
    return new Promise((resolve, reject) => {
      this.pendingCalls.set(id, {
        resolve: msg => resolve({ ok: msg.ok, data: msg.data, error: msg.error }),
        reject,
      })
    })
  }

  private async runConnectionLoop(): Promise<void> {
    let initial =
      this.options.reconnectInitialDelayMs ?? 1000
    const maxBackoff = this.options.reconnectMaxDelayMs ?? 30_000
    let backoff = initial
    let firstResolved = false

    while (!this.stopped) {
      try {
        await this.attemptConnection()
        backoff = initial
        if (!firstResolved) {
          firstResolved = true
          this.firstConnectResolve?.()
          this.firstConnectReject = null
        }
        await this.waitForSocketEnd()
      } catch {
        if (this.stopped) return
      }
      if (this.stopped) return
      await sleep(backoff + Math.random() * 250)
      backoff = Math.min(maxBackoff, backoff * 1.5)
    }
  }

  private async attemptConnection(): Promise<void> {
    const path = this.options.socketPath.trim()
    if (!path) {
      throw new Error('IPC socket path is empty (check OMNI_IPC_SOCKET / omni.yaml)')
    }

    await new Promise<void>((resolve, reject) => {
      const s = netConnect({ path })
      let handshakeDone = false

      const fail = (e: Error) => {
        if (handshakeDone) return
        handshakeDone = true
        this.rejectAllControlWaiters(e)
        try {
          s.destroy()
        } catch {
          // ignore
        }
        reject(e)
      }

      s.on('data', chunk => this.appendChunk(chunk.toString('utf8')))

      const onEarlyError = (err: Error) => {
        fail(err)
      }
      s.on('error', onEarlyError)

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
          handshakeDone = true
          s.removeListener('error', onEarlyError)
          const onEnd = () => {
            this.onSocketClosed(s)
          }
          s.on('close', onEnd)
          s.on('error', onEnd)
          this.socket = s
          this.notifyConnectionWaiters()
          resolve()
        } catch (e) {
          fail(e instanceof Error ? e : new Error(String(e)))
        }
      })()
    })
  }

  private onSocketClosed(s: Socket): void {
    if (this.socket !== s) return
    this.handleDisconnect()
  }

  private handleDisconnect(): void {
    this.rejectAllControlWaiters(new Error('IPC disconnected'))
    this.buffer = ''
    this.socket = null
    this.notifyConnectionWaiters()
  }

  private async waitForSocketEnd(): Promise<void> {
    const s = this.socket
    if (!s) return
    await new Promise<void>(resolve => {
      s.once('close', resolve)
      s.once('error', resolve)
    })
  }

  private rejectAllControlWaiters(reason: Error): void {
    const w = this.controlWaiters.splice(0)
    for (const { reject } of w) {
      reject(reason)
    }
    for (const { reject } of this.pendingCalls.values()) {
      reject(reason)
    }
    this.pendingCalls.clear()
  }

  private notifyConnectionWaiters(): void {
    const r = this.connectionResolvers.splice(0)
    for (const fn of r) {
      fn()
    }
  }

  private async waitUntilConnected(): Promise<void> {
    if (this.stopped) throw new Error('IPC client stopped')
    while (!this.socket && !this.stopped) {
      await new Promise<void>(resolve => {
        this.connectionResolvers.push(resolve)
      })
    }
    if (this.stopped || !this.socket) throw new Error('IPC not connected')
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
      if (msg.type === 'call_result') {
        const pending = this.pendingCalls.get(msg.id)
        if (pending) {
          this.pendingCalls.delete(msg.id)
          pending.resolve(msg)
        }
        continue
      }
      this.pushControl(msg)
    }
  }

  private pushControl(msg: IpcOutbound): void {
    const w = this.controlWaiters.shift()
    if (w) {
      w.resolve(msg)
      return
    }
    this.controlQueue.push(msg)
  }

  private nextControl(): Promise<IpcOutbound> {
    const q = this.controlQueue.shift()
    if (q) return Promise.resolve(q)
    return new Promise<IpcOutbound>((resolve, reject) => {
      this.controlWaiters.push({ resolve, reject })
    })
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
