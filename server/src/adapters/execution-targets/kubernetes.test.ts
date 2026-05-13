import { describe, it, expect } from "vitest";
import { registerKubernetesExecutionTargetDriver } from "./kubernetes.js";
import { createExecutionTargetRegistry } from "../execution-target-registry.js";

describe("registerKubernetesExecutionTargetDriver", () => {
  it("registers a driver of type 'kubernetes' into the registry", () => {
    const reg = createExecutionTargetRegistry();
    registerKubernetesExecutionTargetDriver(reg, {
      resolveConnection: async () => null,
    });
    const drv = reg.get("kubernetes");
    expect(drv).not.toBeNull();
    expect(drv?.type).toBe("kubernetes");
  });

  it("a freshly registered driver rejects unknown connection ids", async () => {
    const reg = createExecutionTargetRegistry();
    registerKubernetesExecutionTargetDriver(reg, {
      resolveConnection: async () => null,
    });
    const drv = reg.get("kubernetes")!;
    await expect(drv.validateTarget({ kind: "kubernetes", clusterConnectionId: "missing" }))
      .rejects.toThrow(/not found/i);
  });
});
