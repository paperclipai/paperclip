import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/kube-client.js", () => ({
  createKubeConfig: vi.fn(() => ({})),
  makeKubeClients: vi.fn(() => ({})),
}));
vi.mock("../../src/tenant-orchestrator.js", () => ({ ensureTenant: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/secret-manager.js", () => ({ createPerRunSecret: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/sandbox-cr-orchestrator.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/sandbox-cr-orchestrator.js")>()),
  sandboxCrOrchestrator: {
    claim: vi.fn().mockResolvedValue({ uid: "uid-1" }),
    release: vi.fn().mockResolvedValue(undefined),
    findPod: vi.fn().mockResolvedValue("pod-1"),
  },
}));

import plugin from "../../src/plugin.js";

describe("onEnvironmentAcquireLease", () => {
  it("exposes /workspace as remoteCwd so adapter probes can native-sync before workspace realization", async () => {
    const lease = await plugin.definition.onEnvironmentAcquireLease!({
      driverKey: "kubernetes",
      config: { inCluster: true, backend: "sandbox-cr" },
      runId: "r-1",
      companyId: "acme",
      environmentId: "env-1",
    });
    expect(lease.metadata?.remoteCwd).toBe("/workspace");
  });
});
