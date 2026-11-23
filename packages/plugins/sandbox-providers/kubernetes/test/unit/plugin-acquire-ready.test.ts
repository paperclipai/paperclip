import { describe, it, expect, vi, beforeEach } from "vitest";

// acquireLease against fakes for everything that would touch a cluster. The
// Sandbox readiness wait and release are recorded so each test can check the
// lease is handed out only once its pod can take an exec.
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

beforeEach(() => {
  h.waitForReady.mockReset();
  h.waitForReady.mockImplementation(async () => ({ phase: "Running", active: 1 }));
  h.release.mockClear();
  h.jobWait.mockClear();
});

describe("onEnvironmentAcquireLease readiness", () => {
  it("waits for the Sandbox to be Ready on the start-up budget before handing out the lease", async () => {
    const lease = await acquire({ podStartTimeoutSec: 240 });
    expect(h.waitForReady).toHaveBeenCalledTimes(1);
    expect(h.waitForReady).toHaveBeenCalledWith(expect.anything(), expect.any(String), lease.providerLeaseId, {
      timeoutMs: 240_000,
      pollMs: 1000,
    });
    expect(h.release).not.toHaveBeenCalled();
    expect((lease.metadata as { podName?: string }).podName).toBe("pc-pod");
  });

  it("defaults the start-up budget to 300 s", async () => {
    await acquire();
    expect(h.waitForReady).toHaveBeenCalledWith(expect.anything(), expect.any(String), expect.any(String), {
      timeoutMs: 300_000,
      pollMs: 1000,
    });
  });

  it("releases the Sandbox and fails when it never becomes Ready", async () => {
    const notReady = new Error("Sandbox did not reach Ready phase");
    h.waitForReady.mockRejectedValueOnce(notReady);
    await expect(acquire()).rejects.toBe(notReady);
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it("reports both errors when the release also fails", async () => {
    h.waitForReady.mockRejectedValueOnce(new Error("not ready"));
    h.release.mockRejectedValueOnce(new Error("release failed"));
    await expect(acquire()).rejects.toBeInstanceOf(AggregateError);
  });

  it("does not wait on the job backend, whose pod is awaited per command", async () => {
    await acquire({ backend: "job" });
    expect(h.waitForReady).not.toHaveBeenCalled();
    expect(h.jobWait).not.toHaveBeenCalled();
  });
});
