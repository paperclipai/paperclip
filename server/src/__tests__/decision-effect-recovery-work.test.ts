import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, agents, applyPendingMigrations, authUsers, companies, companyMemberships, createDb, decisionEffectExecutions,
  decisions, decisionRetention, decisionTargetIssues, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { decisionService } from "../services/decisions.js";
import { decisionEffectRecoveryService } from "../services/decision-effect-recovery.js";
import { registerDecisionEffectRecoveryWork } from "../services/decision-effect-recovery-work.js";
import { registerDecisionContinuationWork } from "../services/decision-continuation-work.js";
import { writeDecisionChange } from "../services/decision-work-notifications.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { hashAttentionArchiveManifest } from "../services/decision-retention.js";
import type { AttentionArchiveManifestEntry } from "@paperclipai/shared";
import { idleWorkSnapshot } from "../services/task-admission.js";

const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_DECISION_EFFECTS_TEST_DATABASE_URL");
const support = externalUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("decision effect recovery worker", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let companyId: string, agentId: string, originId: string, targetId: string, runId: string, userId: string;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  let draining: boolean;
  let recovery: ReturnType<typeof decisionService>;
  const errors: unknown[] = [];
  const wake = vi.fn(async () => {});
  const service = () => decisionService(db, { wakeOriginAgent: wake });

  beforeAll(async () => {
    if (externalUrl) await applyPendingMigrations(externalUrl);
    else temporary = await startEmbeddedPostgresTestDatabase("decision-effects-");
    db = createDb(externalUrl ?? temporary!.connectionString, { maxConnections: 6, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
  }, 30_000);
  beforeEach(async () => {
    vi.stubEnv("PAPERCLIP_DECISION_SIGNING_SECRET", "0123456789abcdef0123456789abcdef");
    companyId = randomUUID(); agentId = randomUUID(); originId = randomUUID(); targetId = randomUUID(); runId = randomUUID(); userId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Recovery", issuePrefix: `R${companyId.slice(0, 6)}`, requireBoardApprovalForNewAgents: false });
    await db.insert(authUsers).values({ id: userId, name: "Decider", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Proposer", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(issues).values([
      { id: originId, companyId, title: "Origin", status: "in_progress", priority: "medium", assigneeAgentId: agentId, responsibleUserId: userId },
      { id: targetId, companyId, title: "Target", status: "todo", priority: "medium", responsibleUserId: userId },
    ]);
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", responsibleUserId: userId, contextSnapshot: { issueId: originId } });
    await Promise.all(Array.from({ length: 6 }, () => db.execute(sql`select pg_sleep(0.01)`)));
    draining = false; errors.length = 0; wake.mockReset();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"], shouldAdvanceTime: true });
  });
  afterEach(async () => {
    await coordinator?.stop(); coordinator = undefined;
    vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs();
    await db.execute(sql`drop trigger if exists decision_effect_finish_fail on decisions`);
    await db.execute(sql`drop function if exists decision_effect_finish_fail()`);
    await db.delete(decisionEffectExecutions); await db.delete(decisionTargetIssues); await db.delete(decisions);
    await db.delete(decisionRetention); await db.delete(activityLog); await db.delete(issueComments); await db.delete(heartbeatRuns);
    await db.delete(issues); await db.delete(agents); await db.delete(companyMemberships); await db.delete(authUsers); await db.delete(companies);
    expect(errors).toEqual([]);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });

  const actor = () => ({ type: "agent" as const, companyId, agentId, runId, source: "agent_jwt" as const,
    onBehalfOfUserId: userId, onBehalfOfMemberships: [{ companyId, membershipRole: "member", status: "active" }] });
  const board = () => ({ type: "board" as const, userId, companyIds: [companyId], source: "session" as const,
    memberships: [{ companyId, membershipRole: "member", status: "active" }] });
  const create = () => service().create({ companyId, agentId, runId, actor: actor(), title: "Comment?", body: "Body",
    continuationPolicy: "wake_origin_agent", options: [{ id: "yes", label: "Yes", effects: [
      { type: "comment_on_issue", targetIssueId: targetId, staleness: "lenient", bodyMarkdown: "hello" },
    ] }] });
  const decide = (id: string) => service().decide({ id, optionId: "yes", decidedByUserId: userId, userActor: board() });
  const claim = (id: string, updatedAt = new Date(), owner = db) => writeDecisionChange(owner, async tx => tx.update(decisions).set({
    status: "decided", executionStatus: "running", chosenOptionId: "yes", decidedByUserId: userId,
    updatedAt, inputValues: {}, metadata: { continuationPending: true },
  }).where(eq(decisions.id, id)));
  async function start() {
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => !draining, canReconcile: () => true,
      onError: error => errors.push(error) });
    await registerDecisionContinuationWork(coordinator, service(), () => !draining).ready;
    recovery = service();
    vi.spyOn(recovery, "recoverEffects");
    await registerDecisionEffectRecoveryWork(coordinator, recovery, () => !draining).ready;
  }
  async function quiet() {
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(idleWorkSnapshot().active).toBe(0); expect(coordinator!.nextWakeAt()).toBeNull();
    }, { timeout: 5000 });
    const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "update"), executes = vi.spyOn(db, "execute");
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); expect(executes).not.toHaveBeenCalled();
    reads.mockRestore(); writes.mockRestore(); executes.mockRestore();
  }
  async function settled(id: string, executionStatus = "succeeded") {
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await service().get(id)).toMatchObject({ executionStatus, metadata: { continuationPending: false } });
    }, { timeout: 5000 });
  }
  const comments = () => db.select().from(issueComments).where(eq(issueComments.issueId, targetId));
  async function failSettlement() {
    await db.execute(sql`create function decision_effect_finish_fail() returns trigger language plpgsql as $$ begin
      if OLD.execution_status = 'running' and NEW.execution_status <> 'running' then raise exception 'settlement unavailable'; end if;
      return NEW; end $$`);
    await db.execute(sql`create trigger decision_effect_finish_fail before update on decisions for each row execute function decision_effect_finish_fail()`);
  }

  it("stays quiet with open decisions and delivered history after a real decision", async () => {
    await start(); await quiet(); const row = await create(); await quiet();
    await decide(row.id); await quiet(); expect(await comments()).toHaveLength(1); expect(wake).toHaveBeenCalledTimes(1);
  });

  it("does not inspect effect recovery when an open decision is created", async () => {
    await start(); await quiet();
    const sweeps = vi.mocked(recovery.recoverEffects); sweeps.mockClear();
    await create(); await quiet();
    expect(sweeps).not.toHaveBeenCalled();
  });

  it("coalesces sequential committed cancellations without an idle recovery poll", async () => {
    const rows = [];
    for (let i = 0; i < 10; i++) rows.push(await create());
    // Freeze wall time while real SQL and transaction settlement continue.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"], shouldAdvanceTime: false });
    await start();
    const scans = vi.mocked(recovery.recoverEffects);
    expect(scans).toHaveBeenCalledTimes(1);
    for (const row of rows) {
      await service().cancel(row.id, { actorType: "user", actorId: userId });
      await vi.advanceTimersByTimeAsync(1);
      await db.execute(sql`select pg_sleep(0.01)`); // Allow each old scan to finish, rather than only testing overlap coalescing.
    }
    expect(scans).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(scans).toHaveBeenCalledTimes(2));
    await quiet();
    const count = scans.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(scans).toHaveBeenCalledTimes(count);
    expect(wake).toHaveBeenCalledTimes(10);
  });

  it("lets an already saved recovery deadline preempt notification coalescing", async () => {
    const due = await create(), cancelled = await create();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"], shouldAdvanceTime: false });
    const deadline = Date.now() + 500;
    await claim(due.id, new Date(deadline - 60_000));
    await start();
    expect(coordinator!.nextWakeAt()).toBe(deadline);
    await service().cancel(cancelled.id, { actorType: "user", actorId: userId });
    await vi.advanceTimersByTimeAsync(1);
    await db.execute(sql`select pg_sleep(0.01)`);
    expect(coordinator!.nextWakeAt()).toBe(deadline);
    await vi.advanceTimersByTimeAsync(499);
    await vi.waitFor(async () => expect(await comments()).toHaveLength(1));
    await settled(due.id); await quiet();
    expect(wake).toHaveBeenCalledTimes(2);
  });

  it("retries an old failure while newer due claims keep filling pages", async () => {
    const failed = await create(), healthy = await create();
    const at = Date.now() - 600_000;
    await claim(failed.id, new Date(at)); await claim(healthy.id, new Date(at + 1));
    // Preserve PostgreSQL precision at both ends of the first rotation.
    await db.execute(sql`update decisions set updated_at = updated_at + interval '456 microseconds'
      where id in (${failed.id}, ${healthy.id})`);
    const failure = new Error("temporary recovery failure");
    const attempts: string[] = [];
    const scan = decisionEffectRecoveryService(db, async id => {
      attempts.push(id);
      if (id === failed.id) throw failure;
      await db.update(decisions).set({ executionStatus: "succeeded" }).where(eq(decisions.id, id));
      return true;
    });
    await expect(scan.sweep(new Date(), 1)).rejects.toBe(failure);
    const added: string[] = [];
    for (let index = 0; index < 7; index++) {
      const row = await create(); added.push(row.id); await claim(row.id, new Date(at + index + 2));
      try { await scan.sweep(new Date(), 1); } catch (error) { expect(error).toBe(failure); }
    }
    expect(attempts).toHaveLength(8);
    expect(attempts.slice(0, 6)).toEqual([failed.id, healthy.id, failed.id, added[0], added[1], failed.id]);
    expect(new Set(attempts.filter(id => id !== failed.id)).size).toBe(5);
    expect((await service().get(failed.id))?.executionStatus).toBe("running");
  });

  it("reactivates from the actual claim and recovers a failed settlement without repeating the effect", async () => {
    await start(); await quiet(); const row = await create(); await failSettlement();
    await expect(decide(row.id)).rejects.toMatchObject({ cause: { message: "settlement unavailable" } });
    expect((await service().get(row.id))?.executionStatus).toBe("running"); expect(await comments()).toHaveLength(1);
    await db.execute(sql`drop trigger decision_effect_finish_fail on decisions`);
    await settled(row.id); await quiet(); expect(await comments()).toHaveLength(1); expect(wake).toHaveBeenCalledTimes(1);
  });

  it("reconstructs the saved grace deadline at restart and recovers a claimed effect", async () => {
    const row = await create(); const claimedAt = new Date(); await claim(row.id, claimedAt);
    await db.insert(decisionEffectExecutions).values({ decisionId: row.id, effectIndex: 0, effectType: "comment_on_issue", targetIssueId: targetId, status: "claimed" });
    await start(); expect(coordinator!.nextWakeAt()).toBe(claimedAt.getTime() + 60_000);
    await vi.advanceTimersByTimeAsync(30_000); expect(await comments()).toHaveLength(0);
    await settled(row.id); await quiet(); expect(await comments()).toHaveLength(1); expect(wake).toHaveBeenCalledTimes(1);
  });

  it("recovers at the exact grace boundary and preserves a zero grace override", async () => {
    const row = await create(), at = new Date(); await claim(row.id, at);
    expect(await service().recoverEffects(new Date(at.getTime() + 59_999))).toEqual({ resumed: 0 });
    expect(await service().recoverEffects(new Date(at.getTime() + 60_000))).toEqual({ resumed: 1 });
    vi.stubEnv("PAPERCLIP_DECISIONS_RECOVERY_GRACE_MS", "0");
    const second = await create(); await claim(second.id, at);
    expect(await service().recoverEffects(at)).toEqual({ resumed: 1 }); expect(await comments()).toHaveLength(2);
  });

  it("joins active foreground effects when their recovery deadline arrives", async () => {
    const row = await create(); await start();
    const effectKey = `decision-effect:${row.id}:0`;
    const previousDebug = db.$client.options.debug;
    let effectLockAttempts = 0;
    db.$client.options.debug = (_connection, query, parameters) => {
      if (query.includes("pg_advisory_xact_lock") && parameters.includes(effectKey)) effectLockAttempts++;
    };
    let release!: () => void, locked!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const lock = db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${effectKey}, 0))`);
      locked(); await gate;
    });
    let deciding: ReturnType<typeof decide> | undefined;
    let recovering: ReturnType<typeof recovery.recoverEffects> | undefined;
    try {
      await acquired;
      deciding = decide(row.id);
      await vi.waitFor(async () => expect((await service().get(row.id))?.executionStatus).toBe("running"));
      const claimed = (await service().get(row.id))!;
      const deadline = claimed.updatedAt.getTime() + 60_000;
      await vi.waitFor(async () => {
        const scheduled = coordinator!.nextWakeAt();
        if (scheduled !== null && scheduled < deadline) {
          await vi.advanceTimersByTimeAsync(Math.max(1, scheduled - Date.now()));
        }
        expect(coordinator!.nextWakeAt()).toBe(deadline);
      });
      await vi.waitFor(() => expect(effectLockAttempts).toBe(2)); // Test gate + foreground execution.
      const sweeps = vi.mocked(recovery.recoverEffects);
      const beforeDeadline = sweeps.mock.calls.length;
      await vi.advanceTimersByTimeAsync(Math.max(0, deadline - Date.now()));
      await vi.waitFor(() => expect(sweeps).toHaveBeenCalledTimes(beforeDeadline + 1));
      let recoverySettled = false;
      recovering = Promise.resolve(sweeps.mock.results[beforeDeadline].value).then(result => {
        recoverySettled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await comments()).toHaveLength(0); expect(wake).not.toHaveBeenCalled();
      expect(recoverySettled).toBe(false);
      expect(sweeps).toHaveBeenCalledTimes(beforeDeadline + 1);
      expect(effectLockAttempts).toBe(2);
      release();
      await lock; await deciding;
      await expect(recovering).resolves.toEqual({ resumed: 1 });
      await quiet();
      expect(effectLockAttempts).toBe(2);
      expect(await comments()).toHaveLength(1); expect(wake).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await Promise.allSettled([lock, deciding, recovering]);
      db.$client.options.debug = previousDebug;
    }
  });

  it("defers an outer transaction until commit and ignores rollback", async () => {
    const row = await create(); await start(); await quiet();
    await expect(db.transaction(async tx => {
      await claim(row.id, new Date(Date.now() - 120_000), tx as unknown as typeof db);
      await vi.advanceTimersByTimeAsync(120_000); expect(await comments()).toHaveLength(0); throw new Error("rollback");
    })).rejects.toThrow("rollback");
    await quiet(); expect((await service().get(row.id))?.status).toBe("open");
    await db.transaction(async tx => {
      await claim(row.id, new Date(Date.now() - 120_000), tx as unknown as typeof db);
      await vi.advanceTimersByTimeAsync(120_000); expect(await comments()).toHaveLength(0);
    });
    await settled(row.id); await quiet(); expect(await comments()).toHaveLength(1);
  });

  it("retains a first claim through drain without passive SQL", async () => {
    const row = await create(); await start(); await quiet(); draining = true;
    await claim(row.id, new Date(Date.now() - 120_000));
    const reads = vi.spyOn(db, "select"); await vi.advanceTimersByTimeAsync(120_000);
    expect(reads).not.toHaveBeenCalled(); reads.mockRestore();
    draining = false; await settled(row.id); await quiet(); expect(await comments()).toHaveLength(1);
  });

  it("retains a failed recovery through drain and does not replay the completed effect", async () => {
    const row = await create(); await claim(row.id, new Date(Date.now() - 120_000)); await failSettlement(); await start();
    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0)); draining = true;
    expect(await comments()).toHaveLength(1);
    const reads = vi.spyOn(db, "select"); await vi.advanceTimersByTimeAsync(120_000);
    expect(reads).not.toHaveBeenCalled(); reads.mockRestore();
    await db.execute(sql`drop trigger decision_effect_finish_fail on decisions`);
    draining = false; await settled(row.id); await quiet(); expect(await comments()).toHaveLength(1); expect(wake).toHaveBeenCalledTimes(1);
    for (const error of errors) expect(error).toMatchObject({ cause: { message: "settlement unavailable" } }); errors.length = 0;
  });

  it("rechecks current membership before executing a recovered effect", async () => {
    const row = await create(); await claim(row.id, new Date(Date.now() - 120_000));
    await db.update(companyMemberships).set({ status: "inactive" }).where(eq(companyMemberships.principalId, userId));
    await start(); await settled(row.id, "failed"); await quiet(); expect(await comments()).toHaveLength(0);
    const result = await service().outcome(row.id);
    expect(result.executions[0]?.error).toBe("deny_decision_intersection"); expect(wake).toHaveBeenCalledTimes(1);
  });

  it("leaves continuation failures to their owner after effect recovery finishes", async () => {
    const row = await create(); await claim(row.id, new Date(Date.now() - 120_000));
    wake.mockRejectedValueOnce(new Error("wake unavailable")); await start(); await settled(row.id); await quiet();
    expect(await comments()).toHaveLength(1); expect(wake).toHaveBeenCalledTimes(2);
    expect(errors.every(error => String(error).includes("wake unavailable"))).toBe(true); errors.length = 0;
  });

  it("does not expire overdue open decisions during effect recovery", async () => {
    const row = await create();
    await db.update(decisions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(decisions.id, row.id));
    expect(await service().recoverEffects()).toEqual({ resumed: 0 });
    expect(await service().get(row.id)).toMatchObject({ status: "open" });
    expect(await comments()).toHaveLength(0);
    expect(wake).not.toHaveBeenCalled();
    expect(await service().sweepTtlExpiry()).toEqual({ expired: 1 });
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it.each(["missing_decider", "missing_option"] as const)("settles %s as durable failure and then becomes quiet", async reason => {
    const row = await create(); await claim(row.id, new Date(Date.now() - 120_000));
    await db.update(decisions).set(reason === "missing_decider" ? { decidedByUserId: null } : { chosenOptionId: "missing" })
      .where(eq(decisions.id, row.id));
    expect(await service().recoverEffects()).toEqual({ resumed: 1 });
    expect(await service().get(row.id)).toMatchObject({ executionStatus: "failed", metadata: {
      effectRecoveryError: reason, continuationPending: false,
    } });
    expect(await comments()).toHaveLength(0);
    expect(await db.select().from(decisionEffectExecutions)).toHaveLength(0);
    const audit = await db.select().from(activityLog).where(eq(activityLog.action, "decision.recovery_failed"));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ companyId, actorType: "system", actorId: "decision-executor",
      entityId: row.id, details: { reason } });
    expect(wake).toHaveBeenCalledTimes(1);
    await start(); await quiet();
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("preserves completed effect receipts when a malformed outcome settles as partial", async () => {
    const row = await create(); await claim(row.id, new Date(Date.now() - 120_000));
    await db.update(decisions).set({ chosenOptionId: "missing" }).where(eq(decisions.id, row.id));
    const [receipt] = await db.insert(decisionEffectExecutions).values({ decisionId: row.id, effectIndex: 0,
      effectType: "comment_on_issue", targetIssueId: targetId, status: "executed", result: { preserved: true }, executedAt: new Date() }).returning();
    expect(await service().recoverEffects()).toEqual({ resumed: 1 });
    expect((await service().get(row.id))?.executionStatus).toBe("partial");
    expect(await db.select().from(decisionEffectExecutions)).toEqual([receipt]);
    expect(await comments()).toHaveLength(0);
    expect(wake).toHaveBeenCalledTimes(1);
    await start(); await quiet();
  });

  it("keeps malformed claims pending when their failure audit cannot commit", async () => {
    const row = await create(); await claim(row.id, new Date(Date.now() - 120_000));
    await db.update(decisions).set({ decidedByUserId: null }).where(eq(decisions.id, row.id));
    await db.execute(sql`create function decision_recovery_audit_fail() returns trigger language plpgsql as $$ begin
      if NEW.action = 'decision.recovery_failed' then raise exception 'recovery audit unavailable'; end if;
      return NEW; end $$`);
    await db.execute(sql`create trigger decision_recovery_audit_fail before insert on activity_log
      for each row execute function decision_recovery_audit_fail()`);
    try {
      await expect(service().recoverEffects()).rejects.toMatchObject({ cause: { message: "recovery audit unavailable" } });
      expect((await service().get(row.id))?.executionStatus).toBe("running");
      expect(await db.select().from(activityLog).where(eq(activityLog.action, "decision.recovery_failed"))).toHaveLength(0);
      expect(wake).not.toHaveBeenCalled();
    } finally {
      await db.execute(sql`drop trigger decision_recovery_audit_fail on activity_log`);
      await db.execute(sql`drop function decision_recovery_audit_fail()`);
    }
    expect(await service().recoverEffects()).toEqual({ resumed: 1 });
    expect((await service().get(row.id))?.executionStatus).toBe("failed");
    expect(wake).toHaveBeenCalledTimes(1);
    await start(); await quiet();
  });

  it("rechecks a malformed claim under lock before settling a concurrently repaired outcome", async () => {
    const row = await create(); const at = new Date(Date.now() - 120_000); await claim(row.id, at);
    await db.update(decisions).set({ chosenOptionId: "missing" }).where(eq(decisions.id, row.id));
    let release!: () => void, locked!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const repair = db.transaction(async tx => {
      await tx.select({ id: decisions.id }).from(decisions).where(eq(decisions.id, row.id)).for("update");
      locked(); await gate;
      await tx.update(decisions).set({ chosenOptionId: "yes", updatedAt: at }).where(eq(decisions.id, row.id));
    });
    const previousDebug = db.$client.options.debug;
    let attempts = 0;
    let pending: ReturnType<ReturnType<typeof decisionService>["recoverEffects"]> | undefined;
    try {
      await acquired;
      db.$client.options.debug = (_connection, query, parameters) => {
        if (query.includes("for update") && parameters.includes(row.id)) attempts++;
      };
      pending = service().recoverEffects();
      await vi.waitFor(() => expect(attempts).toBe(1));
      release(); await repair;
      expect(await pending).toEqual({ resumed: 0 });
      expect(await service().get(row.id)).toMatchObject({ executionStatus: "running", chosenOptionId: "yes" });
      expect(await db.select().from(activityLog).where(eq(activityLog.action, "decision.recovery_failed"))).toHaveLength(0);
      expect(wake).not.toHaveBeenCalled();
      expect(await service().recoverEffects()).toEqual({ resumed: 1 });
      expect(await comments()).toHaveLength(1); expect(wake).toHaveBeenCalledTimes(1);
    } finally {
      release(); await Promise.allSettled([repair, pending]); db.$client.options.debug = previousDebug;
    }
    await start(); await quiet();
  });

  it("settles invalid legacy claims without inventing authority or blocking later effects", async () => {
    vi.stubEnv("PAPERCLIP_DECISIONS_SWEEP_BATCH_SIZE", "1");
    const invalid = await create(), valid = await create();
    await claim(invalid.id, new Date(Date.now() - 180_000)); await claim(valid.id, new Date(Date.now() - 120_000));
    await db.update(decisions).set({ decidedByUserId: null }).where(eq(decisions.id, invalid.id));
    const recovery = service();
    expect(await recovery.recoverEffects()).toEqual({ resumed: 1 });
    expect(await comments()).toHaveLength(0);
    expect(await recovery.recoverEffects()).toEqual({ resumed: 1 }); expect(await comments()).toHaveLength(1);
    expect((await recovery.get(invalid.id))?.executionStatus).toBe("failed");
    expect(await recovery.nextEffectRecoveryAt()).toBeNull();
  });

  it("pages past unresolved claims using database timestamp precision", async () => {
    const pending = await create(), valid = await create();
    await claim(pending.id); await claim(valid.id, new Date(Date.now() - 120_000));
    await db.execute(sql`update decisions set updated_at = date_trunc('milliseconds', now() - interval '3 minutes')
      + interval '456 microseconds' where id = ${pending.id}`);
    const scan = decisionEffectRecoveryService(db, async id => {
      if (id === pending.id) return false;
      await decide(id); return true;
    });
    expect(await scan.sweep(new Date(), 1)).toEqual({ resumed: 0 });
    expect(await scan.sweep(new Date(), 1)).toEqual({ resumed: 1 });
    expect(await comments()).toHaveLength(1);
    expect((await service().get(pending.id))?.executionStatus).toBe("running");
    expect(await scan.next()).not.toBeNull();
    expect(await scan.sweep(new Date(), 1)).toEqual({ resumed: 0 });
    expect(await scan.sweep(new Date(), 1)).toEqual({ resumed: 0 });
    expect(await comments()).toHaveLength(1);
  });

  it.each([false, true])("preserves archive recovery semantics with prior committed archive: %s", async committed => {
    await db.update(issues).set({ status: "in_review", assigneeUserId: userId }).where(eq(issues.id, targetId));
    const activityAt = new Date("2026-04-01T00:00:00.000Z");
    await db.insert(decisionRetention).values({ companyId, sourceKind: "review", sourceId: targetId, sourceActivityAt: activityAt });
    const manifest: AttentionArchiveManifestEntry[] = [{ companyId, sourceKind: "review", sourceId: targetId,
      expectedVersion: 1, activityAt: activityAt.toISOString(), reason: "Archive" }];
    const row = await service().create({ companyId, actor: actor(), agentId, runId, title: "Archive?", body: "Exact set",
      continuationPolicy: "wake_origin_agent", options: [{ id: "archive", label: "Archive", effects: [] }],
      metadata: { kind: "attention_archive_proposal", manifestHash: hashAttentionArchiveManifest(manifest) },
      additionalTargetSnapshots: { [`attention:review:${targetId}`]: { status: "attention", assigneeAgentId: null,
        assigneeUserId: null, updatedAt: activityAt.toISOString(), attentionArchive: manifest[0] } } });
    if (committed) {
      await failSettlement();
      await expect(service().decide({ id: row.id, optionId: "archive", decidedByUserId: userId, userActor: board() }))
        .rejects.toMatchObject({ cause: { message: "settlement unavailable" } });
      await db.execute(sql`drop trigger decision_effect_finish_fail on decisions`);
    } else {
      await writeDecisionChange(db, async tx => tx.update(decisions).set({ status: "decided", executionStatus: "running",
        chosenOptionId: "archive", decidedByUserId: userId, updatedAt: new Date(Date.now() - 120_000),
        metadata: { ...row.metadata, continuationPending: true } }).where(eq(decisions.id, row.id)));
    }
    await start(); await settled(row.id, committed ? "failed" : "succeeded"); await quiet();
    const [retained] = await db.select().from(decisionRetention);
    expect(retained.archiveVersion).toBe(1); expect(retained.archivedAt).not.toBeNull();
    expect(wake).toHaveBeenCalledTimes(1);
    if (committed) expect((await service().get(row.id))?.metadata).toHaveProperty("archiveProposalError");
  });

  it("learns another claim written during delivery", async () => {
    const first = await create(), second = await create(); await claim(first.id, new Date(Date.now() - 120_000));
    wake.mockImplementationOnce(async () => { await claim(second.id); });
    await start(); await settled(first.id); await settled(second.id); await quiet();
    expect(await comments()).toHaveLength(2); expect(wake).toHaveBeenCalledTimes(2);
  });

  it("finishes the admitted recovery and leaves later claims for restart during shutdown", async () => {
    const first = await create(), second = await create();
    await claim(first.id, new Date(Date.now() - 180_000)); await claim(second.id, new Date(Date.now() - 120_000));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    wake.mockImplementationOnce(async () => gate);
    const starting = start(); let stopped = false; let stopping: Promise<void>;
    try {
      await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1));
      stopping = coordinator!.stop().then(() => { stopped = true; });
      await vi.advanceTimersByTimeAsync(60_000); expect(stopped).toBe(false);
    } finally { release(); }
    await starting; await stopping!; coordinator = undefined;
    expect(wake).toHaveBeenCalledTimes(1); expect(await comments()).toHaveLength(1);
    expect((await service().get(second.id))?.executionStatus).toBe("running");
    await start(); await quiet(); expect(await comments()).toHaveLength(2); expect(wake).toHaveBeenCalledTimes(2);
  });
});
