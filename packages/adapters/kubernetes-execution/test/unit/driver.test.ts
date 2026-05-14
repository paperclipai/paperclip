import { describe, it, expect, vi } from "vitest";
import { createKubernetesExecutionDriver } from "../../src/driver.js";
import type { ResolvedClusterConnection } from "../../src/types.js";

const sampleConnection: ResolvedClusterConnection = {
  id: "c-1",
  label: "test",
  kind: "kubeconfig",
  kubeconfigYaml: `
apiVersion: v1
kind: Config
clusters:
  - name: test
    cluster:
      server: https://127.0.0.1:6443
      insecure-skip-tls-verify: true
contexts:
  - name: test
    context: { cluster: test, user: test }
current-context: test
users:
  - name: test
    user: { token: x }
`,
  defaultNamespacePrefix: "paperclip-",
  allowAgentImageOverride: false,
  capabilities: { cilium: false, storageClass: "standard", architectures: ["amd64"] },
};

describe("KubernetesExecutionDriver", () => {
  it("rejects non-kubernetes targets at validate", async () => {
    const driver = createKubernetesExecutionDriver({ resolveConnection: async () => null });
    await expect(driver.validateTarget({ kind: "local" } as never))
      .rejects.toThrow(/kubernetes/i);
  });

  it("rejects unknown clusterConnectionId", async () => {
    const driver = createKubernetesExecutionDriver({ resolveConnection: async () => null });
    await expect(driver.validateTarget({ kind: "kubernetes", clusterConnectionId: "missing" }))
      .rejects.toThrow(/cluster connection.+not found/i);
  });

  it("rejects targets missing clusterConnectionId", async () => {
    const driver = createKubernetesExecutionDriver({ resolveConnection: async () => null });
    await expect(driver.validateTarget({ kind: "kubernetes" } as never))
      .rejects.toThrow(/clusterConnectionId/);
  });

  it("returns NOT_YET_SUPPORTED from run() in M1", async () => {
    const driver = createKubernetesExecutionDriver({ resolveConnection: async () => null });
    const result = await driver.run({
      ctx: {
        runId: "r-1",
        agent: { id: "a-1", companyId: "c-1", name: "x", adapterType: "claude_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {},
        context: {},
        onLog: async () => {},
      },
      target: { kind: "kubernetes", clusterConnectionId: "c-1" },
    });
    expect(result.errorCode).toBe("execution_target_not_yet_supported");
    expect(result.exitCode).toBeNull();
    expect(result.errorMessage).toMatch(/M2/);
  });

  it("validates a kubernetes target when the connection resolves", async () => {
    const driver = createKubernetesExecutionDriver({
      resolveConnection: async () => sampleConnection,
    });
    await expect(driver.validateTarget({ kind: "kubernetes", clusterConnectionId: "c-1" }))
      .resolves.toBeUndefined();
  });
});
