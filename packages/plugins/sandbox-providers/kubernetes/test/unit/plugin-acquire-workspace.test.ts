import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({
  waitForReady: vi.fn(async () => ({ phase: "Running", active: 1 })),
  release: vi.fn(async () => undefined),
  jobWait: vi.fn(),
}));

vi.mock("../../src/kube-client.js", () => ({
  createKubeConfig: vi.fn(() => ({})),
  makeKubeClients: vi.fn(() => ({})),
}));
vi.mock("../../src/tenant-orchestrator.js", () => ({ ensureTenant: vi.fn(async () => undefined) }));
vi.mock("../../src/secret-manager.js", () => ({ createPerRunSecret: vi.fn(async () => undefined) }));
vi.mock("../../src/sandbox-cr-orchestrator.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/sandbox-cr-orchestrator.js")>();
  return {
    ...actual,
    sandboxCrOrchestrator: {
      claim: vi.fn(async () => ({ uid: "uid-1" })),
      findPod: vi.fn(async () => "pc-pod"),
      waitForCompletion: h.waitForReady,
      release: h.release,
      getStatus: vi.fn(),
      streamLogs: vi.fn(),
    },
  };
});
vi.mock("../../src/job-orchestrator.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/job-orchestrator.js")>();
  return {
    ...actual,
    jobOrchestrator: {
      claim: vi.fn(async () => ({ uid: "uid-job" })),
      findPod: vi.fn(async () => "pc-job-pod"),
      waitForCompletion: h.jobWait,
      release: vi.fn(async () => undefined),
      getStatus: vi.fn(),
      streamLogs: vi.fn(),
    },
  };
});
vi.mock("../../src/scoped-network-egress.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/scoped-network-egress.js")>();
  return { ...actual, createScopedNetworkEgressPolicyOrReleaseWorkload: vi.fn(async () => null) };
});

import plugin from "../../src/plugin.js";

function acquire(config: Record<string, unknown> = {}) {
  return plugin.definition.onEnvironmentAcquireLease!({
    driverKey: "kubernetes",
    companyId: "company-1",
    environmentId: "env-1",
    runId: "run-1",
    config: { inCluster: true, ...config },
  } as never);
}

describe("onEnvironmentAcquireLease workspace", () => {
  it("records the agent-owned workspace directory on a Sandbox lease", async () => {
    const lease = await acquire();
    expect(lease.metadata).toMatchObject({ agentWorkspaceDir: "/workspace/paperclip-workspace" });
  });

  it("records none on a job lease", async () => {
    const lease = await acquire({ backend: "job" });
    expect(lease.metadata).not.toHaveProperty("agentWorkspaceDir");
  });
});
