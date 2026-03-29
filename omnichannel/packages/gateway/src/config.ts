import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { parse as parseYaml } from 'yaml'

import type { CapabilitySet, OmniDispatchAction, OmnichannelPluginId } from '@omnichannel/core'

export interface ChannelConfig {
  plugin: OmnichannelPluginId
  /** Discord: guild text / thread channel snowflake to subscribe to. */
  discordChannelId?: string
  /** Discord: optional bot token on this channel (see also top-level `discord.token`). */
  token?: string
}

export interface GatewayYaml {
  /**
   * Optional Discord defaults. `discord.token` is checked before `DISCORD_BOT_TOKEN`
   * (or `gateway.discordBotTokenEnv`).
   */
  discord?: {
    token?: string
  }
  gateway: {
    httpPort: number
    ipcSocketPath: string
    dbPath: string
    sharedSecret?: string | null
    queueTtlSeconds?: number
    /** Env var name for the Discord bot token (default `DISCORD_BOT_TOKEN`). */
    discordBotTokenEnv?: string
    /** Reply-handle row TTL in seconds (default 604800 = 7d). */
    replyHandleTtlSeconds?: number
  }
  channels: Record<string, ChannelConfig>
}

export interface LoadedConfig extends GatewayYaml {
  configPath: string
}

function actionsForPlugin(plugin: OmnichannelPluginId): OmniDispatchAction[] {
  if (plugin === 'generic_webhook') return ['noop']
  if (plugin === 'discord') return ['reply', 'react', 'ack', 'noop']
  return ['reply', 'react', 'ack', 'resolve', 'noop']
}

function capabilityForChannel(
  channelId: string,
  plugin: OmnichannelPluginId,
): CapabilitySet {
  const ingress = true
  const egress = plugin !== 'generic_webhook'
  return {
    channelId,
    plugin,
    ingress,
    egress,
    actions: actionsForPlugin(plugin),
  }
}

export function getCapabilities(config: LoadedConfig): CapabilitySet[] {
  return Object.entries(config.channels).map(([channelId, ch]) =>
    capabilityForChannel(channelId, ch.plugin),
  )
}

export function resolveGatewayIpcSocketPath(config: LoadedConfig): string {
  const raw = config.gateway.ipcSocketPath.trim()
  if (!raw) {
    throw new Error('gateway.ipcSocketPath is empty')
  }
  if (raw.startsWith('/')) return raw
  return resolve(process.cwd(), raw)
}

export function getDiscordBotToken(config: LoadedConfig): string | null {
  const top = config.discord?.token?.trim()
  if (top) return top

  for (const ch of Object.values(config.channels)) {
    if (ch.plugin === 'discord' && ch.token?.trim()) {
      return ch.token.trim()
    }
  }

  const envName = config.gateway.discordBotTokenEnv ?? 'DISCORD_BOT_TOKEN'
  const fromEnv = process.env[envName]?.trim()
  return fromEnv || null
}

export function loadConfig(path?: string): LoadedConfig {
  const configPath = resolve(
    path ?? process.env.OMNI_CONFIG ?? 'omni.yaml',
  )
  if (!existsSync(configPath)) {
    throw new Error(
      `omnichannel gateway: config not found: ${configPath}\n` +
        `  Set OMNI_CONFIG or create omni.yaml (see omni.yaml.example).`,
    )
  }
  const raw = readFileSync(configPath, 'utf8')
  const doc = parseYaml(raw) as GatewayYaml
  if (!doc.gateway?.httpPort || !doc.gateway.ipcSocketPath || !doc.gateway.dbPath) {
    throw new Error(
      'omnichannel gateway: omni.yaml must define gateway.httpPort, gateway.ipcSocketPath, gateway.dbPath',
    )
  }
  if (!doc.channels || typeof doc.channels !== 'object') {
    throw new Error('omnichannel gateway: omni.yaml must define channels')
  }

  for (const [name, ch] of Object.entries(doc.channels)) {
    if (ch.plugin === 'discord') {
      if (!ch.discordChannelId?.trim()) {
        throw new Error(
          `omnichannel gateway: channels.${name} (discord) requires discordChannelId`,
        )
      }
    }
  }

  return { ...doc, configPath }
}
