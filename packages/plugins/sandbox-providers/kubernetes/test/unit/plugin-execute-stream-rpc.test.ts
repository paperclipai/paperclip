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

/** A fake `ctx.streams` recording open/emit/close calls. */
function makeFakeStreams() {
  const calls: {
    open: Array<[string, string]>;
    emit: Array<[string, unknown]>;
    close: string[];
  } = { open: [], emit: [], close: [] };
  const streams = {
    open: (channel: string, companyId: string) => calls.open.push([channel, companyId]),
    emit: (channel: string, event: unknown) => calls.emit.push([channel, event]),
    close: (channel: string) => calls.close.push(channel),
  };
  return { streams, calls };
}

/** Inject a fake context via setup() so onEnvironmentExecute can reach ctx.streams. */
async function withFakeContext(streams: unknown) {
  await plugin.definition.setup({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    streams,
  } as never);
}

beforeEach(() => {
  h.execInPod.mockReset();
});

describe("onEnvironmentExecute ctx.streams bridge (RPC path)", () => {
  it("opens/emits/closes on the runId channel and returns streamed:true", async () => {
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
        onChunk?.("stderr", "live-2");
        return { exitCode: 0, stdout: "live-1", stderr: "live-2" };
      },
    );

    const { streams, calls } = makeFakeStreams();
    await withFakeContext(streams);

    const result = await plugin.definition.onEnvironmentExecute!(
      executeParams({ runId: "run-1", companyId: "acme", streamOutput: true }),
    );

    // Channel opened once, scoped to the company.
    expect(calls.open).toEqual([["env-exec-output:run-1", "acme"]]);
    // One emit per chunk, in order, with the { stream, text } shape.
    expect(calls.emit).toEqual([
      ["env-exec-output:run-1", { stream: "stdout", text: "live-1" }],
      ["env-exec-output:run-1", { stream: "stderr", text: "live-2" }],
    ]);
    // Channel closed exactly once.
    expect(calls.close).toEqual(["env-exec-output:run-1"]);

    expect(result.streamed).toBe(true);
    expect(result.stdout).toBe("live-1");
  });

  it("closes the channel on the exec error/timeout path", async () => {
    h.execInPod.mockRejectedValue(new Error("websocket blew up"));

    const { streams, calls } = makeFakeStreams();
    await withFakeContext(streams);

    const result = await plugin.definition.onEnvironmentExecute!(
      executeParams({ runId: "run-err", companyId: "acme", streamOutput: true }),
    );

    expect(calls.open).toEqual([["env-exec-output:run-err", "acme"]]);
    // Even though the exec threw (surfaced as a timeout), the channel is closed.
    expect(calls.close).toEqual(["env-exec-output:run-err"]);
    expect(result.timedOut).toBe(true);
  });

  it("does not stream when runId is null (buffered fallback, streamed unset)", async () => {
    h.execInPod.mockResolvedValue({ exitCode: 0, stdout: "buffered", stderr: "" });

    const { streams, calls } = makeFakeStreams();
    await withFakeContext(streams);

    const result = await plugin.definition.onEnvironmentExecute!(
      executeParams({ runId: null, companyId: "acme", streamOutput: true }),
    );

    expect(calls.open).toEqual([]);
    expect(calls.emit).toEqual([]);
    expect(calls.close).toEqual([]);
    // No sink was active -> onChunk undefined -> execInPod got no onChunk fn.
    expect(typeof h.execInPod.mock.calls[0][7]).not.toBe("function");
    expect(result.streamed).toBeFalsy();
    expect(result.stdout).toBe("buffered");
  });

  it("does not stream when streamOutput is not requested", async () => {
    h.execInPod.mockResolvedValue({ exitCode: 0, stdout: "buffered", stderr: "" });

    const { streams, calls } = makeFakeStreams();
    await withFakeContext(streams);

    const result = await plugin.definition.onEnvironmentExecute!(
      executeParams({ runId: "run-1", companyId: "acme" /* no streamOutput */ }),
    );

    expect(calls.open).toEqual([]);
    expect(calls.emit).toEqual([]);
    expect(calls.close).toEqual([]);
    expect(result.streamed).toBeFalsy();
  });
});
