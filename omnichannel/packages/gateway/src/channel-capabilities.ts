import type { CapabilityDef, CapabilitySet, OmnichannelPluginId } from '@omnibot/core'

import type { GatewayPluginHost } from './host-plugin.ts'

/**
 * Builds MCP `omni_context` capability rows.
 * Each plugin declares its own capabilities; the gateway just aggregates them.
 */
export function getCapabilitySetsForChannels(
  channels: Record<string, { plugin: string }>,
  pluginHosts: Array<{ pluginId: string; host: GatewayPluginHost }>,
): CapabilitySet[] {
  // Build a map from plugin id → capabilities
  const capsByPluginId = new Map<string, Record<string, CapabilityDef>>()
  for (const { pluginId, host } of pluginHosts) {
    capsByPluginId.set(pluginId, host.capabilities)
  }

  return Object.entries(channels).map(([channelId, ch]) => {
    const capabilities = capsByPluginId.get(ch.plugin) ?? {}
    return {
      channelId,
      plugin: ch.plugin as OmnichannelPluginId,
      ingress: true,
      egress: Object.keys(capabilities).length > 0,
      capabilities,
    }
  })
}
