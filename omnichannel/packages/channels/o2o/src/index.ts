/**
 * Omni-to-omni channel — HTTP egress (`send`) and optional secured `/o2o/:channelId` ingress.
 */

export { createGatewayPluginHost } from './gateway-plugin.ts'
export {
  O2O_PATH_PREFIX,
  handleO2oPost,
  type O2oIngressContext,
  type O2oIngressHooks,
  type O2oIngressResolve,
} from './o2o-ingress.ts'
export { buildRequestBody, parsePayload, resolvePeerUrl } from './o2o-send.ts'
