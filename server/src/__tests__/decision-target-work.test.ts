import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, agents, authUsers, companies, companyMemberships, createDb, subscribeDatabaseWork, decisionEffectExecutions,
  decisions, decisionRetention, decisionTargetIssues, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { decisionService } from "../services/decisions.js";
import { registerDecisionTargetWork } from "../services/decision-target-work.js";
import { registerDecisionContinuationWork } from "../services/decision-continuation-work.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { issueService } from "../services/issues.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { deleteCompany } from "../services/company-deletion.js";
import { notifyDecisionTargetIssueRemoval } from "../services/decision-targets.js";

const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_DECISION_TARGETS_TEST_DATABASE_URL");
const support = externalUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("decision target worker", () => {
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
    if (!externalUrl) temporary = await startEmbeddedPostgresTestDatabase("decision-targets-");
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
    await db.execute(sql`drop trigger if exists decision_target_expire_fail on decisions`);
    await db.execute(sql`drop function if exists decision_target_expire_fail()`);
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
  const create = (staleness: "strict" | "lenient" = "strict") => service().create({ companyId, agentId, runId, actor: actor(), title: "Comment?", body: "Body",
    continuationPolicy: "wake_origin_agent", options: [{ id: "yes", label: "Yes", effects: [
      { type: "comment_on_issue", targetIssueId: targetId, staleness, bodyMarkdown: "hello" },
    ] }] });
  async function start() {
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => !draining, canReconcile: () => true,
      onError: error => errors.push(error) });
    await registerDecisionContinuationWork(coordinator, service(), () => !draining).ready;
    recovery = service();
    await registerDecisionTargetWork(coordinator, recovery, () => !draining).ready;
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
  async function expired(id: string, expiredReason = "target_gone") {
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await service().get(id)).toMatchObject({ status: "expired", metadata: { continuationPending: false, expiredReason } });
    }, { timeout: 5000 });
  }
  async function failExpiry() {
    await db.execute(sql`create function decision_target_expire_fail() returns trigger language plpgsql as $$ begin
      if NEW.status = 'expired' then raise exception 'expiry unavailable'; end if;
      return NEW; end $$`);
    await db.execute(sql`create trigger decision_target_expire_fail before update on decisions for each row execute function decision_target_expire_fail()`);
  }

  const change = (status: "done" | "cancelled") => issueService(db).update(targetId, { status, actorUserId: userId });

  it("stays quiet with valid open decisions and wakes from the real terminal update", async () => {
    await start(); await quiet(); const row = await create(); await quiet();
    await change("done"); await expired(row.id, "target_completed"); await quiet(); expect(wake).toHaveBeenCalledTimes(1);
  });

  it("finishes startup paging across submillisecond expiry values", async () => {
    const seed = await create(); await db.delete(decisionTargetIssues); await db.delete(decisions);
    await db.insert(decisions).values(Array.from({ length: 101 }, () => ({ ...seed, id: randomUUID() })));
    await db.execute(sql`update decisions set expires_at = date_trunc('milliseconds', now() + interval '1 day') + interval '456 microseconds'`);
    const owner = service();
    await owner.sweepInvalidTargets();
    expect(owner.hasDecisionTargetWork()).toBe(true);
    await owner.sweepInvalidTargets();
    expect(owner.hasDecisionTargetWork()).toBe(false);
    expect(wake).not.toHaveBeenCalled();
  });

  it("reaches a deleted target behind a full page of valid startup decisions", async () => {
    const seed = await create(); await db.delete(decisionTargetIssues); await db.delete(decisions);
    const invalidId = "ffffffff-ffff-4fff-afff-ffffffffffff";
    const valid = Array.from({ length: 100 }, (_, index) => ({ ...seed,
      id: `01000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      options: [{ id: "yes", label: "Yes", effects: [{ type: "comment_on_issue" as const, targetIssueId: originId, staleness: "strict" as const, bodyMarkdown: "hello" }] }],
    }));
    await db.insert(decisions).values([...valid, { ...seed, id: invalidId }]);
    await db.insert(decisionTargetIssues).values({ companyId, decisionId: invalidId, issueId: targetId });
    const owner = service();
    await owner.sweepInvalidTargets();
    expect(owner.hasDecisionTargetWork()).toBe(true);
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.decisionTargets, (event, hints) => {
      if (event === "settled") owner.decisionTargetsChanged(hints);
    });
    try {
      await issueService(db).remove(targetId);
      expect(await owner.sweepInvalidTargets()).toEqual({ expired: 1 });
      expect((await owner.get(invalidId))?.metadata).toMatchObject({ expiredReason: "target_gone" });
      expect(owner.hasDecisionTargetWork()).toBe(false);
      expect(wake).toHaveBeenCalledTimes(1);
    } finally { unsubscribe(); }
  });

  it("fences new target references between deletion discovery and commit", async () => {
    let entered!: () => void, release!: () => void;
    const discovered = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const removing = db.transaction(async tx => {
      await notifyDecisionTargetIssueRemoval(tx, targetId);
      entered(); await gate;
      await tx.delete(issues).where(eq(issues.id, targetId));
    });
    let proposing: Promise<{ accepted: boolean }> | undefined;
    try {
      await discovered;
      proposing = create().then(() => ({ accepted: true }), () => ({ accepted: false }));
      await vi.waitFor(async () => {
        const blocked = await db.execute(sql`select pid from pg_stat_activity where datname = current_database()
          and pid <> pg_backend_pid() and wait_event_type = 'Lock' and query like '%decision_target_issues%'`);
        expect(blocked).toHaveLength(1);
      });
      release(); await removing;
      await expect(proposing).resolves.toEqual({ accepted: false });
      expect(await db.select().from(decisions)).toEqual([]);
      expect(wake).not.toHaveBeenCalled();
    } finally { release(); await Promise.allSettled([removing, ...(proposing ? [proposing] : [])]); }
  });

  it("does not signal target work for removal with no linked decisions", async () => {
    await create();
    const unrelatedId = randomUUID();
    await db.insert(issues).values({ id: unrelatedId, companyId, title: "Unrelated", status: "todo", responsibleUserId: userId });
    const settled = vi.fn();
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.decisionTargets, event => { if (event === "settled") settled(); });
    try { await issueService(db).remove(unrelatedId); expect(settled).not.toHaveBeenCalled(); }
    finally { unsubscribe(); }
  });

  it("does not launch global target work after deleting an empty company", async () => {
    const emptyCompanyId = randomUUID();
    await db.insert(companies).values({ id: emptyCompanyId, name: "Empty", issuePrefix: `E${emptyCompanyId.slice(0, 6)}` });
    const home = await mkdtemp(join(tmpdir(), "decision-target-company-"));
    vi.stubEnv("PAPERCLIP_HOME", home);
    const settled = vi.fn();
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.decisionTargets, event => { if (event === "settled") settled(); });
    try {
      expect(await deleteCompany(db, emptyCompanyId)).toMatchObject({ id: emptyCompanyId });
      expect(settled).not.toHaveBeenCalled();
    } finally { unsubscribe(); await rm(home, { recursive: true, force: true }); }
  });

  it("keeps lenient and intentional already-done proposals open and quiet", async () => {
    const lenient = await create("lenient"); await change("done"); const intentional = await create();
    await start(); await quiet();
    expect((await service().get(lenient.id))?.status).toBe("open");
    expect((await service().get(intentional.id))?.status).toBe("open"); expect(wake).not.toHaveBeenCalled();
  });

  it("expires a decision created after its target was cancelled", async () => {
    await change("cancelled"); await start(); await quiet(); const row = await create();
    await expired(row.id); await quiet(); expect(wake).toHaveBeenCalledTimes(1);
  });

  it("reacts to the real removal producer after target links cascade away", async () => {
    const row = await create(); await start(); await quiet(); await issueService(db).remove(targetId);
    expect(await db.select().from(decisionTargetIssues).where(eq(decisionTargetIssues.decisionId, row.id))).toHaveLength(0);
    await expired(row.id); await quiet(); expect(wake).toHaveBeenCalledTimes(1);
  });

  it.each(["cancelled", "deleted"] as const)("reconstructs %s target invalidation at startup", async action => {
    const row = await create();
    if (action === "deleted") await db.delete(issues).where(eq(issues.id, targetId));
    else await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, targetId));
    await start(); await expired(row.id); await quiet(); expect(wake).toHaveBeenCalledTimes(1);
  });

  it("includes a strict secondary effect reference in notification scope", async () => {
    const blockerId = randomUUID();
    await db.insert(issues).values({ id: blockerId, companyId, title: "Blocker", status: "todo", responsibleUserId: userId });
    const row = await service().create({ companyId, actor: actor(), agentId, runId, title: "Follow up?", body: "Body",
      continuationPolicy: "wake_origin_agent", options: [{ id: "yes", label: "Yes", effects: [
        { type: "create_issue", targetIssueId: targetId, staleness: "strict", draft: { title: "Next", blockedByIssueIds: [blockerId] } },
      ] }] });
    await start(); await quiet(); await issueService(db).update(blockerId, { status: "cancelled", actorUserId: userId });
    await expired(row.id); await quiet(); expect(wake).toHaveBeenCalledTimes(1);
  });

  it("waits for the last strict target to complete", async () => {
    const blockerId = randomUUID();
    await db.insert(issues).values({ id: blockerId, companyId, title: "Blocker", status: "todo", responsibleUserId: userId });
    const row = await service().create({ companyId, actor: actor(), agentId, runId, title: "Follow up?", body: "Body",
      continuationPolicy: "wake_origin_agent", options: [{ id: "yes", label: "Yes", effects: [
        { type: "create_issue", targetIssueId: targetId, staleness: "strict", draft: { title: "Next", blockedByIssueIds: [blockerId] } },
      ] }] });
    await start(); await quiet(); await change("done"); await quiet();
    expect((await service().get(row.id))?.status).toBe("open");
    await issueService(db).update(blockerId, { status: "done", actorUserId: userId });
    await expired(row.id, "target_completed"); await quiet(); expect(wake).toHaveBeenCalledTimes(1);
  });

  it("waits for the actual issue update's outer transaction and ignores rollback", async () => {
    const row = await create(); await start(); await quiet();
    await expect(db.transaction(async tx => {
      await issueService(db).update(targetId, { status: "cancelled", actorUserId: userId }, tx);
      await vi.advanceTimersByTimeAsync(120_000); expect(wake).not.toHaveBeenCalled(); throw new Error("rollback");
    })).rejects.toThrow("rollback");
    await quiet(); expect((await service().get(row.id))?.status).toBe("open");
    await db.transaction(async tx => {
      await issueService(db).update(targetId, { status: "cancelled", actorUserId: userId }, tx);
      await vi.advanceTimersByTimeAsync(120_000); expect(wake).not.toHaveBeenCalled();
    });
    await expired(row.id); await quiet(); expect(wake).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])("preserves a deletion mixed with a scoped hint in one transaction, deleteFirst=%s", async deleteFirst => {
    const row = await create(); const otherId = randomUUID();
    await db.insert(issues).values({ id: otherId, companyId, title: "Unrelated", status: "todo", responsibleUserId: userId });
    await start(); await quiet();
    await db.transaction(async tx => {
      const scoped = issueService(tx as unknown as typeof db);
      if (deleteFirst) await scoped.remove(targetId);
      await scoped.update(otherId, { status: "done", actorUserId: userId });
      if (!deleteFirst) await scoped.remove(targetId);
    });
    expect(await db.select().from(decisionTargetIssues).where(eq(decisionTargetIssues.decisionId, row.id))).toHaveLength(0);
    await expired(row.id); await quiet(); expect(wake).toHaveBeenCalledTimes(1);
  });

  it("retains a first target change through drain without passive SQL", async () => {
    const row = await create(); await start(); await quiet(); draining = true; await change("cancelled");
    await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(30_000); expect(idleWorkSnapshot().active).toBe(0); });
    expect(recovery.hasDecisionTargetWork()).toBe(true);
    expect(coordinator!.nextWakeAt()).not.toBeNull();
    const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "update"), executes = vi.spyOn(db, "execute");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); expect(executes).not.toHaveBeenCalled();
    expect(idleWorkSnapshot().active).toBe(0);
    reads.mockRestore(); writes.mockRestore(); executes.mockRestore();
    draining = false; await expired(row.id); await quiet(); expect(wake).toHaveBeenCalledTimes(1);
  });

  it("keeps a real uncommitted target write held during drain and releases only after commit", async () => {
    const row = await create(); await start(); await quiet(); draining = true;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const writing = db.transaction(async tx => {
      await issueService(db).update(targetId, { status: "cancelled", actorUserId: userId }, tx);
      entered(); await gate;
    });
    try {
      await ready; await vi.advanceTimersByTimeAsync(120_000);
      expect(idleWorkSnapshot().active).toBeGreaterThan(0);
      expect((await service().get(row.id))?.status).toBe("open"); expect(wake).not.toHaveBeenCalled();
    } finally { release(); await writing; }
    await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(30_000); expect(idleWorkSnapshot().active).toBe(0); });
    expect(recovery.hasDecisionTargetWork()).toBe(true);
    draining = false; await expired(row.id); await quiet(); expect(wake).toHaveBeenCalledTimes(1);
  });

  it("checks current state if a cancelled target reopened before reconciliation", async () => {
    const row = await create(); await start(); await quiet(); draining = true; await change("cancelled");
    await issueService(db).update(targetId, { status: "todo", actorUserId: userId });
    draining = false; await quiet(); expect((await service().get(row.id))?.status).toBe("open"); expect(wake).not.toHaveBeenCalled();
  });

  it("retains failed expiry through drain and retries after the database recovers", async () => {
    const row = await create(); await start(); await quiet(); await failExpiry(); await change("cancelled");
    await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(30_000); expect(errors.length).toBeGreaterThan(0); });
    draining = true;
    await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(30_000); expect(idleWorkSnapshot().active).toBe(0); });
    expect(recovery.hasDecisionTargetWork()).toBe(true);
    expect(coordinator!.nextWakeAt()).not.toBeNull();
    const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "update"), executes = vi.spyOn(db, "execute");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); expect(executes).not.toHaveBeenCalled();
    expect(idleWorkSnapshot().active).toBe(0);
    reads.mockRestore(); writes.mockRestore(); executes.mockRestore();
    await db.execute(sql`drop trigger decision_target_expire_fail on decisions`);
    draining = false; await expired(row.id); await quiet(); expect(wake).toHaveBeenCalledTimes(1);
    for (const error of errors) expect(error).toMatchObject({ cause: { message: "expiry unavailable" } }); errors.length = 0;
  });

  it("does not inspect unrelated open decisions on an ordinary scoped change", async () => {
    const unrelated = await create();
    const otherId = randomUUID(); await db.insert(issues).values({ id: otherId, companyId, title: "Other", status: "todo", responsibleUserId: userId });
    const affected = await service().create({ companyId, actor: actor(), agentId, runId, title: "Other?", body: "Body",
      continuationPolicy: "wake_origin_agent", options: [{ id: "yes", label: "Yes", effects: [
        { type: "comment_on_issue", targetIssueId: otherId, staleness: "strict", bodyMarkdown: "hello" },
      ] }] });
    await start(); await quiet();
    await db.update(decisions).set({ options: sql`'null'::jsonb` }).where(eq(decisions.id, unrelated.id));
    await issueService(db).update(otherId, { status: "cancelled", actorUserId: userId });
    await expired(affected.id); await quiet(); expect(wake).toHaveBeenCalledTimes(1);
  });

  it("bounds startup pages and continues after more than one page of valid decisions", async () => {
    const seed = await create(); await db.delete(decisionTargetIssues); await db.delete(decisions);
    await db.insert(decisions).values(Array.from({ length: 101 }, () => ({ ...seed, id: randomUUID() })));
    await start(); expect(recovery.hasDecisionTargetWork()).toBe(true);
    await quiet(); expect(await db.select().from(decisions).where(eq(decisions.status, "open"))).toHaveLength(101);
    expect(wake).not.toHaveBeenCalled();
  });

  it("continues past a failing first page and retains its failed candidate", async () => {
    const seed = await create(); await db.delete(decisionTargetIssues); await db.delete(decisions);
    const ids = Array.from({ length: 101 }, (_, i) => `12000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    await db.insert(decisions).values(ids.map(id => ({ ...seed, id })));
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, targetId));
    await db.execute(sql`create function decision_target_expire_fail() returns trigger language plpgsql as $$ begin
      if NEW.id = '12000000-0000-4000-8000-000000000000' and NEW.status = 'expired' then raise exception 'expiry unavailable'; end if;
      return NEW; end $$`);
    await db.execute(sql`create trigger decision_target_expire_fail before update on decisions for each row execute function decision_target_expire_fail()`);
    await start(); expect(wake).toHaveBeenCalledTimes(99); expect((await service().get(ids.at(-1)!))?.status).toBe("open");
    await expired(ids.at(-1)!); expect((await service().get(ids[0]))?.status).toBe("open");
    await db.execute(sql`drop trigger decision_target_expire_fail on decisions`);
    await expired(ids[0]); await quiet(); expect(wake).toHaveBeenCalledTimes(101);
    for (const error of errors) expect(error).toMatchObject({ cause: { message: "expiry unavailable" } }); errors.length = 0;
  });

  it("retains a change to the same issue scope while its earlier pass is still running", async () => {
    await change("done"); const intentional = await create();
    await db.update(decisions).set({ expiresAt: new Date(Date.now() + 24 * 60 * 60_000) }).where(eq(decisions.id, intentional.id));
    await issueService(db).update(targetId, { status: "todo", actorUserId: userId });
    const ordinary = await create(); await start(); await quiet();
    wake.mockImplementationOnce(async () => { await change("cancelled"); });
    await change("done"); await expired(ordinary.id, "target_completed"); await expired(intentional.id); await quiet();
    expect(wake).toHaveBeenCalledTimes(2);
  });

  it("learns a decision created during invalidation delivery", async () => {
    const first = await create(); await change("cancelled"); let nextId = "";
    wake.mockImplementationOnce(async () => { nextId = (await create()).id; });
    await start(); await expired(first.id); await vi.waitFor(() => expect(nextId).not.toBe(""));
    await expired(nextId); await quiet(); expect(wake).toHaveBeenCalledTimes(2);
  });

  it("finishes admitted invalidation and leaves later rows for restart during shutdown", async () => {
    const first = await create(), second = await create(); await change("cancelled");
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    wake.mockImplementationOnce(async () => gate);
    const starting = start(); let stopped = false; let stopping: Promise<void>;
    try {
      await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1));
      stopping = coordinator!.stop().then(() => { stopped = true; });
      await vi.advanceTimersByTimeAsync(60_000); expect(stopped).toBe(false);
    } finally { release(); }
    await starting; await stopping!; coordinator = undefined;
    expect(wake).toHaveBeenCalledTimes(1);
    const states = await Promise.all([service().get(first.id), service().get(second.id)]);
    expect(states.map(row => row!.status).sort()).toEqual(["expired", "open"]);
    await start(); await quiet(); expect(wake).toHaveBeenCalledTimes(2);
  });
});
