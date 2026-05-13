export const PACKAGE_NAME = "@paperclipai/execution-target-kubernetes";

export { createKubernetesExecutionDriver } from "./driver.js";
export type {
  KubernetesExecutionDriver,
  KubernetesDriverDeps,
  EnsureTenantDriverInput,
  ResolveRunContextInput,
  ResolvedRunContext,
} from "./driver.js";

export type {
  BootstrapTokenMinter,
  BootstrapTokenMintRequest,
  BootstrapTokenMintResult,
} from "./bootstrap/token.js";

export {
  ensureTenantNamespace,
  type EnsureTenantInput,
  type EnsureTenantResult,
  type TenantPolicy,
} from "./orchestrator/ensure-tenant.js";

export { buildTenantCiliumPolicy } from "./orchestrator/cilium-tenant-policy.js";
export { createKubernetesApiClient } from "./client.js";
export { probeClusterCapabilities } from "./orchestrator/capabilities.js";
export { deriveNamespaceName, isValidDns1123Label } from "./orchestrator/naming.js";

export type {
  ResolvedClusterConnection,
  ClusterCapabilities,
  KubernetesApiClient,
} from "./types.js";

export {
  ADAPTER_DEFAULTS,
  getAdapterDefaults,
  type AdapterDefaults,
} from "./orchestrator/adapter-defaults.js";
