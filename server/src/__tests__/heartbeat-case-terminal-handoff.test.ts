import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { activityLog, agents, agentWakeupRequests, authUsers, caseAccessSources, caseEvents, caseHandoffs, cases,
  companies, companyMemberships, createDb, heartbeatRuns, issues, toolActionRequests, toolInvocations, type Db } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { issueService } from "../services/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { caseHandoffDeliveryService } from "../services/case-handoff-delivery.js";
import { completeTerminalCaseHandoffsForIssue } from "../services/heartbeat/case-handoff-lifecycle.js";

describe("terminal case handoff follows accepted task completion", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("case-terminal-handoff-");
    db = createDb(temporary.connectionString);
  });
  afterAll(async () => { await temporary?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), otherAgentId = randomUUID(), issueId = randomUUID(),
      caseId = randomUUID(), handoffId = randomUUID(), userId = randomUUID(), runId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Operator", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Terminal factory", issuePrefix: `T${companyId.slice(0, 6)}`,
      defaultResponsibleUserId: userId });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "owner" });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Builder", role: "ceo", status: "idle", adapterType: "process" },
      { id: otherAgentId, companyId, name: "Other", role: "engineer", status: "idle", adapterType: "process", reportsTo: agentId },
    ]);
    await db.insert(issues).values({ id: issueId, companyId, title: "Verify a receipt", status: "in_progress",
      assigneeAgentId: agentId, responsibleUserId: userId });
    // The original execution may already be settled when a reviewer/human
    // accepts completion. Its persisted provenance must remain sufficient.
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "succeeded", runtimeMode: "legacy",
      responsibleUserId: userId, finishedAt: new Date(), contextSnapshot: { issueId } });
    await db.insert(cases).values({ id: caseId, companyId, caseNumber: 1, identifier: `CASE-${caseId}`, caseType: "work",
      title: "Verify a receipt", status: "in_progress", workIssueId: issueId, phase: "verification", handoffVersion: 2 });
    await db.insert(caseAccessSources).values({ companyId, caseId, sourceKind: "issue", sourceId: issueId });
    await db.insert(caseHandoffs).values({ id: handoffId, companyId, caseId, issueId, version: 2,
      fromAgentId: agentId, destinationKind: "done", toAgentId: null, phase: "done", instructions: "Receipt verified; finish normally.",
      actorType: "agent", actorId: agentId, sourceRunId: runId, responsibleUserId: userId,
      expectedIssueStatusVersion: 0, wakeupRequestId: randomUUID(), idempotencyKey: "finish", inputFingerprint: "fixture",
      state: "awaiting_completion" });
    return { companyId, agentId, otherAgentId, issueId, caseId, handoffId, userId, runId };
  }

  async function read(f: Awaited<ReturnType<typeof fixture>>) {
    const [[issue], [caseRow], [handoff]] = await Promise.all([
      db.select().from(issues).where(eq(issues.id, f.issueId)),
      db.select().from(cases).where(eq(cases.id, f.caseId)),
      db.select().from(caseHandoffs).where(eq(caseHandoffs.id, f.handoffId)),
    ]);
    return { issue, caseRow, handoff };
  }

  it("does not wake, yield or close the case before ordinary task completion", async () => {
    const f = await fixture();
    await instanceSettingsService(db).updateExperimental({ enableCases: true });
    const worker = caseHandoffDeliveryService(db, { heartbeat: heartbeatService(db) });
    expect(await worker.hasPending()).toBe(false);
    expect(await worker.sweepPending()).toEqual({ examined: 0 });
    await db.transaction(async transaction => {
      const tx = transaction as unknown as Db;
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, f.issueId)).for("update");
      expect(await completeTerminalCaseHandoffsForIssue(tx, f)).toBe(0);
    });
    expect(await read(f)).toMatchObject({ issue: { status: "in_progress" }, caseRow: { status: "in_progress", phase: "verification" },
      handoff: { state: "awaiting_completion", completedAt: null, attemptCount: 0 } });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
  });

  it("closes exactly once in the accepted completion transaction, even after Cases is disabled", async () => {
    const f = await fixture();
    await instanceSettingsService(db).updateExperimental({ enableCases: false });
    await issueService(db).update(f.issueId, { status: "done", actorUserId: f.userId });
    const first = await read(f);
    expect(first).toMatchObject({ issue: { status: "done" }, caseRow: { status: "done", phase: "done", completedAt: expect.any(Date) },
      handoff: { state: "completed", completedAt: expect.any(Date), deliveredAt: null } });
    await issueService(db).update(f.issueId, { status: "done", actorUserId: f.userId });
    expect((await read(f)).handoff.completedAt).toEqual(first.handoff.completedAt);
    expect(await db.select().from(caseEvents).where(and(eq(caseEvents.caseId, f.caseId), eq(caseEvents.kind, "handoff_completed")))).toHaveLength(1);
    expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, f.caseId), eq(activityLog.action, "case.handoff_completed")))).toHaveLength(1);
  });

  it("survives review status versions and waits for an existing governed action before closing", async () => {
    const f = await fixture();
    const [invocation] = await db.insert(toolInvocations).values({ companyId: f.companyId, issueId: f.issueId,
      agentId: f.agentId, toolName: "governed-change" }).returning();
    const [request] = await db.insert(toolActionRequests).values({ companyId: f.companyId, issueId: f.issueId, invocationId: invocation.id,
      status: "pending", canonicalArgumentsHash: "test", canonicalArgumentsSummary: { summary: "Test action" } }).returning();
    await issueService(db).update(f.issueId, { status: "in_review", statusVersion: 1 });
    await expect(issueService(db).update(f.issueId, { status: "done", actorAgentId: f.agentId })).rejects.toMatchObject({
      status: 409, details: { code: "tool_review_pending" },
    });
    expect(await read(f)).toMatchObject({ issue: { status: "in_review" }, caseRow: { status: "in_progress" },
      handoff: { state: "awaiting_completion" } });
    await db.update(toolActionRequests).set({ status: "executed", resolvedAt: new Date() }).where(eq(toolActionRequests.id, request.id));
    await issueService(db).update(f.issueId, { status: "done", statusVersion: 2, actorUserId: f.userId });
    expect(await read(f)).toMatchObject({ issue: { status: "done", statusVersion: 2 }, caseRow: { status: "done" }, handoff: { state: "completed" } });
  });

  it("rolls back task completion, case closure and audit together", async () => {
    const f = await fixture();
    await expect(db.transaction(async transaction => {
      const tx = transaction as unknown as Db;
      await issueService(tx).update(f.issueId, { status: "done", actorUserId: f.userId }, tx, []);
      throw new Error("Crash before commit");
    })).rejects.toThrow("Crash before commit");
    expect(await read(f)).toMatchObject({ issue: { status: "in_progress", completedAt: null },
      caseRow: { status: "in_progress", completedAt: null }, handoff: { state: "awaiting_completion", completedAt: null } });
    expect(await db.select().from(caseEvents).where(eq(caseEvents.caseId, f.caseId))).toHaveLength(0);
    await issueService(db).update(f.issueId, { status: "done", actorUserId: f.userId });
    expect((await read(f)).handoff.state).toBe("completed");
  });

  it("cancels terminal intent on A to B to A reassignment and never closes it later", async () => {
    const f = await fixture();
    await issueService(db).update(f.issueId, { assigneeAgentId: f.otherAgentId, actorUserId: f.userId });
    await issueService(db).update(f.issueId, { assigneeAgentId: f.agentId, actorUserId: f.userId });
    await issueService(db).update(f.issueId, { status: "done", actorUserId: f.userId });
    expect(await read(f)).toMatchObject({ issue: { status: "done", assigneeAgentId: f.agentId },
      caseRow: { status: "in_progress", phase: "verification" }, handoff: { state: "cancelled", completedAt: null } });
  });

  it("an explicit Stop cancels terminal intent after its original run already settled", async () => {
    const f = await fixture();
    await heartbeatService(db).cancelRun(f.runId, "Operator stopped this work", {
      resultJson: { cancelledByActorType: "user", cancelledByUserId: f.userId },
    });
    await issueService(db).update(f.issueId, { status: "done", actorUserId: f.userId });
    expect(await read(f)).toMatchObject({ issue: { status: "done" }, caseRow: { status: "in_progress" }, handoff: { state: "cancelled" } });
  });

  it("task cancellation supersedes terminal intent without closing its case", async () => {
    const f = await fixture();
    await issueService(db).update(f.issueId, { status: "cancelled", actorUserId: f.userId });
    expect(await read(f)).toMatchObject({ issue: { status: "cancelled" }, caseRow: { status: "in_progress", completedAt: null },
      handoff: { state: "cancelled", completedAt: null } });
  });

  it("revoked retained access cancels only the case effect, preserving accepted task completion", async () => {
    const f = await fixture();
    await db.insert(caseAccessSources).values({ companyId: f.companyId, caseId: f.caseId, sourceKind: "issue", sourceId: randomUUID() });
    await issueService(db).update(f.issueId, { status: "done", actorUserId: f.userId });
    expect(await read(f)).toMatchObject({ issue: { status: "done" }, caseRow: { status: "in_progress" },
      handoff: { state: "cancelled", lastError: "Terminal handoff authority is no longer available" } });
  });

  it("ordinary task completion without terminal intent leaves its case independent", async () => {
    const f = await fixture();
    await db.delete(caseHandoffs).where(eq(caseHandoffs.id, f.handoffId));
    await issueService(db).update(f.issueId, { status: "done", actorUserId: f.userId });
    expect((await db.select().from(cases).where(eq(cases.id, f.caseId)))[0]).toMatchObject({ status: "in_progress", completedAt: null });
  });
});
