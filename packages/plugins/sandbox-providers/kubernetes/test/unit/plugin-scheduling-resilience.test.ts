import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock kube-client so no real cluster is touched.
vi.mock("../../src/kube-client.js", () => ({
  createKubeConfig: vi.fn(() => ({})),
  makeKubeClients: vi.fn(() => ({})),
}));

// Mock the Sandbox-CR orchestrator so tests control the readiness outcome.
// The error classes must be the SAME classes plugin.ts instanceof-checks, so
// export them from the mock and throw instances of them.
const h = vi.hoisted(() => {
  class SandboxCrTimeoutError extends Error {
    constructor(namespace: string, name: string, timeoutMs: number) {
      super(`Sandbox ${namespace}/${name} did not reach Ready phase within ${timeoutMs}ms`);
      this.name = "SandboxCrTimeoutError";
    }
  }
  class SandboxSchedulingError extends Error {
    constructor(namespace: string, name: string, detail?: string) {
      super(`Sandbox ${namespace}/${name} pod cannot be scheduled${detail ? `: ${detail}` : ""}`);
      this.name = "SandboxSchedulingError";
    }
  }
  return {
    SandboxCrTimeoutError,
    SandboxSchedulingError,
    waitForCompletion: vi.fn(),
    findPod: vi.fn(),
    execInPod: vi.fn(),
  };
});

vi.mock("../../src/sandbox-cr-orchestrator.js", () => ({
  sandboxCrOrchestrator: {
    waitForCompletion: h.waitForCompletion,
    findPod: h.findPod,
  },
  SandboxCrTimeoutError: h.SandboxCrTimeoutError,
  SandboxSchedulingError: h.SandboxSchedulingError,
}));

vi.mock("../../src/pod-exec.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/pod-exec.js")>();
  return {
    ...actual,
    execInPod: h.execInPod,
  };
});

import plugin from "../../src/plugin.js";

const CONFIG = { inCluster: true, backend: "sandbox-cr" };

function executeParams(overrides: Record<string, unknown> = {}) {
  return {
    driverKey: "kubernetes",
    companyId: "acme",
    environmentId: "env-1",
    config: CONFIG,
    lease: {
      // Unique lease id per test via overrides so the module-level
      // readySandboxesByLease cache never short-circuits the readiness wait.
      providerLeaseId: "pc-sched-1",
      metadata: {
        namespace: "paperclip-acme",
        podName: "pc-sched-pod",
        backend: "sandbox-cr",
      },
    },
    command: "echo",
    args: ["hi"],
    timeoutMs: 600_000,
    ...overrides,
  } as never;
}

function leaseWith(id: string) {
  return {
    providerLeaseId: id,
    metadata: {
      namespace: "paperclip-acme",
      podName: `${id}-pod`,
      backend: "sandbox-cr",
    },
  };
}

beforeEach(() => {
  h.waitForCompletion.mockReset();
  h.findPod.mockReset();
  h.execInPod.mockReset();
});

describe("onEnvironmentExecute scheduling failure (sandbox-cr)", () => {
  it("maps SandboxSchedulingError to a failed result with a clear message and errorCode sandbox_unschedulable", async () => {
    h.waitForCompletion.mockRejectedValue(
      new h.SandboxSchedulingError("paperclip-acme", "pc-sched-2", "0/9 nodes are available"),
    );

    const result = await plugin.definition.onEnvironmentExecute!(
      executeParams({ lease: leaseWith("pc-sched-2") }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toContain(
      "Sandbox pod could not be scheduled: cluster has no capacity for it. This is an infrastructure issue, not a problem with your task.",
    );
    expect(result.metadata).toMatchObject({
      provider: "kubernetes",
      backend: "sandbox-cr",
      errorCode: "sandbox_unschedulable",
    });
    expect(h.execInPod).not.toHaveBeenCalled();
  });

  it("includes the scheduler detail in stderr for debuggability", async () => {
    h.waitForCompletion.mockRejectedValue(
      new h.SandboxSchedulingError("paperclip-acme", "pc-sched-3", "9 Insufficient cpu"),
    );

    const result = await plugin.definition.onEnvironmentExecute!(
      executeParams({ lease: leaseWith("pc-sched-3") }),
    );

    expect(result.stderr).toContain("9 Insufficient cpu");
  });

  it("passes the configured podUnschedulableGraceSec to the readiness wait (default 120s)", async () => {
    h.waitForCompletion.mockResolvedValue({ phase: "Running" });
    h.execInPod.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    await plugin.definition.onEnvironmentExecute!(
      executeParams({ lease: leaseWith("pc-sched-4") }),
    );

    expect(h.waitForCompletion).toHaveBeenCalledWith(
      expect.anything(),
      "paperclip-acme",
      "pc-sched-4",
      expect.objectContaining({ unschedulableGraceMs: 120_000 }),
    );
  });
});

describe("onEnvironmentExecute readiness budget (sandbox-cr)", () => {
  it("caps the wait-for-Ready phase at podReadyTimeoutSec (default 300s), independent of the exec budget", async () => {
    h.waitForCompletion.mockResolvedValue({ phase: "Running" });
    h.execInPod.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    await plugin.definition.onEnvironmentExecute!(
      executeParams({ lease: leaseWith("pc-ready-1"), timeoutMs: 600_000 }),
    );

    expect(h.waitForCompletion).toHaveBeenCalledWith(
      expect.anything(),
      "paperclip-acme",
      "pc-ready-1",
      expect.objectContaining({ timeoutMs: 300_000 }),
    );
  });

  it("never lets the readiness wait exceed the caller's whole exec budget", async () => {
    h.waitForCompletion.mockResolvedValue({ phase: "Running" });
    h.execInPod.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    await plugin.definition.onEnvironmentExecute!(
      executeParams({ lease: leaseWith("pc-ready-2"), timeoutMs: 60_000 }),
    );

    expect(h.waitForCompletion).toHaveBeenCalledWith(
      expect.anything(),
      "paperclip-acme",
      "pc-ready-2",
      expect.objectContaining({ timeoutMs: 60_000 }),
    );
  });

  it("keeps (nearly) the whole exec budget for the exec phase after a fast readiness wait", async () => {
    h.waitForCompletion.mockResolvedValue({ phase: "Running" });
    h.execInPod.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    await plugin.definition.onEnvironmentExecute!(
      executeParams({ lease: leaseWith("pc-ready-3"), timeoutMs: 600_000 }),
    );

    // execInPod timeout (7th positional arg) must come from the FULL exec
    // budget, not the readiness cap: > podReadyTimeoutSec * 1000.
    const execTimeoutMs = h.execInPod.mock.calls[0][6] as number;
    expect(execTimeoutMs).toBeGreaterThan(500_000);
    expect(execTimeoutMs).toBeLessThanOrEqual(600_000);
  });

  it("maps a readiness timeout to the graceful did-not-become-Ready result with errorCode sandbox_not_ready", async () => {
    h.waitForCompletion.mockRejectedValue(
      new h.SandboxCrTimeoutError("paperclip-acme", "pc-ready-4", 300_000),
    );

    const result = await plugin.definition.onEnvironmentExecute!(
      executeParams({ lease: leaseWith("pc-ready-4"), timeoutMs: 600_000 }),
    );

    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(true);
    expect(result.stderr).toContain("Sandbox pod did not become Ready within 300000ms");
    expect(result.metadata).toMatchObject({ errorCode: "sandbox_not_ready" });
    expect(h.execInPod).not.toHaveBeenCalled();
  });
});
