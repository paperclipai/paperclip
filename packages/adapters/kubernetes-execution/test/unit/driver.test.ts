import { describe, it, expect, vi } from "vitest";
import { createKubernetesExecutionDriver } from "../../src/driver.js";
import type { ResolvedClusterConnection } from "../../src/types.js";

// Mock the orchestrator-level ensureTenantNamespace so the driver-level
// ensureTenant tests can spy on the inputs it forwards (notably the merged
// adapterAllowFqdns).
const ensureTenantNamespaceSpy = vi.fn(async () => ({ namespace: "paperclip-acme", ciliumApplied: false }));
vi.mock("../../src/orchestrator/ensure-tenant.js", () => ({
  ensureTenantNamespace: (...args: unknown[]) => ensureTenantNamespaceSpy(...(args as [unknown, unknown])),
}));
// Also mock the kubernetes API client factory so creating one doesn't try to
// parse the kubeconfig.
vi.mock("../../src/client.js", () => ({
  createKubernetesApiClient: () => ({}),
}));

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

  it("returns execution_target_not_yet_supported when minter/run-context resolver are not wired", async () => {
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
    expect(result.errorMessage).toMatch(/bootstrap token minter|run-context resolver/i);
  });

  it("validates a kubernetes target when the connection resolves", async () => {
    const driver = createKubernetesExecutionDriver({
      resolveConnection: async () => sampleConnection,
    });
    await expect(driver.validateTarget({ kind: "kubernetes", clusterConnectionId: "c-1" }))
      .resolves.toBeUndefined();
  });

  describe("ensureTenant adapter-defaults FQDN merge", () => {
    const baseEnsureInput = {
      clusterConnectionId: "c-1",
      company: { id: "11111111-1111-1111-1111-111111111111", slug: "acme" },
      tenantPolicy: null,
      driverServiceAccount: { name: "paperclip-driver", namespace: "paperclip-system" },
      controlPlane: {
        topology: "in-cluster" as const,
        namespaceLabels: { "paperclip.ai/role": "control-plane" },
        podLabels: { "app.kubernetes.io/name": "paperclip-server" },
      },
      imagePullDockerConfigJson: null,
    };

    it("merges getAdapterDefaults(adapterType).allowFqdns into adapterAllowFqdns", async () => {
      ensureTenantNamespaceSpy.mockClear();
      const driver = createKubernetesExecutionDriver({
        resolveConnection: async () => sampleConnection,
      });

      await driver.ensureTenant({
        ...baseEnsureInput,
        adapterType: "codex_local",
        adapterAllowFqdns: ["custom.example"],
      });

      expect(ensureTenantNamespaceSpy).toHaveBeenCalledTimes(1);
      const forwarded = ensureTenantNamespaceSpy.mock.calls[0][1] as { adapterAllowFqdns: string[] };
      // codex_local default fqdn is "api.openai.com"; caller-supplied
      // "custom.example" must be preserved alongside it.
      expect(forwarded.adapterAllowFqdns).toEqual(expect.arrayContaining([
        "custom.example",
        "api.openai.com",
      ]));
    });

    it("backwards-compat: omitting adapterType passes adapterAllowFqdns through unchanged", async () => {
      ensureTenantNamespaceSpy.mockClear();
      const driver = createKubernetesExecutionDriver({
        resolveConnection: async () => sampleConnection,
      });

      await driver.ensureTenant({
        ...baseEnsureInput,
        adapterAllowFqdns: ["only.example"],
      });

      expect(ensureTenantNamespaceSpy).toHaveBeenCalledTimes(1);
      const forwarded = ensureTenantNamespaceSpy.mock.calls[0][1] as { adapterAllowFqdns: string[] };
      expect(forwarded.adapterAllowFqdns).toEqual(["only.example"]);
    });
  });
});
