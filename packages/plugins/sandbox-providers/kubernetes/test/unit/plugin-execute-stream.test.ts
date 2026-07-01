import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock kube-client so no real cluster is touched.
vi.mock("../../src/kube-client.js", () => ({
  createKubeConfig: vi.fn(() => ({})),
  makeKubeClients: vi.fn(() => ({})),
}));

// Mock the Sandbox-CR orchestrator: report Ready immediately and resolve the
// pod name from lease metadata so execute() reaches the exec step.
vi.mock("../../src/sandbox-cr-orchestrator.js", () => ({
  sandboxCrOrchestrator: {
    waitForCompletion: vi.fn().mockResolvedValue({ phase: "Ready" }),
    findPod: vi.fn().mockResolvedValue("pc-abc-pod"),
  },
  SandboxCrTimeoutError: class extends Error {},
}));

// Mock execInPod but keep the real wrapCommandWithEnv.
const h = vi.hoisted(() => ({
  execInPod: vi.fn(),
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
      providerLeaseId: "pc-abc",
      metadata: {
        namespace: "paperclip-acme",
        podName: "pc-abc-pod",
        backend: "sandbox-cr",
      },
    },
    command: "echo",
    args: ["hi"],
    timeoutMs: 30_000,
    ...overrides,
  } as never;
}

beforeEach(() => {
  h.execInPod.mockReset();
});

describe("onEnvironmentExecute streaming (sandbox-cr)", () => {
  it("threads onOutput to execInPod as onChunk and returns streamed:true", async () => {
    h.execInPod.mockImplementation(
      async (
        _kc: unknown,
        _ns: string,
        _pod: string,
        _container: string,
        _cmd: string[],
        _stdin: unknown,
        _timeoutMs: number,
        onChunk?: (stream: "stdout" | "stderr", text: string) => void,
      ) => {
        onChunk?.("stdout", "live-1");
        onChunk?.("stdout", "live-2");
        return { exitCode: 0, stdout: "live-1live-2", stderr: "" };
      },
    );

    const received: Array<[string, string]> = [];
    const result = await plugin.definition.onEnvironmentExecute!(
      executeParams({
        onOutput: (stream: "stdout" | "stderr", text: string) => received.push([stream, text]),
      }),
    );

    // execInPod was called with an onChunk function (8th positional arg).
    expect(h.execInPod).toHaveBeenCalledTimes(1);
    const call = h.execInPod.mock.calls[0];
    expect(typeof call[7]).toBe("function");

    // Live chunks reached the caller's onOutput.
    expect(received).toEqual([
      ["stdout", "live-1"],
      ["stdout", "live-2"],
    ]);

    // Result flags that output was streamed live, and the buffered output is intact.
    expect(result.streamed).toBe(true);
    expect(result.stdout).toBe("live-1live-2");
    expect(result.exitCode).toBe(0);
  });

  it("leaves streamed unset when no onOutput is provided (backward-compatible)", async () => {
    h.execInPod.mockResolvedValue({ exitCode: 0, stdout: "buffered", stderr: "" });

    const result = await plugin.definition.onEnvironmentExecute!(executeParams());

    expect(h.execInPod).toHaveBeenCalledTimes(1);
    // 8th positional arg (onChunk) is not a function when no onOutput was passed.
    expect(typeof h.execInPod.mock.calls[0][7]).not.toBe("function");
    expect(result.streamed).toBeFalsy();
    expect(result.stdout).toBe("buffered");
  });
});
