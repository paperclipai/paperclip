import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDb, dispatchGateState, type Db } from "@paperclipai/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { findActiveServerAdapter, registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import type {
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "../adapters/index.js";
import {
  acquireDispatchGate,
  CLAUDE_LOCAL_DEFAULT_SCOPE,
  markDispatchGateUnknown,
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

// Mirrors registry.ts's runClaudeHelloProbeThroughGate: gates only the single
// inference-producing call, not the whole environment test.
function runFakeHelloProbeThroughGate<T>(run: () => Promise<T>): Promise<T | null> {
  return withDispatchGate<T | null>(
    CLAUDE_LOCAL_DEFAULT_SCOPE,
    { kind: "hello_probe", id: randomUUID() },
    run,
    { onBlocked: () => null },
  );
}

describeEmbeddedPostgres("dispatch gate", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let fakeExecute: (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult> = async () => OK_RESULT;
  let fakeExecuteCalls = 0;
  let fakeReadOnlyCheckCalls = 0;
  let fakeHelloProbeCalls = 0;

  // Mirrors the real two-layer composition: an "adapter package" function with
  // a read-only check that always runs, plus one inference-producing "hello"
  // call it only mediates via ctx.runInferenceProbe when a caller supplies
  // one — exactly like packages/adapters/claude-local/src/server/test.ts.
  async function fakeClaudeTestEnvironment(
    ctx: AdapterEnvironmentTestContext,
  ): Promise<AdapterEnvironmentTestResult> {
    fakeReadOnlyCheckCalls += 1;
    const runInferenceProbe = ctx.runInferenceProbe ?? (<T,>(run: () => Promise<T>) => run());
    const probe = await runInferenceProbe(async () => {
      fakeHelloProbeCalls += 1;
      return "hello" as const;
    });
    if (probe === null) {
      return {
        adapterType: "claude_local",
        status: "warn",
        checks: [{ code: "claude_hello_probe_gate_blocked", level: "warn", message: "blocked" }],
        testedAt: new Date().toISOString(),
      };
    }
    return {
      adapterType: "claude_local",
      status: "pass",
      checks: [{ code: "claude_command_resolvable", level: "info", message: "ok" }],
      testedAt: new Date().toISOString(),
    };
  }

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
      // Wraps the fake "adapter package" function the same way registry.ts's
      // claudeTestEnvironmentWithGate wraps the real claudeTestEnvironment:
      // injects the gate only via runInferenceProbe, nothing else.
      testEnvironment: (ctx) =>
        fakeClaudeTestEnvironment({ ...ctx, runInferenceProbe: runFakeHelloProbeThroughGate }),
    });
  }, 20_000);

  afterEach(async () => {
    fakeExecuteCalls = 0;
    fakeReadOnlyCheckCalls = 0;
    fakeHelloProbeCalls = 0;
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

    // The environment test's read-only check still runs — only the single
    // inference-producing hello-probe call is mediated by the gate.
    const testEnvResult = await adapter.testEnvironment({ companyId: "c1", adapterType: "claude_local", config: {} });
    expect(fakeReadOnlyCheckCalls).toBe(1);
    expect(fakeHelloProbeCalls).toBe(0);
    expect(testEnvResult.status).toBe("warn");
    expect(testEnvResult.checks[0]?.code).toBe("claude_hello_probe_gate_blocked");

    // Board chat, login, and the hello probe are read-only-distinct owner
    // kinds but mediate through this exact same primitive before they ever
    // touch a real process (see routes/board-chat.ts and routes/agents.ts).
    for (const ownerKind of ["login", "hello_probe", "board_chat"]) {
      const attempt = await acquireDispatchGate(CLAUDE_LOCAL_DEFAULT_SCOPE, { kind: ownerKind, id: randomUUID() });
      expect(attempt.ok).toBe(false);
    }

    await releaseDispatchGate(CLAUDE_LOCAL_DEFAULT_SCOPE, owner);
  });

  it("runs the read-only check and the hello probe when the gate is free, releasing afterward", async () => {
    const adapter = findActiveServerAdapter("claude_local")!;

    const testEnvResult = await adapter.testEnvironment({ companyId: "c1", adapterType: "claude_local", config: {} });
    expect(fakeReadOnlyCheckCalls).toBe(1);
    expect(fakeHelloProbeCalls).toBe(1);
    expect(testEnvResult.status).toBe("pass");
    expect(testEnvResult.checks[0]?.code).toBe("claude_command_resolvable");

    const [row] = await db.select().from(dispatchGateState).where(eq(dispatchGateState.scopeKey, CLAUDE_LOCAL_DEFAULT_SCOPE));
    expect(row?.ownershipState).toBe("idle");
  });

  it("holds across two independently initialized gate module instances, each with its own Postgres connection — not one module-global binding", async () => {
    // vi.resetModules() forces the next dynamic import to re-evaluate
    // dispatch-gate.ts from scratch, giving it a private `_db` closure
    // distinct from this file's own top-level import and from the other
    // "instance" below. Each instance is wired to its own separately
    // opened postgres.js connection (still against the same physical
    // database) — if atomicity depended on a single shared in-memory
    // reference, one of these two independent instances would not see
    // the other's row lock and both launches would proceed.
    vi.resetModules();
    const instanceA = await import("../services/dispatch-gate.js");
    const dbConnA = createDb(tempDb!.connectionString);
    instanceA.setDispatchGateDb(dbConnA);

    vi.resetModules();
    const instanceB = await import("../services/dispatch-gate.js");
    const dbConnB = createDb(tempDb!.connectionString);
    instanceB.setDispatchGateDb(dbConnB);

    expect(instanceA.acquireDispatchGate).not.toBe(instanceB.acquireDispatchGate);
    expect(instanceA).not.toBe(instanceB);

    let launchCalls = 0;
    const launch = async () => {
      launchCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return "ok" as const;
    };

    const [resultA, resultB] = await Promise.all([
      instanceA.withDispatchGate(CLAUDE_LOCAL_DEFAULT_SCOPE, { kind: "instanceA", id: randomUUID() }, launch, {
        onBlocked: () => "blocked" as const,
      }),
      instanceB.withDispatchGate(CLAUDE_LOCAL_DEFAULT_SCOPE, { kind: "instanceB", id: randomUUID() }, launch, {
        onBlocked: () => "blocked" as const,
      }),
    ]);

    expect(launchCalls).toBe(1);
    expect([resultA, resultB].filter((r) => r === "ok")).toHaveLength(1);
    expect([resultA, resultB].filter((r) => r === "blocked")).toHaveLength(1);

    const [row] = await db.select().from(dispatchGateState).where(eq(dispatchGateState.scopeKey, CLAUDE_LOCAL_DEFAULT_SCOPE));
    expect(row?.ownershipState).toBe("idle");
  });

  it("keeps a quota block enforced after the recording instance is fully disposed and a brand-new instance/connection is initialized (restart simulation)", async () => {
    vi.resetModules();
    const instanceA = await import("../services/dispatch-gate.js");
    const dbConnA = createDb(tempDb!.connectionString);
    instanceA.setDispatchGateDb(dbConnA);

    const ownerA = { kind: "instanceA", id: randomUUID() };
    const acquiredA = await instanceA.acquireDispatchGate(CLAUDE_LOCAL_DEFAULT_SCOPE, ownerA);
    expect(acquiredA.ok).toBe(true);
    await instanceA.recordDispatchGateQuotaBlock(CLAUDE_LOCAL_DEFAULT_SCOPE, ownerA, {
      blockedUntil: new Date(Date.now() + 60_000),
      reason: "provider_quota",
      operatorResumeRequired: false,
    });

    // Fully dispose instance A: close its underlying Postgres connection
    // and drop every in-memory reference to it. Nothing about instance B
    // below reuses any state from instance A — this simulates a Paperclip
    // process restart between the block being recorded and the next
    // acquisition attempt.
    await (dbConnA as unknown as { $client: { end: () => Promise<void> } }).$client.end();

    vi.resetModules();
    const instanceB = await import("../services/dispatch-gate.js");
    const dbConnB = createDb(tempDb!.connectionString);
    instanceB.setDispatchGateDb(dbConnB);

    let launchCalls = 0;
    const result = await instanceB.withDispatchGate(
      CLAUDE_LOCAL_DEFAULT_SCOPE,
      { kind: "instanceB", id: randomUUID() },
      async () => {
        launchCalls += 1;
        return "ok" as const;
      },
      { onBlocked: () => "blocked" as const },
    );

    expect(result).toBe("blocked");
    expect(launchCalls).toBe(0);

    const [row] = await db.select().from(dispatchGateState).where(eq(dispatchGateState.scopeKey, CLAUDE_LOCAL_DEFAULT_SCOPE));
    expect(row?.blockedUntil).not.toBeNull();
    await resumeDispatchGate(CLAUDE_LOCAL_DEFAULT_SCOPE);
  });

  describe("resumeDispatchGate atomic idle-only guard", () => {
    it("clears only quota fields on an idle, quota-blocked row and preserves null owner identity", async () => {
      const owner = { kind: "adapter", id: randomUUID() };
      expect((await acquireDispatchGate(CLAUDE_LOCAL_DEFAULT_SCOPE, owner)).ok).toBe(true);
      await recordDispatchGateQuotaBlock(CLAUDE_LOCAL_DEFAULT_SCOPE, owner, {
        blockedUntil: new Date(Date.now() + 60_000),
        reason: "provider_quota",
        operatorResumeRequired: true,
      });

      const result = await resumeDispatchGate(CLAUDE_LOCAL_DEFAULT_SCOPE);
      expect(result).toEqual({ ok: true });

      const [row] = await db.select().from(dispatchGateState).where(eq(dispatchGateState.scopeKey, CLAUDE_LOCAL_DEFAULT_SCOPE));
      expect(row?.blockedUntil).toBeNull();
      expect(row?.operatorResumeRequired).toBe(false);
      expect(row?.blockReason).toBeNull();
      expect(row?.ownershipState).toBe("idle");
      expect(row?.ownerKind).toBeNull();
      expect(row?.ownerId).toBeNull();
    });

    it("refuses and changes nothing when ownership is active", async () => {
      const owner = { kind: "adapter", id: randomUUID() };
      expect((await acquireDispatchGate(CLAUDE_LOCAL_DEFAULT_SCOPE, owner)).ok).toBe(true);
      const futureBlock = new Date(Date.now() + 60_000);
      // Hypothetical stale quota fields seeded directly, to prove the atomic
      // guard rejects on ownershipState alone regardless of how the row got here.
      await db
        .update(dispatchGateState)
        .set({ blockedUntil: futureBlock, operatorResumeRequired: true, blockReason: "provider_quota" })
        .where(eq(dispatchGateState.scopeKey, CLAUDE_LOCAL_DEFAULT_SCOPE));

      const result = await resumeDispatchGate(CLAUDE_LOCAL_DEFAULT_SCOPE);
      expect(result).toEqual({ ok: false, reason: "not_idle", ownershipState: "active", ownerKind: owner.kind, ownerId: owner.id });

      const [row] = await db.select().from(dispatchGateState).where(eq(dispatchGateState.scopeKey, CLAUDE_LOCAL_DEFAULT_SCOPE));
      expect(row?.blockedUntil).not.toBeNull();
      expect(row?.operatorResumeRequired).toBe(true);
      expect(row?.ownershipState).toBe("active");
      expect(row?.ownerKind).toBe(owner.kind);
      expect(row?.ownerId).toBe(owner.id);
      await releaseDispatchGate(CLAUDE_LOCAL_DEFAULT_SCOPE, owner);
    });

    it("refuses and changes nothing when ownership is unknown", async () => {
      const owner = { kind: "adapter", id: randomUUID() };
      expect((await acquireDispatchGate(CLAUDE_LOCAL_DEFAULT_SCOPE, owner)).ok).toBe(true);
      await markDispatchGateUnknown(CLAUDE_LOCAL_DEFAULT_SCOPE, owner);
      await db
        .update(dispatchGateState)
        .set({ blockedUntil: new Date(Date.now() + 60_000), operatorResumeRequired: true, blockReason: "provider_quota" })
        .where(eq(dispatchGateState.scopeKey, CLAUDE_LOCAL_DEFAULT_SCOPE));

      const result = await resumeDispatchGate(CLAUDE_LOCAL_DEFAULT_SCOPE);
      expect(result).toEqual({ ok: false, reason: "not_idle", ownershipState: "unknown", ownerKind: owner.kind, ownerId: owner.id });

      const [row] = await db.select().from(dispatchGateState).where(eq(dispatchGateState.scopeKey, CLAUDE_LOCAL_DEFAULT_SCOPE));
      expect(row?.blockedUntil).not.toBeNull();
      expect(row?.ownershipState).toBe("unknown");
      expect(row?.ownerKind).toBe(owner.kind);
      expect(row?.ownerId).toBe(owner.id);
    });

    it("reports no matching gate state for a scope that was never created, without creating one", async () => {
      const missingScope = "claude_local/never-created";
      const result = await resumeDispatchGate(missingScope);
      expect(result).toEqual({ ok: false, reason: "not_found" });

      const [row] = await db.select().from(dispatchGateState).where(eq(dispatchGateState.scopeKey, missingScope));
      expect(row).toBeUndefined();
    });

    it("enforces the idle precondition atomically against a concurrent acquire, with no torn state", async () => {
      const seedOwner = { kind: "adapter", id: randomUUID() };
      expect((await acquireDispatchGate(CLAUDE_LOCAL_DEFAULT_SCOPE, seedOwner)).ok).toBe(true);
      await releaseDispatchGate(CLAUDE_LOCAL_DEFAULT_SCOPE, seedOwner);

      const owner = { kind: "adapter", id: randomUUID() };
      const [resumeResult, acquireResult] = await Promise.all([
        resumeDispatchGate(CLAUDE_LOCAL_DEFAULT_SCOPE),
        acquireDispatchGate(CLAUDE_LOCAL_DEFAULT_SCOPE, owner),
      ]);
      expect(acquireResult.ok).toBe(true);
      if (!resumeResult.ok) expect(resumeResult.reason).toBe("not_idle");

      const [row] = await db.select().from(dispatchGateState).where(eq(dispatchGateState.scopeKey, CLAUDE_LOCAL_DEFAULT_SCOPE));
      expect(row?.ownershipState).toBe("active");
      expect(row?.ownerKind).toBe(owner.kind);
      expect(row?.ownerId).toBe(owner.id);
      await releaseDispatchGate(CLAUDE_LOCAL_DEFAULT_SCOPE, owner);
    });
  });
});
