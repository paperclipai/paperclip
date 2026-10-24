import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnState = vi.hoisted(() => ({
  mode: "reject-before-spawn" as "reject-before-spawn" | "reject-after-spawn",
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async (
      _runId: string,
      _command: string,
      _args: string[],
      opts: {
        onSpawn?: (meta: {
          pid: number;
          processGroupId: number | null;
          startedAt: string;
        }) => Promise<void>;
      },
    ) => {
      if (spawnState.mode === "reject-after-spawn") {
        await opts.onSpawn?.({
          pid: 4242,
          processGroupId: null,
          startedAt: "2026-01-01T00:00:00.000Z",
        });
        throw new Error("the provider stream closed unexpectedly");
      }
      throw new Error("spawn E2BIG");
    }),
  };
});

import { execute } from "./execute.js";

type SpawnReceipt = {
  pid: number;
  processGroupId: number | null;
  startedAt: string;
};

function makeCtx(onSpawn: (meta: SpawnReceipt) => Promise<void>) {
  return {
    runId: "test-run-spawn",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Hermes",
      adapterType: "hermes_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      hermesCommand: "/usr/bin/hermes",
      timeoutSec: 60,
      graceSec: 5,
      provider: "anthropic",
      model: "fixture-model",
    },
    context: {
      issueId: "issue-1",
      wakeReason: "manual",
      paperclipWake: null,
    },
    onLog: vi.fn(async () => undefined),
    onMeta: vi.fn(async () => undefined),
    onSpawn,
  } as unknown as Parameters<typeof execute>[0];
}

describe("hermes-local adapter: the provider was never reached", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spawnState.mode = "reject-before-spawn";
  });

  it("reports a spawn failure with the no-provider-work proof", async () => {
    const onSpawn = vi.fn(async () => undefined);

    const result = await execute(makeCtx(onSpawn));

    expect(result.executionRecovery).toEqual({
      kind: "bootstrap",
      providerWorkStarted: false,
    });
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("spawn E2BIG");
    expect(onSpawn).not.toHaveBeenCalled();
  });

  it("lets a failure that arrives after the spawn receipt escape", async () => {
    spawnState.mode = "reject-after-spawn";
    const onSpawn = vi.fn(async () => undefined);

    await expect(execute(makeCtx(onSpawn))).rejects.toThrow(
      "the provider stream closed unexpectedly",
    );
    expect(onSpawn).toHaveBeenCalledTimes(1);
  });
});
