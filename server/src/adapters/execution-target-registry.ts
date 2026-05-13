import type { KubernetesExecutionDriver } from "@paperclipai/execution-target-kubernetes";

/**
 * Discriminated union of every registered execution-target driver.
 * Future kinds (Nomad, ECS, Modal, ...) extend this union.
 */
export type ExecutionTargetDriver = KubernetesExecutionDriver;

export interface ExecutionTargetDriverRegistry {
  register(driver: ExecutionTargetDriver): void;
  get(kind: ExecutionTargetDriver["type"]): ExecutionTargetDriver | null;
  list(): ExecutionTargetDriver[];
}

export function createExecutionTargetRegistry(): ExecutionTargetDriverRegistry {
  const drivers = new Map<string, ExecutionTargetDriver>();
  return {
    register(driver) {
      if (drivers.has(driver.type)) {
        throw new Error(`Execution target driver "${driver.type}" already registered`);
      }
      drivers.set(driver.type, driver);
    },
    get(kind) {
      return drivers.get(kind) ?? null;
    },
    list() {
      return [...drivers.values()];
    },
  };
}
