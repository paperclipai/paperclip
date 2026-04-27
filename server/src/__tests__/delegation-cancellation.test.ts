import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execute } from "@paperclipai/adapter-managed-agents/server";
import type {
  AdapterExecutionContext,
  DelegationRequest,
  DelegationResult,
} from "@paperclipai/adapter-utils";

// -----------------------------------------------------------------------------
// Cancellation harness — covers the F-EXEC-2, F-HB-6, F-DELEG-4 cluster
// surfaced by the 2026-04-25 audit.
//
// Two independent scenarios:
//
//   1. Adapter-level (F-EXEC-2): when ctx.abortSignal fires mid-poll, the
//      managed_agents adapter must exit waitForIdle promptly and return a
//      clean { errorCode: "cancelled" } result instead of hanging until the
//      natural session timeout. Bug 7 (in-process adapters silently kept
//      polling after cancel) was structurally caused by the absence of any
//      cancellation surface in waitForIdle.
//
//   2. Delegation-level (F-DELEG-4): when delegate_task's parent polling
//      deadline expires before the child run reaches a terminal status, the
//      orphaned child run must be cancelled via the cancelRun callback —
//      otherwise the child keeps billing the company and may post a
//      tool_result after the parent has already returned status="timeout".
// -----------------------------------------------------------------------------

type MaEventStub = {
  id: string;
  type: string;
  [k: string]: unknown;
};

type FetchResponse = { status: number; body: unknown };
type FetchHandler = (method: string, path: string, body: unknown) => FetchResponse;

function installMaFetch(handler: FetchHandler): {
  calls: Array<{ method: string; path: string; body: unknown }>;
  restore: () => void;
} {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const orig = global.fetch;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const parsed = init?.body ? JSON.parse(init.body as string) : null;
    const path = new URL(url).pathname;
    calls.push({ method, path, body: parsed });
    const { status, body } = handler(method, path, parsed);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      global.fetch = orig;
    },
  };
}

function buildAdapterCtx(opts: {
  runId: string;
  abortSignal: AbortSignal;
  delegateTask?: (req: DelegationRequest) => Promise<DelegationResult>;
}): AdapterExecutionContext {
  return {
    runId: opts.runId,
    agent: {
      id: "ada-agent-uuid",
      companyId: "charlie-oscar-uuid",
      name: "Ada",
      adapterType: "managed_agents",
      adapterConfig: null,
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: "cancel-test",
    },
    config: {
      role: "Lead agent",
      model: "claude-haiku-4-5-20251001",
      // High enough that natural timeout is not what ends the test — we want
      // the abortSignal to be the trigger, not the natural cap.
      timeoutSec: 60,
    },
    context: {
      taskBody: "Run a long task",
    },
    onLog: async () => {},
    onMeta: async () => {},
    onSpawn: async () => {},
    delegateTask: opts.delegateTask,
    abortSignal: opts.abortSignal,
  };
}

describe("adapter managed-agents — abort signal cancellation (F-EXEC-2)", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = [
    "ANTHROPIC_API_KEY",
    "CORNERSTONE_API_KEY",
    "MEMORY_API_KEY",
    "COOKBOOK_ACCESS_TOKEN",
    "COOKBOOK_API_KEY",
    "COOKBOOK_MOCK_MODE",
  ];

  beforeEach(() => {
    for (const k of envKeys) savedEnv[k] = process.env[k];
    for (const k of envKeys) delete process.env[k];
    process.env.ANTHROPIC_API_KEY = "test-key-mocked-not-used";
  });

  afterEach(() => {
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it("returns errorCode='cancelled' when abortSignal fires mid-poll, without hanging", async () => {
    const SESSION_ID = "sesn_test_cancel_01";
    const AGENT_ID = "agnt_test_cancel";
    const ENV_ID = "envr_test_cancel";
    const RUN_ID = "parent-run-uuid-cancel";

    // Empty event stream: the adapter will keep polling (no idle terminal),
    // until either the natural timeout cap or the abortSignal fires. Test
    // succeeds iff abortSignal is the cause.
    const stableEvents: MaEventStub[] = [];

    installMaFetch((method, path) => {
      if (method === "POST" && path === "/v1/agents") {
        return {
          status: 200,
          body: {
            id: AGENT_ID,
            version: 1,
            model: { id: "claude-haiku-4-5-20251001" },
            name: "test",
            system: "",
          },
        };
      }
      if (method === "POST" && path === "/v1/environments") {
        return { status: 200, body: { id: ENV_ID, state: "ready", name: "test" } };
      }
      if (method === "POST" && path === "/v1/sessions") {
        return {
          status: 200,
          body: {
            id: SESSION_ID,
            status: "running",
            environment_id: ENV_ID,
            agent: { id: AGENT_ID, version: 1 },
            usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
            stats: { active_seconds: 0, duration_seconds: 0 },
          },
        };
      }
      if (method === "POST" && path === `/v1/sessions/${SESSION_ID}/events`) {
        return { status: 200, body: { data: [] } };
      }
      if (method === "GET" && path === `/v1/sessions/${SESSION_ID}/events`) {
        return { status: 200, body: { data: stableEvents } };
      }
      if (method === "GET" && path === `/v1/sessions/${SESSION_ID}`) {
        return {
          status: 200,
          body: {
            id: SESSION_ID,
            status: "running",
            environment_id: ENV_ID,
            agent: { id: AGENT_ID, version: 1 },
            usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
            stats: { active_seconds: 1.0, duration_seconds: 1 },
          },
        };
      }
      return { status: 404, body: { error: `unmocked ${method} ${path}` } };
    });

    const controller = new AbortController();
    // Abort after ~250ms — comfortably inside the 60s natural timeout cap so
    // any hang means the abort signal isn't being honoured.
    setTimeout(() => controller.abort(), 250);

    const ctx = buildAdapterCtx({ runId: RUN_ID, abortSignal: controller.signal });

    const start = Date.now();
    const result = await execute(ctx);
    const elapsedMs = Date.now() - start;

    expect(result.errorCode).toBe("cancelled");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    // Sanity: the abort should have ended the run within a few seconds, well
    // under the 60s natural timeout cap. If we hit the natural timeout the
    // assertion above would be "timeout" not "cancelled" — but we still want
    // to lock in the elapsed-time bound to detect future regressions where
    // the signal is honoured eventually but only after a long delay.
    expect(elapsedMs).toBeLessThan(5_000);
  });
});

describe("delegation — parent timeout cancels child run (F-DELEG-4)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Reset module cache so vi.doMock("../services/issues.js") + dynamic
    // import pick up the per-test mock factory rather than reusing whatever
    // closure the previous test bound.
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock("../services/issues.js");
    vi.resetModules();
  });

  it("invokes cancelRun(childRunId, ...) when child never reaches terminal", async () => {
    const childRunId = "11111111-1111-1111-1111-111111111111";
    const childIssueId = "22222222-2222-2222-2222-222222222222";
    const adaId = "aaaa1111-1111-1111-1111-111111111111";
    const donaldId = "bbbb2222-2222-2222-2222-222222222222";
    const companyId = "cccc3333-3333-3333-3333-333333333333";
    const adaParentRunId = "dddd4444-4444-4444-4444-444444444444";

    const cancelRunSpy = vi.fn(async () => undefined);
    const issueUpdateSpy = vi.fn(async () => ({}));

    // Minimal db stub: returns the assignee on the agents query, then returns
    // the child run row with status="running" forever (so the parent times
    // out and the cancelRun callback should fire).
    const dbStub = {
      select: () => ({
        from: () => ({
          where: () =>
            Promise.resolve([
              {
                id: donaldId,
                companyId,
                name: "Donald",
                reportsTo: adaId,
                permissions: { canDelegate: false },
              },
            ]),
        }),
      }),
    };

    // Override only after the assignee lookup — we need the child-run polling
    // queries to keep returning status="running". Fake the chained drizzle
    // call surface narrowly: the polling site runs db.select().from().where()
    // .then() — we provide a thenable that resolves to a row with status
    // "running". Subsequent call_n returns same. costEvents sum returns "0".
    const childRowRunning = {
      id: childRunId,
      status: "running",
      resultJson: {},
      errorCode: null,
      error: null,
    };
    let assigneeQueryCount = 0;
    (dbStub as unknown as { select: () => unknown }).select = () => ({
      from: (table: { _: { name?: string } } | unknown) => ({
        where: () => {
          // First call (delegation step 1) → assignee lookup. Subsequent
          // calls in the polling loop → child run row.
          if (assigneeQueryCount === 0) {
            assigneeQueryCount += 1;
            return Promise.resolve([
              {
                id: donaldId,
                companyId,
                name: "Donald",
                reportsTo: adaId,
                permissions: { canDelegate: false },
              },
            ]);
          }
          // costEvents sum query path — returns thenable with array of
          // { total: "0" } — we attach .then to mimic drizzle's lazy chain.
          const tableName =
            typeof table === "object" && table !== null && "_" in table
              ? (table as { _: { name?: string } })._?.name
              : undefined;
          if (tableName === "cost_events") {
            return {
              then: (resolve: (rows: Array<{ total: string }>) => unknown) =>
                resolve([{ total: "0" }]),
            };
          }
          // heartbeat_runs polling — return running row, attached as thenable
          // because delegation.ts uses `.then((rows) => rows[0] ?? null)`.
          return {
            then: (
              resolve: (rows: Array<typeof childRowRunning>) => unknown,
            ) => resolve([childRowRunning]),
          };
        },
      }),
    });

    // Mock issueService.create + .update via the import in delegation.ts. We
    // can't easily monkey-patch; instead we provide the surface delegation.ts
    // invokes via `issueService(db).create/update`. Since delegation.ts
    // imports issueService directly, we use vi.mock at the module level.
    vi.doMock("../services/issues.js", () => ({
      issueService: () => ({
        create: async () => ({
          id: childIssueId,
          identifier: "CO-CANCEL-1",
        }),
        update: issueUpdateSpy,
      }),
    }));

    // Re-import delegation after the mock is registered so it picks up the
    // mocked issueService.
    const { createDelegateTaskCallback: freshFactory } = await import(
      "../services/delegation.ts"
    );

    const heartbeatStub = {
      wakeup: vi.fn(async () => ({ id: childRunId })),
    };

    const delegateTask = freshFactory({
      db: dbStub as Parameters<typeof freshFactory>[0]["db"],
      heartbeat: heartbeatStub,
      parentAgent: {
        id: adaId,
        companyId,
        name: "Ada",
        permissions: { canDelegate: true },
      },
      parentRunId: adaParentRunId,
      cancelRun: cancelRunSpy,
    });

    // Kick off the delegation; we'll advance fake timers to trip the timeout.
    const promise = delegateTask({
      assigneeAgentName: "Donald",
      title: "Long-running audit",
      description: "Stays in_progress forever in this test",
      waitForCompletion: true,
      timeoutSeconds: 4,
    });

    // Initial 3000ms wait, then 5000ms poll interval. Advance through the
    // entire poll deadline (4s) plus margin. Need to advance past:
    //   - 3000ms initial sleep
    //   - first iteration query (sync resolution of the thenable)
    //   - 5000ms inner sleep — but deadline trips before completion
    // We yield to the microtask queue between advancements so the awaits
    // resume properly.
    await vi.advanceTimersByTimeAsync(3100);
    await vi.advanceTimersByTimeAsync(5100);

    const result = await promise;

    expect(result.status).toBe("timeout");
    expect(result.errorCode).toBe("timeout");
    expect(cancelRunSpy).toHaveBeenCalledTimes(1);
    expect(cancelRunSpy).toHaveBeenCalledWith(
      childRunId,
      "parent_delegation_timeout",
    );
    // Issue should also be flipped to cancelled (existing behaviour preserved).
    expect(issueUpdateSpy).toHaveBeenCalledWith(childIssueId, {
      status: "cancelled",
    });

  });

  it("does NOT call cancelRun when the child reaches a terminal status normally", async () => {
    // Negative case: the cancelRun cascade must only fire on parent timeout.
    // If the child finishes (succeeded/failed/cancelled/timed_out) on its own,
    // the parent has nothing to cancel and the callback should be left alone.
    const childRunId = "33333333-3333-3333-3333-333333333333";
    const childIssueId = "44444444-4444-4444-4444-444444444444";
    const adaId = "55555555-5555-5555-5555-555555555555";
    const donaldId = "66666666-6666-6666-6666-666666666666";
    const companyId = "77777777-7777-7777-7777-777777777777";
    const adaParentRunId = "88888888-8888-8888-8888-888888888888";

    const cancelRunSpy = vi.fn(async () => undefined);
    const issueUpdateSpy = vi.fn(async () => ({}));

    const childRowSucceeded = {
      id: childRunId,
      status: "succeeded",
      resultJson: { finalText: "Done" },
      errorCode: null,
      error: null,
    };

    let assigneeQueryCount = 0;
    const dbStub = {
      select: () => ({
        from: (table: { _: { name?: string } } | unknown) => ({
          where: () => {
            if (assigneeQueryCount === 0) {
              assigneeQueryCount += 1;
              return Promise.resolve([
                {
                  id: donaldId,
                  companyId,
                  name: "Donald",
                  reportsTo: adaId,
                  permissions: { canDelegate: false },
                },
              ]);
            }
            const tableName =
              typeof table === "object" && table !== null && "_" in table
                ? (table as { _: { name?: string } })._?.name
                : undefined;
            if (tableName === "cost_events") {
              return {
                then: (resolve: (rows: Array<{ total: string }>) => unknown) =>
                  resolve([{ total: "0" }]),
              };
            }
            return {
              then: (
                resolve: (rows: Array<typeof childRowSucceeded>) => unknown,
              ) => resolve([childRowSucceeded]),
            };
          },
        }),
      }),
    };

    vi.doMock("../services/issues.js", () => ({
      issueService: () => ({
        create: async () => ({
          id: childIssueId,
          identifier: "CO-CANCEL-2",
        }),
        update: issueUpdateSpy,
      }),
    }));

    const { createDelegateTaskCallback: freshFactory } = await import(
      "../services/delegation.ts"
    );

    const heartbeatStub = {
      wakeup: vi.fn(async () => ({ id: childRunId })),
    };

    const delegateTask = freshFactory({
      db: dbStub as Parameters<typeof freshFactory>[0]["db"],
      heartbeat: heartbeatStub,
      parentAgent: {
        id: adaId,
        companyId,
        name: "Ada",
        permissions: { canDelegate: true },
      },
      parentRunId: adaParentRunId,
      cancelRun: cancelRunSpy,
    });

    const promise = delegateTask({
      assigneeAgentName: "Donald",
      title: "Quick task",
      description: "Finishes immediately in this test",
      waitForCompletion: true,
      timeoutSeconds: 30,
    });

    // 3s initial wait, then first poll sees status=succeeded → break.
    await vi.advanceTimersByTimeAsync(3100);

    const result = await promise;

    expect(result.status).toBe("completed");
    expect(cancelRunSpy).not.toHaveBeenCalled();
    expect(issueUpdateSpy).toHaveBeenCalledWith(childIssueId, {
      status: "done",
    });

  });
});
