import { describe, expect, mock, test } from 'bun:test'

import { handleO2oPost } from './o2o-ingress.ts'

describe('handleO2oPost', () => {
  test('returns null for non-o2o paths', async () => {
    const req = new Request('http://localhost/webhooks/x', { method: 'POST' })
    const r = await handleO2oPost(req, {
      ttlMs: 60_000,
      resolveChannel: () => null,
      hooks: {
        insertQueuedEvent: mock(() => {}),
        deleteQueuedEvent: mock(() => {}),
        getIpcClientCount: () => 0,
        broadcastEvent: mock(() => {}),
      },
    })
    expect(r).toBeNull()
  })

  test('401 without bearer', async () => {
    const req = new Request('http://localhost/o2o/inbox', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    })
    const insertQueuedEvent = mock(() => {})
    const r = await handleO2oPost(req, {
      ttlMs: 60_000,
      resolveChannel: id =>
        id === 'inbox' ?
          { plugin: 'channel-o2o', ingressSecret: 'secret' }
        : null,
      hooks: {
        insertQueuedEvent,
        deleteQueuedEvent: mock(() => {}),
        getIpcClientCount: () => 0,
        broadcastEvent: mock(() => {}),
      },
    })
    expect(r).not.toBeNull()
    expect(r!.status).toBe(401)
    expect(insertQueuedEvent).not.toHaveBeenCalled()
  })

  test('enqueues and broadcasts when authorized and MCP connected', async () => {
    const insertQueuedEvent = mock(() => {})
    const deleteQueuedEvent = mock(() => {})
    const broadcastEvent = mock(() => {})
    const req = new Request('http://localhost/o2o/inbox', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer secret',
      },
      body: JSON.stringify({ hello: 'world' }),
    })
    const r = await handleO2oPost(req, {
      ttlMs: 60_000,
      resolveChannel: id =>
        id === 'inbox' ?
          { plugin: 'channel-o2o', ingressSecret: 'secret' }
        : null,
      hooks: {
        insertQueuedEvent,
        deleteQueuedEvent,
        getIpcClientCount: () => 1,
        broadcastEvent,
      },
    })
    expect(r).not.toBeNull()
    expect(r!.status).toBe(200)
    expect(insertQueuedEvent).toHaveBeenCalled()
    expect(broadcastEvent).toHaveBeenCalled()
    expect(deleteQueuedEvent).toHaveBeenCalled()
  })
})
