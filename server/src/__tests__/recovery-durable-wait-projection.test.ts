import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, agentWakeupRequests, approvals, companies, createDb, heartbeatRuns,
  issueApprovals, issueRecoveryActions, issueRelations, issueThreadInteractions, issues, type Db,
} from "@paperclipai/db";
import { collectDispositionRepairSourceState, readDispositionRepairDurableWaitingState } from "../services/recovery/disposition-repair.js";
import { recoveryService } from "../services/recovery/service.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_RECOVERY_ACTION_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
const pendingExecution = { status: "pending", currentStageId: null, currentStageIndex: null,
  currentStageType: null, currentParticipant: null, returnAssignee: null, completedStageIds: [],
  lastDecisionId: null, lastDecisionOutcome: null };

(support.supported ? describe : describe.skip)("recovery durable wait projection", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  beforeAll(async () => {
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("recovery-durable-wait-");
    db = createDb(external ?? temporary!.connectionString);
    db.$client.options.onnotice = () => {};
  }, 30_000);
  afterEach(async () => { vi.restoreAllMocks(); await db.execute(sql`truncate companies cascade`); });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Recovery", issuePrefix: `R${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Owner", role: "engineer", status: "idle" });
    const [issue] = await db.insert(issues).values({ companyId, title: "Source", status: "blocked", assigneeAgentId: agentId }).returning();
    const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issue.id,
      kind: "deliberate_wait_without_target", ownerType: "agent", ownerAgentId: agentId,
      cause: "deliberate_wait_without_target", fingerprint: "fixture", nextAction: "Decide",
      wakePolicy: { type: "bounded_recovery_owner" } }).returning();
    return { companyId, agentId, issue, action };
  }
  const enqueueWakeup = vi.fn(async () => { throw new Error("Unexpected recovery wake"); });

  it("ignores foreign, hidden and settled evidence, then sees a newly pending wait", async () => {
    const f = await fixture(), foreign = await fixture();
    const blockers = await db.insert(issues).values([
      { companyId: f.companyId, title: "Hidden", status: "todo", hiddenAt: new Date() },
      { companyId: f.companyId, title: "Done", status: "done" },
    ]).returning();
    await db.insert(issueRelations).values([
      ...blockers.map(blocker => ({ companyId: f.companyId, issueId: blocker.id, relatedIssueId: f.issue.id, type: "blocks" as const })),
      { companyId: f.companyId, issueId: foreign.issue.id, relatedIssueId: f.issue.id, type: "blocks" },
    ]);
    await db.insert(issueThreadInteractions).values([
      { companyId: foreign.companyId, issueId: f.issue.id, kind: "request_confirmation", status: "pending", payload: { version: 1, prompt: "Foreign" } },
      { companyId: f.companyId, issueId: f.issue.id, kind: "request_confirmation", status: "answered", payload: { version: 1, prompt: "Answered" } },
    ]);
    const [foreignApproval] = await db.insert(approvals).values({ companyId: foreign.companyId, type: "hire_agent", status: "pending", payload: {} }).returning();
    const [approved] = await db.insert(approvals).values({ companyId: f.companyId, type: "hire_agent", status: "approved", payload: {} }).returning();
    await db.insert(issueApprovals).values([
      { companyId: f.companyId, issueId: f.issue.id, approvalId: foreignApproval.id },
      { companyId: f.companyId, issueId: f.issue.id, approvalId: approved.id },
    ]);
    const read = () => readDispositionRepairDurableWaitingState(db, { issue: f.issue });
    expect(await read()).toEqual({ hasDurableWaitingPath: false, durablePathReason: null });
    const full = await collectDispositionRepairSourceState(db, { issue: f.issue });
    expect(full.hasDurableWaitingPath).toBe(false);
    await db.update(approvals).set({ status: "revision_requested" }).where(eq(approvals.id, approved.id));
    expect(await read()).toEqual({ hasDurableWaitingPath: true, durablePathReason: "approval" });
    expect((await collectDispositionRepairSourceState(db, { issue: f.issue })).fingerprint).not.toBe(full.fingerprint);
  });

  it.each(["user_owner", "blocker", "monitor", "execution_stage", "interaction", "approval"] as const)(
    "preserves %s precedence and resolves the original action without a wake", async reason => {
      const f = await fixture();
      const order = ["user_owner", "blocker", "monitor", "execution_stage", "interaction", "approval"];
      const priority = order.indexOf(reason);
      if (priority <= 0) await db.update(issues).set({ assigneeAgentId: null, assigneeUserId: "board" }).where(eq(issues.id, f.issue.id));
      if (priority <= 1) {
        const [blocker] = await db.insert(issues).values({ companyId: f.companyId, title: "Blocker", status: "todo" }).returning();
        await db.insert(issueRelations).values({ companyId: f.companyId, issueId: blocker.id, relatedIssueId: f.issue.id, type: "blocks" });
      }
      if (priority <= 2) await db.update(issues).set({ monitorNextCheckAt: new Date(Date.now() + 3_600_000) }).where(eq(issues.id, f.issue.id));
      if (priority <= 3) await db.update(issues).set({ executionState: pendingExecution }).where(eq(issues.id, f.issue.id));
      if (priority <= 4) await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issue.id,
        kind: "request_confirmation", status: "pending", payload: { version: 1, prompt: "Decide" } });
      const [approval] = await db.insert(approvals).values({ companyId: f.companyId, type: "hire_agent", status: "pending", payload: {} }).returning();
      await db.insert(issueApprovals).values({ companyId: f.companyId, issueId: f.issue.id, approvalId: approval.id });
      const [current] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
      const projected = await readDispositionRepairDurableWaitingState(db, { issue: current });
      expect(projected).toEqual({ hasDurableWaitingPath: true, durablePathReason: reason });
      expect(await collectDispositionRepairSourceState(db, { issue: current })).toMatchObject(projected);
      const result = await recoveryService(db, { enqueueWakeup }).reconcileActiveRecoveryActions({ companyId: f.companyId });
      expect(result.resolved).toBe(1);
      const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.action.id));
      expect(action).toMatchObject({ status: "resolved", ownerType: "agent", ownerAgentId: f.agentId,
        resolutionNote: `durable_path_restored:${reason}` });
    },
  );

  it("retains board-owned waits and same-action paths but accepts an independent path", async () => {
    const f = await fixture();
    await db.update(issueRecoveryActions).set({ ownerType: "board", ownerAgentId: null }).where(eq(issueRecoveryActions.id, f.action.id));
    await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issue.id,
      kind: "request_confirmation", status: "pending", payload: { version: 1, prompt: "Board" } });
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running",
      contextSnapshot: { issueId: f.issue.id, recoveryActionId: f.action.id } });
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "system", status: "queued",
      payload: { issueId: f.issue.id, recoveryActionId: f.action.id } });
    const service = recoveryService(db, { enqueueWakeup });
    expect((await service.reconcileActiveRecoveryActions({ companyId: f.companyId })).resolved).toBe(0);
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running", contextSnapshot: { taskId: f.issue.id } });
    expect((await service.reconcileActiveRecoveryActions({ companyId: f.companyId })).resolved).toBe(1);
  });

  it("keeps native reconciliation holds and resolves a board action through a healthy child", async () => {
    const held = await fixture(), parent = await fixture();
    await db.update(issueRecoveryActions).set({ ownerType: "board", ownerAgentId: null,
      cause: "native_workspace_finalization_owner_unverified" }).where(eq(issueRecoveryActions.id, held.action.id));
    await db.insert(heartbeatRuns).values({ companyId: held.companyId, agentId: held.agentId, status: "running", contextSnapshot: { issueId: held.issue.id } });
    const service = recoveryService(db, { enqueueWakeup });
    expect((await service.reconcileActiveRecoveryActions({ companyId: held.companyId })).resolved).toBe(0);
    await db.update(issueRecoveryActions).set({ ownerType: "board", ownerAgentId: null }).where(eq(issueRecoveryActions.id, parent.action.id));
    const [child] = await db.insert(issues).values({ companyId: parent.companyId, title: "Child", status: "todo",
      parentId: parent.issue.id, assigneeAgentId: parent.agentId }).returning();
    await db.insert(issueThreadInteractions).values({ companyId: parent.companyId, issueId: child.id,
      kind: "request_confirmation", status: "pending", payload: { version: 1, prompt: "Child decision" } });
    expect((await service.reconcileActiveRecoveryActions({ companyId: parent.companyId })).resolved).toBe(1);
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, parent.action.id));
    expect(action.resolutionNote).toBe("durable_path_restored:healthy_child");
    expect(await db.select().from(issueRelations).where(eq(issueRelations.relatedIssueId, parent.issue.id)))
      .toMatchObject([{ issueId: child.id, type: "blocks" }]);
    const [unchanged] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, held.action.id));
    expect(unchanged.status).toBe("active");
  });

  it.each([false, true])("reads late facts and preserves a concurrent action decision (%s)", async operatorResolves => {
    const f = await fixture();
    let started!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const execute = db.execute.bind(db), dialect = new PgDialect();
    const spy = vi.spyOn(db, "execute").mockImplementation(((query: Parameters<Db["execute"]>[0]) => {
      if (dialect.sqlToQuery(query as never).sql.includes('as "hasBlocker"')) {
        started(); return gate.then(() => execute(query));
      }
      return execute(query);
    }) as unknown as Db["execute"]);
    const running = recoveryService(db, { enqueueWakeup }).reconcileActiveRecoveryActions({ companyId: f.companyId });
    const operator = createDb(external ?? temporary!.connectionString, { maxConnections: 1 });
    try {
      await vi.waitFor(async () => { await ready; }, { timeout: 3_000 });
      await operator.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issue.id,
        kind: "request_confirmation", status: "pending", payload: { version: 1, prompt: "Late decision" } });
      if (operatorResolves) await operator.update(issueRecoveryActions).set({ status: "resolved", resolutionNote: "board_decision" }).where(eq(issueRecoveryActions.id, f.action.id));
      release(); const result = await running;
      const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.action.id));
      expect(action.resolutionNote).toBe(operatorResolves ? "board_decision" : "durable_path_restored:interaction");
      expect(result.resolved).toBe(operatorResolves ? 0 : 1);
    } finally { release(); await running; spy.mockRestore(); await operator.$client.end({ timeout: 1 }); }
  });
});
