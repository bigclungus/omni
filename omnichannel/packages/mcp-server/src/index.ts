#!/usr/bin/env bun
/**
 * Omnichannel MCP adapter — stdio MCP with `omni_context` and `omni_dispatch`,
 * bridged to the Gateway over Unix domain sockets.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { validateOmniDispatch, type OmnichannelEvent } from '@omnibot/core'
import { z } from 'zod'

import { OmniIpcClient } from './ipc-client.ts'
import { resolveIpcSocketPath } from './resolve-socket-path.ts'

/** Claude Code channel extension — not in stock MCP SDK notification typings. */
const CHANNEL_NOTIFY_METHOD = 'notifications/claude/channel' as const

function eventToChannelParams(event: OmnichannelEvent): {
  content: string
  meta: Record<string, string>
} {
  const content =
    typeof event.payload === 'string'
      ? event.payload
      : JSON.stringify(event.payload, null, 2)
  return {
    content,
    meta: {
      event_id: event.id,
      channel_id: event.channelId,
      plugin: String(event.plugin),
      received_at: event.receivedAt,
    },
  }
}

const omniContextInput = z.object({})

const omniDispatchInput = z.object({
  replyHandle: z.string().max(64),
  action: z.enum(['reply', 'react', 'ack', 'resolve', 'noop']),
  args: z.record(z.unknown()),
})

const omniCallInput = z.object({
  channelId: z.string(),
  method: z.string(),
  args: z.record(z.unknown()).default({}),
})

async function main(): Promise<void> {
  const socketPath = resolveIpcSocketPath()
  const token = process.env.OMNI_IPC_TOKEN?.trim()

  const mcp = new McpServer(
    { name: 'omnichannel', version: '0.1.0' },
    {
      capabilities: {
        tools: {},
        experimental: {
          // https://code.claude.com/docs/en/channels-reference — registers channel listener
          'claude/channel': {},
        },
      },
      instructions:
        'Omnichannel events arrive as <channel source="omnichannel" event_id="..." channel_id="..." plugin="...">. ' +
        'They are two-way: use `omni_context` to see channels and valid actions; use `omni_dispatch` with the ' +
        '`reply_handle` from the event payload (when present) to reply or react on the originating platform.',
    },
  )

  const pendingChannelEvents: OmnichannelEvent[] = []
  let channelNotifyReady = false

  const pushChannelEvent = (event: OmnichannelEvent) => {
    const { content, meta } = eventToChannelParams(event)
    void mcp.server.notification({
      method: CHANNEL_NOTIFY_METHOD,
      params: { content, meta },
    } as Parameters<typeof mcp.server.notification>[0])
  }

  const ipc = new OmniIpcClient({
    socketPath,
    token,
    onEvent: event => {
      if (!channelNotifyReady) {
        pendingChannelEvents.push(event)
        return
      }
      pushChannelEvent(event)
    },
  })

  process.stderr.write(`omnichannel mcp: IPC socket ${socketPath}\n`)

  await ipc.connect()

  // McpServer's Zod generics explode TS inference; runtime still requires real Zod schemas.
  const registerTool = mcp.registerTool.bind(mcp) as (
    name: string,
    config: {
      title?: string
      description?: string
      inputSchema: z.ZodType<unknown>
    },
    handler: (args: unknown) => Promise<{
      content: Array<{ type: string; text: string }>
      isError?: boolean
    }>,
  ) => void

  registerTool(
    'omni_context',
    {
      title: 'Omnichannel context',
      description:
        'Read-only view of configured channels and capabilities (ingress/egress, allowed actions).',
      inputSchema: omniContextInput,
    },
    async () => {
      const channels = await ipc.getContext()
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ channels }, null, 2),
          },
        ],
      }
    },
  )

  registerTool(
    'omni_dispatch',
    {
      title: 'Omnichannel dispatch',
      description:
        'Single outbound verb: reply, react, ack, resolve, or noop. Core validates payload; platform egress is phased by channel type.',
      inputSchema: omniDispatchInput,
    },
    async (args: unknown) => {
      const v = validateOmniDispatch(args)
      if (!v.ok) {
        return {
          content: [
            {
              type: 'text',
              text: `Validation failed:\n${v.errors.join('\n')}`,
            },
          ],
          isError: true,
        }
      }
      const r = await ipc.dispatch({
        replyHandle: v.value.replyHandle,
        action: v.value.action,
        args: v.value.args,
      })
      if (!r.ok) {
        return {
          content: [
            {
              type: 'text',
              text: r.error ?? 'dispatch failed',
            },
          ],
          isError: true,
        }
      }
      return {
        content: [
          {
            type: 'text',
            text: r.detail ?? 'ok',
          },
        ],
      }
    },
  )

  registerTool(
    'omni_call',
    {
      title: 'Omnichannel channel call',
      description:
        'Invoke a channel-specific capability by name. Available methods depend on the channel plugin ' +
        '(e.g. discord: fetch_history, download_attachment). Returns JSON data on success.',
      inputSchema: omniCallInput,
    },
    async (args: unknown) => {
      const v = omniCallInput.safeParse(args)
      if (!v.success) {
        return {
          content: [{ type: 'text', text: `Validation failed:\n${v.error.message}` }],
          isError: true,
        }
      }
      const r = await ipc.call({
        channelId: v.data.channelId,
        method: v.data.method,
        args: v.data.args,
      })
      if (!r.ok) {
        return {
          content: [{ type: 'text', text: r.error ?? 'call failed' }],
          isError: true,
        }
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(r.data, null, 2) }],
      }
    },
  )

  const transport = new StdioServerTransport()
  await mcp.connect(transport)
  channelNotifyReady = true
  for (const e of pendingChannelEvents) pushChannelEvent(e)
  pendingChannelEvents.length = 0

  process.stderr.write(`omnichannel mcp: IPC ready (stdio MCP + claude/channel)\n`)
}

main().catch(err => {
  process.stderr.write(`omnichannel mcp: ${String(err)}\n`)
  process.exit(1)
})
