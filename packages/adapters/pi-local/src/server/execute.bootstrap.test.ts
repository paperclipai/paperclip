import { describe, expect, it, vi } from "vitest";

const { runChildProcess, ensureCommandResolvable, resolveCommandForLogs } = vi.hoisted(() => ({
  runChildProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    pid: 1,
    startedAt: new Date().toISOString(),
  })),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "pi"),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    ensureCommandResolvable,
    resolveCommandForLogs,
    runChildProcess,
  };
});

vi.mock("./models.js", async () => {
  const actual = await vi.importActual<typeof import("./models.js")>("./models.js");
  return {
    ...actual,
    ensurePiModelConfiguredAndAvailable: vi.fn(async () => {
      throw new Error(
        "Configured Pi model is unavailable: deepseek/deepseek-chat. 2 models are available; list them with `pi --list-models`.",
      );
    }),
  };
});

import { execute } from "./execute.js";
import { ensurePiModelConfiguredAndAvailable } from "./models.js";

describe("pi-local adapter: the configured model is unavailable", () => {
  it("reports the failure with the no-provider-work proof instead of throwing", async () => {
    const logs: string[] = [];

    const result = await execute({
      runId: "run-model-unavailable",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Pi Builder",
        adapterType: "pi_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "pi",
        model: "deepseek/deepseek-chat",
        cwd: "/tmp",
        timeoutSec: 30,
        graceSec: 5,
      },
      context: {
        issueId: "issue-1",
        wakeReason: "manual",
        paperclipWake: null,
      },
      onLog: async (stream: string, chunk: string) => {
        logs.push(`${stream}: ${chunk}`);
      },
      onMeta: async () => undefined,
      onSpawn: async () => undefined,
    } as unknown as Parameters<typeof execute>[0]);

    expect(result.executionRecovery).toEqual({ kind: "bootstrap", providerWorkStarted: false });
    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(false);
    expect(result.errorMessage).toContain("Configured Pi model is unavailable");
    expect(result.errorMessage).toContain("Pi cannot start");
    expect(logs.join("\n")).toContain("Pi cannot start");
    expect(ensurePiModelConfiguredAndAvailable).toHaveBeenCalled();
    expect(runChildProcess).not.toHaveBeenCalled();
  });
});
