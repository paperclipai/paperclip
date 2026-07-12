import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDb, dispatchGateState, type Db } from "@paperclipai/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { findActiveServerAdapter, registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import type { AdapterExecutionContext, AdapterExecutionResult } from "../adapters/index.js";
import {
  acquireDispatchGate,
  CLAUDE_LOCAL_DEFAULT_SCOPE,
  recordDispatchGateQuotaBlock,
  releaseDispatchGate,
  resumeDispatchGate,
  setDispatchGateDb,
  withDispatchGate,
  type DispatchGateBlockedResult,
} from "../services/dispatch-gate.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping dispatch gate tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const OK_RESULT: AdapterExecutionResult = { exitCode: 0, signal: null, timedOut: false };

function makeCtx(runId: string): AdapterExecutionContext {
  return {
    runId,
    agent: { id: "agent-1", companyId: "company-1", name: "Claude", adapterType: "claude_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {},
    context: {},
    onLog: async () => {},
  };
}

// Mirrors registry.ts's own classify/synthesize helpers (kept private there) so
// this test exercises the real `withDispatchGate` wrapper composed the same way
// the production `claude_local` adapter composes it — only the innermost "spawn
// the CLI" call is faked, which is unavoidable in a unit/integration test.
function classifyFakeQuota(result: AdapterExecutionResult) {
  if (result.errorFamily !== "provider_quota") return null;
  const resetAt = result.retryNotBefore ? new Date(result.retryNotBefore) : null;
  return { blockedUntil: resetAt && !Number.isNaN(resetAt.getTime()) ? resetAt : null, reason: result.errorCode ?? "provider_quota" };
}
function synthesizeBlocked(blocked: DispatchGateBlockedResult): AdapterExecutionResult {
  return {
    exitCode: null,
    signal: null,
    timedOut: false,
    errorCode: `dispatch_gate_${blocked.reason}`,
    errorFamily: blocked.reason === "quota_blocked" ? "provider_quota" : "transient_upstream",
    retryNotBefore: blocked.blockedUntil ? blocked.blockedUntil.toISOString() : null,
  };
}

describeEmbeddedPostgres("dispatch gate", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let fakeExecute: (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult> = async () => OK_RESULT;
  let fakeExecuteCalls = 0;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dispatch-gate-");
    db = createDb(tempDb.connectionString);
    setDispatchGateDb(db);

    // Overrides the builtin claude_local adapter for the duration of this
    // suite (same pattern used by heartbeat's PROVIDER_QUOTA_TEST_ADAPTER):
    // real registry lookup, real withDispatchGate, fake underlying launch.
    registerServerAdapter({
      type: "claude_local",
      execute: (ctx) =>
        withDispatchGate(
          CLAUDE_LOCAL_DEFAULT_SCOPE,
          { kind: "adapter", id: ctx.runId },
          async () => {
            fakeExecuteCalls += 1;
            await new Promise((resolve) => setTimeout(resolve, 30));
            return fakeExecute(ctx);
          },
          { classifyQuota: classifyFakeQuota, onBlocked: synthesizeBlocked },
        ),
      testEnvironment: (ctx) =>
        withDispatchGate(
          CLAUDE_LOCAL_DEFAULT_SCOPE,
          { kind: "hello_probe", id: randomUUID() },
          async () => ({ adapterType: "claude_local", status: "pass" as const, checks: [], testedAt: new Date().toISOString() }),
          {
            onBlocked: (blocked) => ({
              adapterType: "claude_local",
              status: "fail" as const,
              checks: [{ code: `dispatch_gate_${blocked.reason}`, level: "error" as const, message: "blocked" }],
              testedAt: new Date().toISOString(),
            }),
          },
        ),
    });
  }, 20_000);

  afterEach(async () => {
    fakeExecuteCalls = 0;
    fakeExecute = async () => OK_RESULT;
    await db.delete(dispatchGateState);
  });

  afterAll(async () => {
    unregisterServerAdapter("claude_local");
    await tempDb?.cleanup();
  });

  it("acquires exactly once under two concurrent launches, with no process-local mutex", async () => {
    const adapter = findActiveServerAdapter("claude_local")!;

    const [a, b] = await Promise.all([
      adapter.execute(makeCtx(randomUUID())),
      adapter.execute(makeCtx(randomUUID())),
    ]);

    const results = [a, b];
    expect(fakeExecuteCalls).toBe(1);
    expect(results.filter((r) => r.exitCode === 0)).toHaveLength(1);
    const blocked = results.filter((r) => r.errorCode === "dispatch_gate_ownership_active");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.errorFamily).toBe("transient_upstream");

    const [row] = await db.select().from(dispatchGateState).where(eq(dispatchGateState.scopeKey, CLAUDE_LOCAL_DEFAULT_SCOPE));
    expect(row?.ownershipState).toBe("idle");
  });

  it("persists a confirmed quota block durably, blocks every surface, and rejects non-quota failures", async () => {
    const resetAt = new Date(Date.now() + 60_000).toISOString();
    fakeExecute = async () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "provider_quota",
      errorFamily: "provider_quota",
      errorMessage: "session limit reached",
      retryNotBefore: resetAt,
    });
    const adapter = findActiveServerAdapter("claude_local")!;

    const first = await adapter.execute(makeCtx(randomUUID()));
    expect(first.errorFamily).toBe("provider_quota");

    // Durable: an independently-connected Db (simulating another process)
    // observes the same block — it is not in-memory state.
    const otherConnectionDb = createDb(tempDb!.connectionString);
    const [row] = await otherConnectionDb
      .select()
      .from(dispatchGateState)
      .where(eq(dispatchGateState.scopeKey, CLAUDE_LOCAL_DEFAULT_SCOPE));
    expect(row?.blockedUntil).not.toBeNull();
    expect(new Date(row!.blockedUntil!).getTime()).toBeGreaterThan(Date.now());

    // Another worker cannot acquire while blocked.
    const blockedAcquire = await acquireDispatchGate(CLAUDE_LOCAL_DEFAULT_SCOPE, { kind: "adapter", id: randomUUID() });
    expect(blockedAcquire.ok).toBe(false);

    // Retry/recovery through the registered adapter is blocked too, without
    // re-invoking the underlying launch.
    const callsBefore = fakeExecuteCalls;
    const second = await adapter.execute(makeCtx(randomUUID()));
    expect(second.errorFamily).toBe("provider_quota");
    expect(fakeExecuteCalls).toBe(callsBefore);

    // Board chat, login, and the hello probe share the identical primitive.
    for (const ownerKind of ["board_chat", "login", "hello_probe"]) {
      const attempt = await acquireDispatchGate(CLAUDE_LOCAL_DEFAULT_SCOPE, { kind: ownerKind, id: randomUUID() });
      expect(attempt.ok).toBe(false);
    }

    await resumeDispatchGate(CLAUDE_LOCAL_DEFAULT_SCOPE);

    // Negative cases: none of these open (or leave open) a quota block.
    const negativeResults: AdapterExecutionResult[] = [
      { exitCode: 1, signal: null, timedOut: true },
      { exitCode: 1, signal: null, timedOut: false, errorCode: "adapter_failed" },
      { exitCode: 1, signal: null, timedOut: false, errorCode: "ENOENT" },
      { exitCode: 1, signal: null, timedOut: false, errorFamily: "transient_upstream" },
    ];
    for (const negativeResult of negativeResults) {
      fakeExecute = async () => negativeResult;
      await adapter.execute(makeCtx(randomUUID()));
      const [afterRow] = await db
        .select()
        .from(dispatchGateState)
        .where(eq(dispatchGateState.scopeKey, CLAUDE_LOCAL_DEFAULT_SCOPE));
      expect(afterRow?.blockedUntil).toBeNull();
      expect(afterRow?.operatorResumeRequired).toBe(false);
    }

    // Verified reset expiry permits a new atomic claim. recordDispatchGateQuotaBlock
    // only takes effect for the owner currently holding the row, so acquire
    // first (as withDispatchGate itself would) before recording the block.
    const priorOwner = { kind: "adapter", id: "prior-owner" };
    expect((await acquireDispatchGate(CLAUDE_LOCAL_DEFAULT_SCOPE, priorOwner)).ok).toBe(true);
    await recordDispatchGateQuotaBlock(CLAUDE_LOCAL_DEFAULT_SCOPE, priorOwner, {
      blockedUntil: new Date(Date.now() - 1000),
      reason: "provider_quota",
      operatorResumeRequired: false,
    });
    const claimOwner = { kind: "adapter", id: randomUUID() };
    const afterExpiry = await acquireDispatchGate(CLAUDE_LOCAL_DEFAULT_SCOPE, claimOwner);
    expect(afterExpiry.ok).toBe(true);
    await releaseDispatchGate(CLAUDE_LOCAL_DEFAULT_SCOPE, claimOwner);
  });

  it("keeps ownership durable across crash-before-spawn, never releasing on a missing PID or auto-cleaning unknown state", async () => {
    const owner = { kind: "adapter", id: randomUUID() };
    const acquired = await acquireDispatchGate(CLAUDE_LOCAL_DEFAULT_SCOPE, owner);
    expect(acquired.ok).toBe(true);
    // Simulates a crash after the ownership transaction committed but before
    // (or shortly after) the process was ever spawned — no PID is ever
    // persisted, and nothing further happens to the row from this process.

    // A recreated service — a brand-new Db connection with no in-memory
    // state — must see the same durable ownership and be unable to acquire.
    const recreatedServiceDb = createDb(tempDb!.connectionString);
    const [rowFromRecreatedConnection] = await recreatedServiceDb
      .select()
      .from(dispatchGateState)
      .where(eq(dispatchGateState.scopeKey, CLAUDE_LOCAL_DEFAULT_SCOPE));
    expect(rowFromRecreatedConnection?.ownershipState).toBe("active");
    expect(rowFromRecreatedConnection?.ownerId).toBe(owner.id);

    const reacquireAttempt = await acquireDispatchGate(CLAUDE_LOCAL_DEFAULT_SCOPE, { kind: "adapter", id: randomUUID() });
    expect(reacquireAttempt.ok).toBe(false);
    if (!reacquireAttempt.ok) expect(reacquireAttempt.reason).toBe("ownership_active");
  });

  it("marks ownership unknown (never idle) when the real wrapped launch throws mid-flight", async () => {
    fakeExecute = async () => {
      throw new Error("simulated crash after spawn, before PID persistence");
    };
    const adapter = findActiveServerAdapter("claude_local")!;
    await expect(adapter.execute(makeCtx(randomUUID()))).rejects.toThrow(
      "simulated crash after spawn, before PID persistence",
    );

    const [row] = await db.select().from(dispatchGateState).where(eq(dispatchGateState.scopeKey, CLAUDE_LOCAL_DEFAULT_SCOPE));
    expect(row?.ownershipState).toBe("unknown");

    const nextAttempt = await acquireDispatchGate(CLAUDE_LOCAL_DEFAULT_SCOPE, { kind: "adapter", id: randomUUID() });
    expect(nextAttempt.ok).toBe(false);
    if (!nextAttempt.ok) expect(nextAttempt.reason).toBe("ownership_unknown");
    // No automatic cleanup exists for unknown ownership — it stays unknown
    // until an operator or explicit recovery action resolves it. Reset by
    // hand here purely so later tests in this file start from a clean row.
    await db
      .update(dispatchGateState)
      .set({ ownershipState: "idle", ownerKind: null, ownerId: null })
      .where(eq(dispatchGateState.scopeKey, CLAUDE_LOCAL_DEFAULT_SCOPE));
  });

  it("blocks every direct-inference surface while ownership is active, without reaching the real launch boundary", async () => {
    const owner = { kind: "board_chat", id: randomUUID() };
    const acquired = await acquireDispatchGate(CLAUDE_LOCAL_DEFAULT_SCOPE, owner);
    expect(acquired.ok).toBe(true);

    const adapter = findActiveServerAdapter("claude_local")!;

    const executeResult = await adapter.execute(makeCtx(randomUUID()));
    expect(executeResult.errorCode).toBe("dispatch_gate_ownership_active");
    expect(fakeExecuteCalls).toBe(0);

    const testEnvResult = await adapter.testEnvironment({ companyId: "c1", adapterType: "claude_local", config: {} });
    expect(testEnvResult.status).toBe("fail");
    expect(testEnvResult.checks[0]?.code).toBe("dispatch_gate_ownership_active");

    // Board chat, login, and the hello probe are read-only-distinct owner
    // kinds but mediate through this exact same primitive before they ever
    // touch a real process (see routes/board-chat.ts and routes/agents.ts).
    for (const ownerKind of ["login", "hello_probe", "board_chat"]) {
      const attempt = await acquireDispatchGate(CLAUDE_LOCAL_DEFAULT_SCOPE, { kind: ownerKind, id: randomUUID() });
      expect(attempt.ok).toBe(false);
    }

    await releaseDispatchGate(CLAUDE_LOCAL_DEFAULT_SCOPE, owner);
  });
});
