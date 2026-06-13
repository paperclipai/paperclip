import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute, ensureRemoteOpenCodeModelConfiguredAndAvailable } from "./execute.js";

const runProcessMock = vi.hoisted(() => vi.fn());
const prepareRuntimeMock = vi.hoisted(() => vi.fn(async () => ({
  workspaceRemoteDir: "/remote/workspace",
  restoreWorkspace: async () => {},
  assetDirs: {},
})));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<any>("@paperclipai/adapter-utils/execution-target");
  return {
    ...actual,
    runAdapterExecutionTargetProcess: runProcessMock,
    ensureAdapterExecutionTargetRuntimeCommandInstalled: async () => {},
    ensureAdapterExecutionTargetCommandResolvable: async () => {},
    resolveAdapterExecutionTargetCommandForLogs: async () => "opencode",
    prepareAdapterExecutionTargetRuntime: prepareRuntimeMock,
    readAdapterExecutionTarget: () => ({ kind: "remote", transport: "sandbox" }),
    adapterExecutionTargetIsRemote: () => true,
    adapterExecutionTargetUsesManagedHome: () => true,
    readAdapterExecutionTargetHomeDir: async () => "/remote/home",
    adapterExecutionTargetUsesPaperclipBridge: () => false,
  };
});

describe("ensureRemoteOpenCodeModelConfiguredAndAvailable", () => {
  afterEach(() => {
    delete process.env.OPENCODE_ALLOW_ALL_MODELS;
  });

  // The remote/sandbox execution path must honour OPENCODE_ALLOW_ALL_MODELS just
  // like the local path: gateway-routed models (e.g. anthropic/<gateway>/<model>
  // via Bifrost) never appear in `opencode models`, so the availability probe
  // must be skipped. The early return happens before the executionTarget is ever
  // touched, so a bogus target proves the probe was not run.
  const bogusTarget = {} as never;

  it("skips the remote availability probe when OPENCODE_ALLOW_ALL_MODELS is set in the run env", async () => {
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-1",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        cwd: "/tmp",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).resolves.toBe("anthropic/tensorix/deepseek/deepseek-chat-v3.1");
  });

  it("honours OPENCODE_ALLOW_ALL_MODELS from the process env", async () => {
    process.env.OPENCODE_ALLOW_ALL_MODELS = "1";
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-2",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        cwd: "/tmp",
        env: {},
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).resolves.toBe("anthropic/tensorix/deepseek/deepseek-chat-v3.1");
  });

  it("still enforces provider/model format even when the bypass flag is set", async () => {
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-3",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "",
        cwd: "/tmp",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).rejects.toThrow();
  });
});

describe("opencode_local execute retry and fallback", () => {
  beforeEach(() => {
    runProcessMock.mockReset();
    prepareRuntimeMock.mockClear();
    process.env.OPENCODE_ALLOW_ALL_MODELS = "true";
  });

  afterEach(() => {
    delete process.env.OPENCODE_ALLOW_ALL_MODELS;
  });

  it("retries with fallbackModel when the first run times out", async () => {
    const logs: string[] = [];
    const ctx: AdapterExecutionContext = {
      runId: "run-test-timeout",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "OpenCode Agent",
        adapterType: "opencode_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "session-1",
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        model: "openai/gpt-5.2-codex",
        fallbackModel: "google/antigravity-gemini-3-flash",
      },
      context: {},
      authToken: "run-token",
      onLog: async (stream, chunk) => {
        logs.push(chunk);
      },
    };

    runProcessMock
      .mockResolvedValueOnce({
        exitCode: null,
        signal: null,
        timedOut: true,
        stdout: "",
        stderr: "",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: JSON.stringify({ type: "text", part: { text: "success with fallback" } }),
        stderr: "",
      });

    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.model).toBe("google/antigravity-gemini-3-flash");
    expect(result.summary).toBe("success with fallback");
    expect(logs.some((log) => log.includes("Retrying with fallback model"))).toBe(true);
  });

  it("retries with fallbackModel when the first run has connection error", async () => {
    const logs: string[] = [];
    const ctx: AdapterExecutionContext = {
      runId: "run-test-connerr",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "OpenCode Agent",
        adapterType: "opencode_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "session-1",
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        model: "openai/gpt-5.2-codex",
        fallbackModel: "google/antigravity-gemini-3-flash",
      },
      context: {},
      authToken: "run-token",
      onLog: async (stream, chunk) => {
        logs.push(chunk);
      },
    };

    runProcessMock
      .mockResolvedValueOnce({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "fetch failed: connection reset by peer",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: JSON.stringify({ type: "text", part: { text: "success after retry" } }),
        stderr: "",
      });

    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.model).toBe("google/antigravity-gemini-3-flash");
    expect(result.summary).toBe("success after retry");
    expect(logs.some((log) => log.includes("Retrying with fallback model"))).toBe(true);
  });

  it("terminates process and returns process_lost error when silence exceeds 5 minutes", async () => {
    vi.useFakeTimers();
    try {
      const logs: string[] = [];
      const ctx: AdapterExecutionContext = {
        runId: "run-test-silence",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "OpenCode Agent",
          adapterType: "opencode_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: "session-1",
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          model: "openai/gpt-5.2-codex",
        },
        context: {},
        authToken: "run-token",
        onLog: async (stream, chunk) => {
          logs.push(chunk);
        },
      };

      let resolveProcess: any;
      const processPromise = new Promise((resolve) => {
        resolveProcess = resolve;
      });

      runProcessMock.mockImplementationOnce(async () => {
        // Advance timers by 5 minutes + 10 seconds now that process has started
        await vi.advanceTimersByTimeAsync(5 * 60_000 + 10_000);
        return processPromise;
      });

      const executePromise = execute(ctx);

      resolveProcess({
        exitCode: null,
        signal: "SIGKILL",
        timedOut: false,
        stdout: "",
        stderr: "",
      });

      const result = await executePromise;

      expect(result.exitCode).not.toBe(0);
      expect(result.errorCode).toBe("process_lost");
      expect(result.errorMessage).toBe("OpenCode process was terminated due to silence");
      expect(logs.some((log) => log.includes("OpenCode process has been silent"))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
