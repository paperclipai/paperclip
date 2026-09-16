import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { startNativeGitHubCallbackBridge } from "../services/native-github-bridge.js";

const mocks = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => ({
  ...await importOriginal<typeof import("@paperclipai/adapter-utils/execution-target")>(),
  startAdapterExecutionTargetPaperclipBridge: mocks.start,
}));
afterEach(() => vi.clearAllMocks());

function target(enabled?: boolean): AdapterSandboxExecutionTarget {
  return {
    kind: "remote", transport: "sandbox", providerKey: "daytona",
    environmentId: "environment", leaseId: "lease", remoteCwd: "/home/daytona/repos/primary",
    timeoutMs: 30_000, runner: { execute: vi.fn() }, enableSandboxDuplexBridge: enabled,
  };
}

describe("native GitHub callback transport", () => {
  it.each([true, false, undefined])("preserves the target duplex opt-in %s", async (enabled) => {
    const executionTarget = target(enabled);
    const onLog = vi.fn();
    const bridge = { env: { PAPERCLIP_API_URL: "http://127.0.0.1:8123" }, stop: vi.fn() };
    mocks.start.mockResolvedValueOnce(bridge);
    expect(await startNativeGitHubCallbackBridge({
      runId: "current-run", target: executionTarget, hostApiToken: "current-run-capability", onLog,
    })).toBe(bridge);
    expect(mocks.start).toHaveBeenCalledWith({
      runId: "current-run", target: executionTarget, hostApiToken: "current-run-capability", onLog,
      runtimeRootDir: "/home/daytona/repos/primary/.paperclip-runtime/github/current-run",
      adapterKey: "native-github", enableSandboxDuplexBridge: enabled === true,
      duplexObservabilityRecorder: null,
    });
  });

  it("forwards the operator-gated recorder without changing its lifetime", async () => {
    const executionTarget = target(true);
    const recorder: NonNullable<AdapterSandboxExecutionTarget["duplexObservabilityRecorder"]> = {
      recordSpan: vi.fn(), incrementCounter: vi.fn(), emitEvent: vi.fn(),
    };
    executionTarget.duplexObservabilityRecorder = recorder;
    await startNativeGitHubCallbackBridge({runId:"run",target:executionTarget,hostApiToken:"capability"});
    expect(mocks.start.mock.calls[0][0].duplexObservabilityRecorder).toBe(recorder);
  });

  it("leaves local execution unchanged", async () => {
    expect(await startNativeGitHubCallbackBridge({runId:"run",target:null,hostApiToken:"capability"})).toBeNull();
    expect(mocks.start).not.toHaveBeenCalled();
  });
});
