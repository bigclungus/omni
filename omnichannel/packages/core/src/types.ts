/**
 * Pure domain types — no I/O, MCP, or transport imports.
 */

/** Use the workspace package name (no scope), e.g. `channel-webhook`, `channel-discord`. */
export type OmnichannelPluginId = 'channel-webhook' | 'channel-discord' | string

/** Normalized event the Gateway enqueues and the MCP host receives. */
export interface OmnichannelEvent {
  /** Stable id for dedup / tracing (queue row id). */
  id: string
  channelId: string
  plugin: OmnichannelPluginId
  /** ISO 8601 timestamp when the Gateway accepted the event. */
  receivedAt: string
  /** Normalized payload (e.g. webhook JSON body + selected headers). */
  payload: unknown
}

/** Describes what a channel can do; used by `omni_context` and schema selection. */
export interface CapabilitySet {
  channelId: string
  plugin: OmnichannelPluginId
  ingress: boolean
  /** When false, outbound tools should reject or no-op for this channel. */
  egress: boolean
  /** Actions valid for `omni_dispatch` for this channel (phase 1 may be empty). */
  actions: OmniDispatchAction[]
  /** Methods available via `omni_call` for this channel. */
  calls?: string[]
}

export type OmniDispatchAction = 'reply' | 'react' | 'ack' | 'resolve' | 'noop'

/** Arguments validated per `action` via JSON Schema `oneOf` in core. */
export type OmniDispatchArgs =
  | { action: 'reply'; text: string }
  | { action: 'react'; emoji: string }
  | { action: 'ack' }
  | { action: 'resolve' }
  | { action: 'noop' }

export interface OmniDispatchPayload {
  replyHandle: string
  action: OmniDispatchAction
  args: Record<string, unknown>
}

export interface OmniDispatchValidationError {
  ok: false
  errors: string[]
}

export interface OmniDispatchValidationOk {
  ok: true
  value: OmniDispatchPayload
}

export type OmniDispatchValidationResult =
  | OmniDispatchValidationOk
  | OmniDispatchValidationError
