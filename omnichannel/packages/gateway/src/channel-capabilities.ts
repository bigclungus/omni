import type {
  CapabilitySet,
  OmniDispatchAction,
  OmnichannelPluginId,
} from '@omnibot/core'

function actionsForPlugin(plugin: string): OmniDispatchAction[] {
  if (plugin === 'channel-webhook' || plugin === 'channel-alertmanager')
    return ['noop']
  if (plugin === 'channel-discord') return ['reply', 'react', 'ack', 'noop']
  return ['reply', 'react', 'ack', 'resolve', 'noop']
}

function capabilityForChannel(
  channelId: string,
  plugin: string,
  calls: string[] | undefined,
): CapabilitySet {
  const ingress = true
  const egress =
    plugin !== 'channel-webhook' && plugin !== 'channel-alertmanager'
  return {
    channelId,
    plugin: plugin as OmnichannelPluginId,
    ingress,
    egress,
    actions: actionsForPlugin(plugin),
    ...(calls ? { calls } : {}),
  }
}

/** Builds MCP `omni_context` capability rows from channel plugin ids. */
export function getCapabilitySetsForChannels(
  channels: Record<string, { plugin: string }>,
  callsByPluginId: Map<string, string[]> = new Map(),
): CapabilitySet[] {
  return Object.entries(channels).map(([channelId, ch]) =>
    capabilityForChannel(channelId, ch.plugin, callsByPluginId.get(ch.plugin)),
  )
}
