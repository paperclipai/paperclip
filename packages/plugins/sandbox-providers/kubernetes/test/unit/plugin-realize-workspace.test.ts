import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  waitForReady: vi.fn(async () => ({ phase: "Running", active: 1 })),
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
      findPod: vi.fn(async () => "pc-pod"),
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
import { AGENT_WORKSPACE_DIR } from "../../src/sandbox-cr-builder.js";

function realize(opts: { remotePath?: string; metadata?: Record<string, unknown> } = {}) {
  return plugin.definition.onEnvironmentRealizeWorkspace!({
    driverKey: "kubernetes",
    companyId: "company-1",
    environmentId: "env-1",
    config: { inCluster: true },
    lease: {
      providerLeaseId: "pc-realize-1",
      metadata: {
        namespace: "paperclip-company-1",
        backend: "sandbox-cr",
        podName: "pc-pod-1",
        ...opts.metadata,
      },
    },
    workspace: opts.remotePath ? { remotePath: opts.remotePath } : {},
  } as never);
}

beforeEach(() => {
  h.waitForReady.mockClear();
  h.execInPod.mockClear();
});

describe("onEnvironmentRealizeWorkspace", () => {
  it("works in the agent-owned directory the Sandbox created at start-up", async () => {
    const result = await realize({ metadata: { agentWorkspaceDir: AGENT_WORKSPACE_DIR } });
    expect(result.cwd).toBe("/workspace/paperclip-workspace");
    expect(result.metadata).toMatchObject({ remoteCwd: "/workspace/paperclip-workspace" });
  });

  it("returns without waiting for the pod or calling the cluster", async () => {
    await realize({ metadata: { agentWorkspaceDir: AGENT_WORKSPACE_DIR } });
    expect(h.waitForReady).not.toHaveBeenCalled();
    expect(h.execInPod).not.toHaveBeenCalled();
  });

  it("honors a caller-supplied remotePath", async () => {
    const result = await realize({ remotePath: "/workspace/custom", metadata: { agentWorkspaceDir: AGENT_WORKSPACE_DIR } });
    expect(result.cwd).toBe("/workspace/custom");
  });

  it("keeps /workspace for a lease whose Sandbox was not created with the directory", async () => {
    expect((await realize()).cwd).toBe("/workspace");
    expect((await realize({ metadata: { backend: "job" } })).cwd).toBe("/workspace");
  });
});
