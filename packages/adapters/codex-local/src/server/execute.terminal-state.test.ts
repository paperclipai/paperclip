import { afterEach, describe, expect, it, vi } from "vitest";
import { execute } from "./execute.js";

type LogEntry = { stream: string; chunk: string };

function makeMinimalCtx(overrides: {
  context?: Record<string, unknown>;
  /** Pass null to omit the auth token entirely. */
  authToken?: string | null;
}) {
  const logs: LogEntry[] = [];
  const authToken = overrides.authToken === null ? undefined : (overrides.authToken ?? "test-token");
  return {
    ctx: {
      runId: "run-terminal-state-test",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Test Agent",
        adapterType: "codex_local",
        companyName: null,
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
      },
      config: {},
      context: { ...overrides.context },
      authToken,
      onLog: async (stream: string, chunk: string) => {
        logs.push({ stream, chunk });
      },
      onMeta: undefined,
      onSpawn: undefined,
      executionTarget: undefined,
      executionTransport: undefined,
      runtimeCommandSpec: undefined,
      onRuntimeProgress: undefined,
    },
    logs,
  };
}

describe("codex_local execute: terminal state early exit", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("exits cleanly when issue is already done (API fetch)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: "issue-1", status: "done" }),
      }),
    );

    const { ctx, logs } = makeMinimalCtx({
      context: { taskId: "issue-1" },
    });

    const result = await execute(ctx as Parameters<typeof execute>[0]);

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.errorMessage).toBeFalsy();
    const logText = logs.map((l) => l.chunk).join("");
    expect(logText).toContain("terminal state");
    expect(logText).toContain("done");
    expect(logText).toContain("issue-1");
  });

  it("exits cleanly when issue is already cancelled (API fetch)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: "issue-1", status: "cancelled" }),
      }),
    );

    const { ctx, logs } = makeMinimalCtx({
      context: { issueId: "issue-2" },
    });

    const result = await execute(ctx as Parameters<typeof execute>[0]);

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.errorMessage).toBeFalsy();
    const logText = logs.map((l) => l.chunk).join("");
    expect(logText).toContain("cancelled");
  });

  it("falls back to wake payload status when API fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("connection refused")),
    );

    const { ctx, logs } = makeMinimalCtx({
      context: {
        taskId: "issue-3",
        paperclipWake: { issue: { id: "issue-3", status: "done" } },
      },
    });

    const result = await execute(ctx as Parameters<typeof execute>[0]);

    expect(result.exitCode).toBe(0);
    const logText = logs.map((l) => l.chunk).join("");
    expect(logText).toContain("terminal state");
  });

  it("falls back to wake payload when no authToken is provided", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const { ctx, logs } = makeMinimalCtx({
      context: {
        taskId: "issue-4",
        paperclipWake: { issue: { id: "issue-4", status: "cancelled" } },
      },
      authToken: null, // explicit null → no auth token
    });

    const result = await execute(ctx as Parameters<typeof execute>[0]);

    expect(result.exitCode).toBe(0);
    // fetch should not be called when authToken is absent
    expect(fetchSpy).not.toHaveBeenCalled();
    const logText = logs.map((l) => l.chunk).join("");
    expect(logText).toContain("terminal state");
  });

});
