import { describe, it, expect, vi, beforeEach } from "vitest";

// realizeWorkspace against fakes: the Sandbox orchestrator and the pod exec are
// recorded so each test can check where the agent works and who creates it.
const h = vi.hoisted(() => ({
  waitForReady: vi.fn(async () => ({ phase: "Running", active: 1 })),
  findPod: vi.fn(async () => "pc-pod"),
  execInPod: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
}));

vi.mock("../../src/kube-client.js", () => ({
  createKubeConfig: vi.fn(() => ({})),
  makeKubeClients: vi.fn(() => ({})),
}));
vi.mock("../../src/sandbox-cr-orchestrator.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/sandbox-cr-orchestrator.js")>();
  return {
    ...actual,
    sandboxCrOrchestrator: {
      claim: vi.fn(),
      findPod: h.findPod,
      waitForCompletion: h.waitForReady,
      release: vi.fn(),
      getStatus: vi.fn(),
      streamLogs: vi.fn(),
    },
  };
});
vi.mock("../../src/pod-exec.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/pod-exec.js")>();
  return { ...actual, execInPod: h.execInPod };
});

import plugin from "../../src/plugin.js";

function realize(opts: { remotePath?: string; backend?: string; leaseId?: string; podName?: string } = {}) {
  return plugin.definition.onEnvironmentRealizeWorkspace!({
    driverKey: "kubernetes",
    companyId: "company-1",
    environmentId: "env-1",
    config: { inCluster: true },
    lease: {
      providerLeaseId: opts.leaseId ?? "pc-realize-1",
      metadata: {
        namespace: "paperclip-company-1",
        backend: opts.backend ?? "sandbox-cr",
        ...(opts.podName ? { podName: opts.podName } : {}),
      },
    },
    workspace: opts.remotePath ? { remotePath: opts.remotePath } : {},
  } as never);
}

beforeEach(() => {
  h.waitForReady.mockClear();
  h.findPod.mockClear();
  h.execInPod.mockReset();
  h.execInPod.mockImplementation(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
});

describe("onEnvironmentRealizeWorkspace", () => {
  it("works in a directory the agent user creates inside /workspace", async () => {
    const result = await realize({ podName: "pc-pod-1" });
    expect(result.cwd).toBe("/workspace/paperclip-workspace");
    expect(result.metadata).toMatchObject({ remoteCwd: "/workspace/paperclip-workspace" });
    expect(h.execInPod).toHaveBeenCalledWith(
      expect.anything(), "paperclip-company-1", "pc-pod-1", "agent",
      ["mkdir", "-p", "/workspace/paperclip-workspace"], undefined, 30_000,
    );
  });

  it("waits for the Sandbox and finds its pod when the lease has no pod name", async () => {
    await realize({ leaseId: "pc-realize-2" });
    expect(h.waitForReady).toHaveBeenCalledWith(expect.anything(), "paperclip-company-1", "pc-realize-2", expect.any(Object));
    expect(h.findPod).toHaveBeenCalled();
    expect(h.execInPod).toHaveBeenCalledWith(
      expect.anything(), "paperclip-company-1", "pc-pod", "agent",
      ["mkdir", "-p", "/workspace/paperclip-workspace"], undefined, 30_000,
    );
  });

  it("honors a caller-supplied remotePath without creating anything", async () => {
    const result = await realize({ remotePath: "/workspace/custom", podName: "pc-pod-1" });
    expect(result.cwd).toBe("/workspace/custom");
    expect(h.execInPod).not.toHaveBeenCalled();
  });

  it("keeps /workspace for the job backend", async () => {
    const result = await realize({ backend: "job", podName: "pc-pod-1" });
    expect(result.cwd).toBe("/workspace");
    expect(h.execInPod).not.toHaveBeenCalled();
  });

  it("fails when the directory cannot be created", async () => {
    h.execInPod.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "mkdir: Permission denied" });
    await expect(realize({ leaseId: "pc-realize-3", podName: "pc-pod-1" })).rejects.toThrow(/Permission denied/);
  });
});
