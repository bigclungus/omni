import { describe, expect, test } from 'bun:test'

import { buildRequestBody, parsePayload, resolvePeerUrl } from './o2o-send.ts'

describe('parsePayload', () => {
  test('accepts object', () => {
    const r = parsePayload({ payload: { a: 1 } })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual({ a: 1 })
  })

  test('accepts JSON string object', () => {
    const r = parsePayload({ payload: '{"x":true}' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual({ x: true })
  })

  test('rejects array JSON', () => {
    const r = parsePayload({ payload: '[1,2]' })
    expect(r.ok).toBe(false)
  })

  test('rejects missing payload', () => {
    const r = parsePayload({})
    expect(r.ok).toBe(false)
  })
})

describe('buildRequestBody', () => {
  test('merges taskId', () => {
    expect(buildRequestBody({ a: 1 }, 't-1')).toEqual({ a: 1, taskId: 't-1' })
  })

  test('payload only when no taskId', () => {
    expect(buildRequestBody({ a: 1 }, undefined)).toEqual({ a: 1 })
  })
})

describe('resolvePeerUrl', () => {
  test('appends path suffix', () => {
    expect(resolvePeerUrl('http://127.0.0.1:8080/o2o/in', 'extra')).toBe(
      'http://127.0.0.1:8080/o2o/in/extra',
    )
  })

  test('no suffix unchanged', () => {
    expect(resolvePeerUrl('http://127.0.0.1:8080/x', undefined)).toBe(
      'http://127.0.0.1:8080/x',
    )
  })
})
