export const PACKAGE_NAME = "@paperclipai/execution-target-kubernetes";

export { createKubernetesExecutionDriver } from "./driver.js";
export type {
  KubernetesExecutionDriver,
  KubernetesDriverDeps,
  EnsureTenantDriverInput,
} from "./driver.js";

export {
  ensureTenantNamespace,
  type EnsureTenantInput,
  type EnsureTenantResult,
  type TenantPolicy,
} from "./orchestrator/ensure-tenant.js";

export { createKubernetesApiClient } from "./client.js";
export { probeClusterCapabilities } from "./orchestrator/capabilities.js";
export { deriveNamespaceName, isValidDns1123Label } from "./orchestrator/naming.js";

export type {
  ResolvedClusterConnection,
  ClusterCapabilities,
  KubernetesApiClient,
} from "./types.js";
