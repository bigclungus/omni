#!/usr/bin/env bun
/**
 * CLI entry: loads `@omnibot/<plugin>` for each channel `plugin` id from `omni.yaml` (dynamic import).
 *
 * Flags: `--debug` / `-d` — verbose stderr logging (HTTP, IPC, dispatch, GC).
 * Config path is the first non-flag argument, or `OMNI_CONFIG` / default `omni.yaml`.
 */

import { validateOmniDispatch } from '@omnibot/core'

import { getCapabilitySetsForChannels } from './channel-capabilities.ts'
import {
  createGatewayDebugLogger,
  summarizeConfigForDebug,
  type GatewayDebugLogger,
} from './debug-log.ts'
import {
  getReplyHandleRow,
  jsonResponse,
  loadGatewayConfig,
  startGateway,
  type CreateGatewayPluginHost,
  type GatewayIo,
  type GatewayPluginHost,
  type GatewayPluginHostContext,
  type GatewayPluginHttpContext,
} from './index.ts'

/** Must match workspace package names under `@omnibot/`. */
const CHANNEL_PLUGIN_ID_RE = /^channel-[a-z0-9-]+$/

function parseGatewayCliArgs(argv: string[]): { configPath?: string; debug: boolean } {
  let debug = false
  const positionals: string[] = []
  for (const a of argv) {
    if (a === '--debug' || a === '-d') {
      debug = true
      continue
    }
    if (a.startsWith('-')) {
      throw new Error(`Unknown flag: ${a} (try --debug)`)
    }
    positionals.push(a)
  }
  return { configPath: positionals[0], debug }
}

function uniqueChannelPluginIds(
  channels: Record<string, { plugin: string }>,
): string[] {
  return [...new Set(Object.values(channels).map(c => c.plugin))]
}

function assertValidChannelPluginId(id: string): void {
  if (!CHANNEL_PLUGIN_ID_RE.test(id)) {
    throw new Error(
      `Invalid channel plugin "${id}". Use the package name without scope (e.g. channel-webhook, channel-discord).`,
    )
  }
}

async function importChannelModules(
  pluginIds: string[],
  log: GatewayDebugLogger,
): Promise<Map<string, Record<string, unknown>>> {
  const map = new Map<string, Record<string, unknown>>()
  await Promise.all(
    pluginIds.map(async id => {
      assertValidChannelPluginId(id)
      const specifier = `@omnibot/${id}`
      log.log('plugin', `import ${specifier}`)
      try {
        const mod = (await import(specifier)) as Record<string, unknown>
        map.set(id, mod)
        log.log('plugin', `loaded ${specifier}`, {
          exports: Object.keys(mod).sort(),
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        throw new Error(`Failed to load channel package ${specifier}: ${msg}`)
      }
    }),
  )
  return map
}

async function main(): Promise<void> {
  const { configPath, debug } = parseGatewayCliArgs(process.argv.slice(2))
  const debugLog = createGatewayDebugLogger(debug)

  debugLog.log('cli', 'argv', process.argv)
  debugLog.log('cli', 'parsed', { configPath: configPath ?? '(default)', debug })

  const cfg = loadGatewayConfig(configPath)
  debugLog.log('cli', 'loaded config', summarizeConfigForDebug(cfg))

  const pluginIds = uniqueChannelPluginIds(cfg.channels)
  debugLog.log('cli', 'channel plugin ids (unique)', pluginIds)

  const channelMods = await importChannelModules(pluginIds, debugLog)

  const ttlSeconds = cfg.gateway.queueTtlSeconds ?? 86_400
  const ttlMs = ttlSeconds * 1000
  const replyHandleTtlMs =
    (cfg.gateway.replyHandleTtlSeconds ?? 604_800) * 1000

  const ctx: GatewayPluginHostContext = {
    channels: cfg.channels,
    document: cfg.document,
    replyHandleTtlMs,
    debugLog,
  }

  const plugins: GatewayPluginHost[] = []
  const pluginLabels: string[] = []
  for (const id of [...pluginIds].sort()) {
    const mod = channelMods.get(id)
    if (!mod) continue
    const factory = mod.createGatewayPluginHost as CreateGatewayPluginHost | undefined
    if (typeof factory === 'function') {
      debugLog.log('cli', `createGatewayPluginHost(${id})`)
      plugins.push(factory(mod, ctx))
      pluginLabels.push(id)
    } else {
      debugLog.log('cli', `skip ${id} (no createGatewayPluginHost)`)
    }
  }

  debugLog.log('cli', 'prepare()', { plugins: pluginLabels })
  plugins.forEach(p => p.prepare())

  const httpCtx: GatewayPluginHttpContext = { ttlMs, config: cfg }

  await startGateway({
    config: cfg,
    debugLog,
    getCapabilities: () => {
      const callsByPluginId = new Map<string, string[]>()
      for (let i = 0; i < plugins.length; i++) {
        const p = plugins[i]
        const label = pluginLabels[i]
        if (p?.calls?.length && label) callsByPluginId.set(label, p.calls)
      }
      const caps = getCapabilitySetsForChannels(cfg.channels, callsByPluginId)
      debugLog.log('cli', 'getCapabilities()', caps)
      return caps
    },
    onDispatch: async (d, { db }) => {
      debugLog.log('dispatch', 'inbound', d)
      const v = validateOmniDispatch({
        replyHandle: d.replyHandle,
        action: d.action,
        args: d.args,
      })
      if (!v.ok) {
        debugLog.log('dispatch', 'validation failed', v.errors)
        return { ok: false, error: v.errors.join('; ') }
      }
      const row = getReplyHandleRow(db, v.value.replyHandle)
      if (!row) {
        debugLog.log('dispatch', 'no reply_handle row', {
          replyHandle: v.value.replyHandle,
        })
        return { ok: false, error: 'unknown or expired reply handle' }
      }
      let route: { kind?: string }
      try {
        route = JSON.parse(row.route_json) as { kind?: string }
      } catch {
        debugLog.log('dispatch', 'invalid route_json', { raw: row.route_json })
        return { ok: false, error: 'invalid route data' }
      }
      debugLog.log('dispatch', 'route', route)
      for (let i = 0; i < plugins.length; i++) {
        const p = plugins[i]
        if (!p) break
        const label = pluginLabels[i] ?? `plugin[${i}]`
        debugLog.log('dispatch', `tryDispatchRoute(${label})`)
        const r = await p.tryDispatchRoute(route, v.value.action, v.value.args)
        debugLog.log('dispatch', `tryDispatchRoute(${label}) result`, r ?? null)
        if (r != null) return r
      }
      debugLog.log('dispatch', 'no plugin handled route')
      return { ok: false, error: 'no egress for this route' }
    },
    onCall: async (d, _io) => {
      debugLog.log('call', 'inbound', d)
      for (let i = 0; i < plugins.length; i++) {
        const p = plugins[i]
        if (!p?.tryCall) continue
        const label = pluginLabels[i] ?? `plugin[${i}]`
        debugLog.log('call', `tryCall(${label})`)
        const r = await p.tryCall(d.channelId, d.method, d.args)
        debugLog.log('call', `tryCall(${label}) result`, r ?? null)
        if (r != null) return r
      }
      debugLog.log('call', 'no plugin handled call')
      return { ok: false, error: 'no handler for this channel/method' }
    },
    fetch: (req, io) =>
      dispatchPluginHttp(req, io, plugins, pluginLabels, httpCtx, debugLog),
    afterHubReady: async io => {
      for (let i = 0; i < plugins.length; i++) {
        const p = plugins[i]
        if (!p) break
        const label = pluginLabels[i] ?? `plugin[${i}]`
        debugLog.log('cli', `afterHubReady(${label})`)
        await p.afterHubReady(io)
      }
    },
  })
}

function dispatchPluginHttp(
  req: Request,
  io: GatewayIo,
  plugins: GatewayPluginHost[],
  pluginLabels: string[],
  httpCtx: GatewayPluginHttpContext,
  debugLog: GatewayDebugLogger,
): Promise<Response> {
  if (req.method !== 'POST') {
    debugLog.log('http', 'reject non-POST', { method: req.method, url: req.url })
    return Promise.resolve(jsonResponse({ error: 'method not allowed' }, 405))
  }
  return (async () => {
    for (let i = 0; i < plugins.length; i++) {
      const plugin = plugins[i]
      if (!plugin) break
      const handler = plugin.handleHttp
      const label = pluginLabels[i] ?? `plugin[${i}]`
      if (!handler) {
        debugLog.log('http', `skip handleHttp(${label}) (none)`)
        continue
      }
      debugLog.log('http', `handleHttp(${label})`)
      const r = await handler(req, io, httpCtx)
      debugLog.log('http', `handleHttp(${label}) result`, {
        handled: r != null,
        status: r?.status,
      })
      if (r != null) return r
    }
    debugLog.log('http', 'no plugin handled request', { url: req.url })
    return jsonResponse({ error: 'not found' }, 404)
  })()
}

main().catch(err => {
  process.stderr.write(`@omnibot/gateway: ${String(err)}\n`)
  process.exit(1)
})
