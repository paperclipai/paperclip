import {
  createKubernetesExecutionDriver,
  type KubernetesDriverDeps,
  type KubernetesExecutionDriver,
} from "@paperclipai/execution-target-kubernetes";
import type { ExecutionTargetDriverRegistry } from "../execution-target-registry.js";

/**
 * Wires the Kubernetes execution-target driver into the registry. Called once
 * at server startup with a closure that resolves cluster connection records
 * (kubeconfig blob via Paperclip secret store, etc.) to ResolvedClusterConnection.
 *
 * Returns the driver so callers can use it to build the dispatcher closure
 * that adapters (claude_local, codex_local, ...) install at startup via
 * `setKubernetesExecutionDispatcher`.
 */
export function registerKubernetesExecutionTargetDriver(
  registry: ExecutionTargetDriverRegistry,
  deps: KubernetesDriverDeps,
): KubernetesExecutionDriver {
  const driver = createKubernetesExecutionDriver(deps);
  registry.register(driver);
  return driver;
}
