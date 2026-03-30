/** Mirrors gateway `ipc.ts` wire types (shared manually so `core` stays I/O-free). */

import type { CapabilitySet, OmnichannelEvent } from '@omnibot/core'

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
