import { readSystemRecovery, failSystemRecovery, SystemRecoveryFailure } from "./system-recovery-state.js";
import { adoptSystemRecovery } from "./system-recovery.js";
import { requestTaskRetry } from "./task-retry.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { heartbeatRuns, issueComments, issueRecoveryActions, agentWakeupRequests } from "@paperclipai/db";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { nativeWorkspaceFinalizationLockKey } from "./native-runtime/native-workspace-finalization-ownership.js";
import { recoverRetainedWorkspace, requestWorkspaceRecovery, reconcileRetainedWorkspaces } from "./workspace-recovery.js";
import { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { registerWorkspaceRecoveryWork } from "./workspace-recovery-work.js";
import { readWorkspaceRecovery } from "./workspace-recovery-receipt.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { useWorkspaceRecoveryFixture, action, db, seed } from "./__tests__/workspace-recovery-fixture.js";
const targets = vi.hoisted(() => new Map<string, AdapterSandboxExecutionTarget>());
vi.mock("./environment-execution-target.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./environment-execution-target.js")>();
  return { ...actual, resolveEnvironmentExecutionTarget: async (input: Parameters<typeof actual.resolveEnvironmentExecutionTarget>[0]) =>
    (input.leaseId ? targets.get(input.leaseId) : undefined) ?? actual.resolveEnvironmentExecutionTarget(input) };
});

describe("automatic retained workspace recovery", () => {
  useWorkspaceRecoveryFixture(targets);

  it("hands an exhausted system export repair to the board instead of leaving it system-owned", async () => {
    // Regression: the bounded export budget ran out, but the action stayed active and
    // system-owned for hours. The board saw no owner, and replies started nothing.
    const f = await seed();
    await adoptSystemRecovery(db, f);
    const before = await action(f.actionId);
    const adopted = readSystemRecovery(before.evidence)!;
    const now = Date.now();
    await db.update(issueRecoveryActions).set({ cause: "native_workspace_sync_out_retry_exhausted",
      nextAction: "Finalization retry budget exhausted. Retry workspace export and merge from the retained sandbox; do not submit another provider turn.",
      evidence: { ...before.evidence, systemRecovery: { ...adopted, revision: adopted.revision + 1, phase: "preserve_files",
        state: "scheduled", attempts: 6, retriesUsed: 5, firstFailureAt: now - 3_600_000, deadlineAt: now - 1_000, nextAttemptAt: null,
        failure: { code: "export_interrupted", retryClass: "retry_transient", evidenceFingerprint: "f".repeat(64) } } } })
      .where(eq(issueRecoveryActions.id, f.actionId));
    await recoverRetainedWorkspace(f.input);
    const exhausted = await action(f.actionId);
    expect(readSystemRecovery(exhausted.evidence)?.state).toBe("exhausted");
    expect(exhausted).toMatchObject({ status: "active", ownerType: "board" });
    expect(exhausted.nextAction).toMatch(/stopped after 6 attempts/);
    const blocker = await getExecutionBlocker(db, f.companyId, f.issueId);
    expect(blocker?.workspaceRecovery).toMatchObject({ status: "blocked", canRetry: true });
    expect(blocker?.nextAction).toMatch(/Retry to try again/);
    expect(blocker?.nextAction).not.toMatch(/send a (new )?message/i);
    // Nothing physical or provider-facing ran after the budget was spent.
    expect(f.runtime.resumeRunLease).not.toHaveBeenCalled();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
    // The board's Retry starts one new bounded system generation.
    await requestWorkspaceRecovery({ ...f.input, idempotencyKey: randomUUID(), actorId: "board" });
    const retried = await action(f.actionId);
    expect(retried.ownerType).toBe("system");
    expect(readSystemRecovery(retried.evidence)).toMatchObject({ state: "scheduled", attempts: 0 });
  }, 30_000);

  it("hands a repair that was already exhausted and system-owned to the board without another attempt", async () => {
    const f = await seed();
    await adoptSystemRecovery(db, f);
    const before = await action(f.actionId);
    const spent = failSystemRecovery({ ...readSystemRecovery(before.evidence)!, attempts: 6, retriesUsed: 5 },
      new SystemRecoveryFailure("export_interrupted", "retry_transient"));
    expect(spent.state).toBe("exhausted");
    await db.update(issueRecoveryActions).set({ cause: "native_workspace_sync_out_retry_exhausted", ownerType: "system",
      evidence: { ...before.evidence, systemRecovery: spent,
        workspaceRecovery: { ...readWorkspaceRecovery(before.evidence)!, status: "blocked", attempt: 6, retryable: true } } })
      .where(eq(issueRecoveryActions.id, f.actionId));
    await recoverRetainedWorkspace(f.input);
    const handed = await action(f.actionId);
    expect(handed).toMatchObject({ status: "active", ownerType: "board" });
    expect(readSystemRecovery(handed.evidence)).toEqual(spent);
    expect((await getExecutionBlocker(db, f.companyId, f.issueId))?.nextAction).toMatch(/Retry to try again/);
    expect(f.runtime.resumeRunLease).not.toHaveBeenCalled();
    // Repeat sweeps are idempotent and still grant no attempt.
    await recoverRetainedWorkspace(f.input);
    expect(readSystemRecovery((await action(f.actionId)).evidence)).toEqual(spent);
  }, 30_000);

  it("reconstructs a resolved files-only preservation obligation at startup without replay", async () => {
    const f = await seed("legacy");
    await adoptSystemRecovery(db, f);
    const before = await action(f.actionId);
    const automaticRecovery = { policy: "preserve_without_replay_v1", runId: f.runId, replay: "blocked" };
    await db.update(issueRecoveryActions).set({ status: "resolved", outcome: "blocked",
      evidence: { ...before.evidence, automaticRecovery } }).where(eq(issueRecoveryActions.id, f.actionId));
    const errors = vi.fn();
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true, onError: errors });
    const worker = registerWorkspaceRecoveryWork(db, coordinator, f.environmentRuntime, async () => {});
    try {
      await worker.ready;
      await expect.poll(async () => readSystemRecovery((await action(f.actionId)).evidence)?.state,
        { timeout: 20_000 }).toBe("complete");
      expect((await action(f.actionId)).evidence.automaticRecovery).toEqual(automaticRecovery);
      expect(f.runtime.resumeRunLease.mock.calls.filter(([input]) => input.lease.id === f.lease.id)).toHaveLength(1);
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
      expect(errors).not.toHaveBeenCalled();
    } finally { await coordinator.stop(); await worker.stop(); }
  }, 30_000);

  it("fills a free export slot across the candidate cursor while another export is held and joins both at shutdown", async () => {
    const orderedSeed = async (position: number) => {
      const fixture = await seed();
      const id = `00000002-000${position}-4000-8000-${randomUUID().slice(-12)}` as const;
      await db.update(issueRecoveryActions).set({ id }).where(eq(issueRecoveryActions.id, fixture.actionId));
      fixture.actionId = id; fixture.input.actionId = id;
      return fixture;
    };
    const held = await orderedSeed(2);
    const fixtures = [held];
    const runtimeFor = (runId: string) => fixtures.find(fixture => fixture.runId === runId)!.environmentRuntime;
    const runtime = { ...held.environmentRuntime,
      resumeWorkspaceRecoveryLease: (input: Parameters<typeof held.environmentRuntime.resumeWorkspaceRecoveryLease>[0]) =>
        runtimeFor(input.source.runId).resumeWorkspaceRecoveryLease(input),
      retryPendingSandboxTeardown: (input: Parameters<typeof held.environmentRuntime.retryPendingSandboxTeardown>[0]) =>
        runtimeFor(input.lease.heartbeatRunId!).retryPendingSandboxTeardown(input),
    };
    let active = 0, maximum = 0, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const countExport = (fixture: typeof held, pause = false) => {
      const resume = fixture.runtime.resumeRunLease.getMockImplementation()!;
      fixture.runtime.resumeRunLease.mockImplementation(async input => {
        active += 1; maximum = Math.max(maximum, active);
        try { if (pause) await gate; return await resume(input); } finally { active -= 1; }
      });
    };
    countExport(held, true);
    const errors = vi.fn();
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: errors });
    const worker = registerWorkspaceRecoveryWork(db, coordinator, runtime, async () => {});
    try {
      await expect.poll(() => held.runtime.resumeRunLease.mock.calls.length, { timeout: 20_000 }).toBe(1);
      // Start the middle candidate only after the highest candidate occupies
      // one slot. The next producer then sorts before that saved cursor.
      const fast = await orderedSeed(1); fixtures.push(fast); countExport(fast);
      await requestTaskRetry({ db, companyId: fast.companyId, issueId: fast.issueId, actorId: "board",
        observedRunId: fast.runId, idempotencyKey: randomUUID() });
      await expect.poll(async () => readSystemRecovery((await action(fast.actionId)).evidence)?.state,
        { timeout: 20_000 }).toBe("complete");
      const third = await orderedSeed(0); fixtures.push(third); countExport(third);
      await requestTaskRetry({ db, companyId: third.companyId, issueId: third.issueId, actorId: "board",
        observedRunId: third.runId, idempotencyKey: randomUUID() });
      await expect.poll(async () => readSystemRecovery((await action(third.actionId)).evidence)?.state,
        { timeout: 20_000 }).toBe("complete");
      expect(readSystemRecovery((await action(held.actionId)).evidence)?.state).toBe("running");
      expect(maximum).toBeLessThanOrEqual(2);
      expect(await readFile(path.join(third.host, "saved.txt"), "utf8")).toBe("finished work\n");
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, third.companyId))).toHaveLength(1);
      let stopped = false;
      const stopping = Promise.all([coordinator.stop(), worker.stop()]).then(() => { stopped = true; });
      await Promise.resolve(); expect(stopped).toBe(false);
      release(); await stopping;
      expect(readSystemRecovery((await action(held.actionId)).evidence)?.state).toBe("complete");
      expect(errors).not.toHaveBeenCalled();
    } finally { release(); await coordinator.stop(); await worker.stop(); }
  }, 60_000);

  it("rotates past due sources whose physical locks belong to other workers", async () => {
    const blocked = [await seed(), await seed()], available = await seed();
    for (const [index, fixture] of [...blocked, available].entries()) {
      await adoptSystemRecovery(db, fixture);
      const id = `00000001-000${index}-4000-8000-${randomUUID().slice(-12)}` as const;
      await db.update(issueRecoveryActions).set({ id }).where(eq(issueRecoveryActions.id, fixture.actionId));
      fixture.actionId = id; fixture.input.actionId = id;
    }
    let unlock!: () => void;
    const gate = new Promise<void>(resolve => { unlock = resolve; });
    const held = blocked.map(fixture => {
      let ready!: () => void;
      const acquired = new Promise<void>(resolve => { ready = resolve; });
      const lock = db.transaction(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${nativeWorkspaceFinalizationLockKey(fixture.companyId, fixture.runId)}, 0))`);
        ready(); await gate;
      });
      return { acquired, lock };
    });
    try {
      await Promise.all(held.map(item => item.acquired));
      await Promise.all(await reconcileRetainedWorkspaces(db, available.environmentRuntime, async () => {}, true) ?? []);
      expect(blocked.every(fixture => fixture.runtime.resumeRunLease.mock.calls.length === 0)).toBe(true);
      await Promise.all(await reconcileRetainedWorkspaces(db, available.environmentRuntime, async () => {}, true) ?? []);
      expect(readSystemRecovery((await action(available.actionId)).evidence)?.state).toBe("complete");
      expect(await readFile(path.join(available.host, "saved.txt"), "utf8")).toBe("finished work\n");
      expect(blocked.every(fixture => fixture.runtime.resumeRunLease.mock.calls.length === 0)).toBe(true);
    } finally { unlock(); await Promise.all(held.map(item => item.lock)); }
  }, 30_000);

  it("adopts only the exact historical infrastructure notice, preserving prose and user-action notices", async () => {
    const f = await seed("legacy", false);
    const metadata = { version: 1 as const, sourceRunId: f.runId,
      sections: [{ rows: [{ type: "key_value" as const, label: "Recovery action", value: f.actionId }] }] };
    const base = { companyId: f.companyId, issueId: f.issueId, body: "Original technical history",
      authorType: "system" as const, presentation: { kind: "system_notice" as const, tone: "danger" as const,
        title: "Recovery needs attention", detailsDefaultOpen: false }, metadata };
    const comments = await db.insert(issueComments).values([
      base,
      { ...base, authorType: "user", authorUserId: "board" },
      { ...base, metadata: { ...metadata, sourceRunId: randomUUID() } },
      { ...base, metadata: { ...metadata, recoveryResponsibility: "user" as const } },
    ]).returning();
    await adoptSystemRecovery(db, f);
    await adoptSystemRecovery(db, f);
    const rows = await db.select().from(issueComments).where(eq(issueComments.companyId, f.companyId));
    expect(rows.find(row => row.id === comments[0].id)?.metadata?.recoveryResponsibility).toBe("system");
    for (const original of comments.slice(1)) {
      expect(rows.find(row => row.id === original.id)?.metadata).toEqual(original.metadata);
    }
    expect(rows.every(row => row.body === base.body)).toBe(true);
  });

});
