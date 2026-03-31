/**
 * @omnibot/gateway — IPC, SQLite ingress, HTTP bind. Channel plugins are loaded by `src/cli.ts` from YAML.
 */

export { getCapabilitySetsForChannels } from './channel-capabilities.ts'
export * from './config.ts'
export * from './db.ts'
export * from './http-listener.ts'
export * from './http-util.ts'
export * from './ipc.ts'
export { startGateway, type GatewayIo, type StartGatewayOptions } from './run.ts'
export type {
  CreateGatewayPluginHost,
  GatewayPluginHost,
  GatewayPluginHostContext,
  GatewayPluginHttpContext,
  InvokeContext,
  InvokeResult,
  PluginChannelHealth,
} from './host-plugin.ts'
export {
  createGatewayDebugLogger,
  summarizeConfigForDebug,
  type GatewayDebugLogger,
} from './debug-log.ts'
