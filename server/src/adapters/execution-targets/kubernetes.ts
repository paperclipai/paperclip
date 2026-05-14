import {
  createKubernetesExecutionDriver,
  type KubernetesDriverDeps,
} from "@paperclipai/execution-target-kubernetes";
import type { ExecutionTargetDriverRegistry } from "../execution-target-registry.js";

/**
 * Wires the Kubernetes execution-target driver into the registry. Called once
 * at server startup with a closure that resolves cluster connection records
 * (kubeconfig blob via Paperclip secret store, etc.) to ResolvedClusterConnection.
 */
export function registerKubernetesExecutionTargetDriver(
  registry: ExecutionTargetDriverRegistry,
  deps: KubernetesDriverDeps,
): void {
  registry.register(createKubernetesExecutionDriver(deps));
}
