import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ONBOARDING_FIRST_TASK_ORIGIN_KIND, PROVIDER_QUOTA_MONITOR_SERVICE_NAME } from "@paperclipai/shared";
import { activityLog, agents, agentApiKeys, agentWakeupRequests, companies, createDb, heartbeatRuns, issues, issueComments, issueRelations, issueThreadInteractions, routines, routineTriggers } from "@paperclipai/db";
import { unblockDescriptorFingerprint } from "../services/routable-blocked.js";
import { beginIdleTrackedWork, idleWorkSnapshot } from "../services/task-admission.js";
import { readIdleSleepSafety, type IdleSleepDrainStatus } from "../services/idle-sleep-safety.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const now = Date.UTC(2020, 0, 1);
const ownerId = "d0b833f4-4098-42de-8420-1907f3aa4895";
const owned = (): IdleSleepDrainStatus => ({ ownerId, draining: true, startedAt: new Date(now - 1000),
  expiresAt: new Date(now + 60_000), activeRuns: 0, pendingWakes: 0 });
const emptyLocal = async () => "none" as const;
const present = { version: 1, backgroundWork: "present" };
const none = { version: 1, backgroundWork: "none" };
const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Skipping issue schedule Postgres tests: ${support.reason}`);
(support.supported ? describe : describe.skip)("idle issue schedule safety", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("idle-issue-schedule-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterEach(async () => { await db.execute(sql`TRUNCATE companies, plugins, environments CASCADE`); });
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  const readScheduled = () => readIdleSleepSafety(db, owned, () => now, ownerId, emptyLocal, undefined, undefined, true);
  const readIssueSchedules = () => readIdleSleepSafety(db, owned, () => now, ownerId, emptyLocal, undefined, undefined, true, true);
  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Idle test", issuePrefix: `T${companyId.slice(0, 6).toUpperCase()}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "On-demand agent", role: "engineer", status: "idle", adapterType: "process" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", status: "succeeded" });
    return { companyId, agentId, runId };
  }

  async function scheduledRoutine(at = now + 600_000) {
    const fixture = await seed();
    const [routine] = await db.insert(routines).values({ companyId: fixture.companyId,
      title: "Scheduled fixture", status: "active", assigneeAgentId: fixture.agentId }).returning();
    const [trigger] = await db.insert(routineTriggers).values({ companyId: fixture.companyId,
      routineId: routine!.id, kind: "schedule", cronExpression: "*/15 * * * *", timezone: "UTC",
      nextRunAt: new Date(at), enabled: true, archived: false, setupPending: false }).returning();
    return { ...fixture, routine: routine!, trigger: trigger! };
  }

  async function monitoredIssue(at = now + 600_000) {
    const fixture = await seed();
    const monitor = { nextCheckAt: new Date(at).toISOString(), notes: "Inspect fixture result" };
    const [issue] = await db.insert(issues).values({ companyId: fixture.companyId, title: "Monitor fixture",
      status: "in_progress", assigneeAgentId: fixture.agentId, monitorNextCheckAt: new Date(at),
      executionPolicy: { monitor } }).returning();
    return { ...fixture, issue: issue!, monitor };
  }

  it("allows passive issue records only with the issue-scheduling host capability", async () => {
    const f = await seed();
    await db.insert(issues).values([
      { companyId: f.companyId, title: "Planned task", status: "backlog", assigneeAgentId: f.agentId },
      { companyId: f.companyId, title: "Unassigned task", status: "todo" },
      { companyId: f.companyId, title: "Explicitly blocked task", status: "blocked", assigneeAgentId: f.agentId },
      { companyId: f.companyId, title: "Human review", status: "in_review", assigneeUserId: "fixture-user" },
    ]);
    expect(await readScheduled()).toEqual(present);
    expect(await readIssueSchedules()).toEqual(none);
    expect(await db.select().from(issues)).toHaveLength(4);
  });

  it.each(["todo", "in_progress", "in_review"])("retains an assigned %s task without a proved waiting path", async status => {
    const f = await seed();
    await db.insert(issues).values({ companyId: f.companyId, title: "Unfinished automated task", status, assigneeAgentId: f.agentId });
    expect(await readIssueSchedules()).toEqual(present);
  });

  async function completedUnblockRequest() {
    const f = await seed();
    const transition = new Date(now - 5000);
    const descriptor = { owner: { agentId: f.agentId }, action: "Provide the missing input" };
    const [issue] = await db.insert(issues).values({ companyId: f.companyId, title: "Waiting for unblock input",
      status: "blocked", assigneeAgentId: f.agentId, unblockDescriptor: descriptor,
      blockedTransitionAt: transition, blockedOwnerNotifiedAt: new Date(now - 4000),
    }).returning();
    await db.update(heartbeatRuns).set({ finishedAt: new Date(now - 1000), contextSnapshot: { issueId: issue.id } }).where(eq(heartbeatRuns.id, f.runId));
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
      source: "automation", reason: "issue_unblock_requested", status: "coalesced", runId: f.runId,
      finishedAt: new Date(now - 2000), idempotencyKey: `issue-unblock:${issue.id}:${transition.toISOString()}`,
      payload: { issueId: issue.id, action: descriptor.action },
    }).returning();
    return { ...f, issue, wake, descriptor };
  }

  async function selfAcknowledgedUnblockRequest() {
    const f = await seed();
    const transition = new Date(now - 5000);
    const descriptor = { owner: { agentId: f.agentId }, action: "Provide the missing input" };
    const [issue] = await db.insert(issues).values({ companyId: f.companyId, title: "Self-blocked waiting task",
      status: "blocked", assigneeAgentId: f.agentId, unblockDescriptor: descriptor,
      blockedTransitionAt: transition, blockedOwnerNotifiedAt: new Date(now - 4000),
    }).returning();
    await db.update(heartbeatRuns).set({ finishedAt: new Date(now - 1000), contextSnapshot: { issueId: issue.id } }).where(eq(heartbeatRuns.id, f.runId));
    const [activity] = await db.insert(activityLog).values({ companyId: f.companyId, actorType: "agent", actorId: f.agentId,
      agentId: f.agentId, runId: f.runId, action: "issue.updated", entityType: "issue", entityId: issue.id,
      details: { status: "blocked", blockedTransitionAt: transition.toISOString(), unblockDescriptor: descriptor,
        unblockDescriptorFingerprint: unblockDescriptorFingerprint(descriptor) },
    }).returning();
    return { ...f, issue, activity, descriptor, transition };
  }

  it("allows a blocked task after its exact agent unblock request finishes", async () => {
    const f = await completedUnblockRequest();
    expect(await readScheduled()).toEqual(present);
    expect(await readIssueSchedules()).toEqual(none);
    expect((await db.select().from(issues).where(eq(issues.id, f.issue.id)))[0]).toMatchObject({ status: "blocked", unblockDescriptor: f.descriptor });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wake.id)))[0]).toMatchObject({ status: "coalesced", runId: f.runId });
  });

  it("allows a blocked task after its self-authored unblock request is accounted", async () => {
    const f = await selfAcknowledgedUnblockRequest();
    expect(await readScheduled()).toEqual(present);
    expect(await readIssueSchedules()).toEqual(none);
    expect((await db.select().from(issues).where(eq(issues.id, f.issue.id)))[0]).toMatchObject({ status: "blocked", unblockDescriptor: f.descriptor });
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
  });

  it("allows a blocked task after a run-less self-authored unblock write", async () => {
    const f = await selfAcknowledgedUnblockRequest();
    await db.update(activityLog).set({ runId: null }).where(eq(activityLog.id, f.activity.id));
    expect(await readIssueSchedules()).toEqual(none);
  });

  it("keeps a self-authored unblock request awake until its source run finishes", async () => {
    const f = await selfAcknowledgedUnblockRequest();
    await db.update(heartbeatRuns).set({ finishedAt: null }).where(eq(heartbeatRuns.id, f.runId));
    expect(await readIssueSchedules()).toEqual(present);
    await db.update(heartbeatRuns).set({ finishedAt: new Date(now - 1000) }).where(eq(heartbeatRuns.id, f.runId));
    expect(await readIssueSchedules()).toEqual(none);
  });

  it("allows a blocked task when redaction rewrote the stored action text", async () => {
    const f = await selfAcknowledgedUnblockRequest();
    // Simulate username censoring: the stored copy no longer matches the
    // issue row, but the fingerprint written alongside it still binds the
    // exact descriptor the author wrote.
    const stored = f.activity.details as Record<string, unknown>;
    await db.update(activityLog).set({ details: { ...stored,
      unblockDescriptor: { owner: { agentId: f.agentId }, action: "Provide the * input" } } }).where(eq(activityLog.id, f.activity.id));
    expect(await readIssueSchedules()).toEqual(none);
  });

  it.each(["unnotified", "new_transition", "changed_action", "changed_fingerprint", "missing_activity", "foreign_activity", "accounting", "retry"])(
    "retains a blocked task with %s self-authored unblock evidence", async kind => {
      const f = await selfAcknowledgedUnblockRequest();
      if (kind === "unnotified") await db.update(issues).set({ blockedOwnerNotifiedAt: null }).where(eq(issues.id, f.issue.id));
      if (kind === "new_transition") await db.update(issues).set({ blockedTransitionAt: new Date(now - 3000), blockedOwnerNotifiedAt: new Date(now - 2000) }).where(eq(issues.id, f.issue.id));
      if (kind === "changed_action") await db.update(issues).set({ unblockDescriptor: { ...f.descriptor, action: "Different input" } }).where(eq(issues.id, f.issue.id));
      if (kind === "changed_fingerprint") await db.update(activityLog).set({ details: { ...(f.activity.details as Record<string, unknown>),
        unblockDescriptorFingerprint: "0".repeat(32) } }).where(eq(activityLog.id, f.activity.id));
      if (kind === "missing_activity") await db.delete(activityLog).where(eq(activityLog.id, f.activity.id));
      if (kind === "foreign_activity") await db.update(activityLog).set({ companyId: (await seed()).companyId }).where(eq(activityLog.id, f.activity.id));
      if (kind === "accounting") await db.update(heartbeatRuns).set({ costAccountingPending: true }).where(eq(heartbeatRuns.id, f.runId));
      if (kind === "retry") await db.update(heartbeatRuns).set({ scheduledRetryAt: new Date(now + 1000) }).where(eq(heartbeatRuns.id, f.runId));
      expect(await readIssueSchedules()).toEqual(present);
    },
  );

  it("keeps an explicit board-owned unblock request passive", async () => {
    const f = await seed();
    await db.insert(issues).values({ companyId: f.companyId, title: "Waiting for the board", status: "blocked",
      assigneeAgentId: f.agentId, unblockDescriptor: { owner: "board", action: "Provide input" },
    });
    expect(await readIssueSchedules()).toEqual(none);
  });

  it.each(["missing_receipt", "unnotified", "old_notification", "new_transition", "changed_action", "changed_owner", "foreign_owner", "foreign_receipt", "foreign_run", "wrong_issue", "wrong_run_issue", "missing_run", "unfinished_wake", "cancelled_receipt", "unfinished_run", "retry", "accounting", "unknown_descriptor"])(
    "retains a blocked task with %s unblock evidence", async kind => {
      const f = await completedUnblockRequest();
      if (kind === "missing_receipt") await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wake.id));
      if (kind === "unnotified") await db.update(issues).set({ blockedOwnerNotifiedAt: null }).where(eq(issues.id, f.issue.id));
      if (kind === "old_notification") await db.update(issues).set({ blockedOwnerNotifiedAt: new Date(now - 6000) }).where(eq(issues.id, f.issue.id));
      if (kind === "new_transition") await db.update(issues).set({ blockedTransitionAt: new Date(now - 3000), blockedOwnerNotifiedAt: new Date(now - 2000) }).where(eq(issues.id, f.issue.id));
      if (kind === "changed_action") await db.update(issues).set({ unblockDescriptor: { ...f.descriptor, action: "Different input" } }).where(eq(issues.id, f.issue.id));
      if (kind === "changed_owner" || kind === "foreign_owner") {
        const other = await seed();
        if (kind === "changed_owner") await db.update(agents).set({ companyId: f.companyId }).where(eq(agents.id, other.agentId));
        await db.update(issues).set({ unblockDescriptor: { ...f.descriptor, owner: { agentId: other.agentId } } }).where(eq(issues.id, f.issue.id));
      }
      if (kind === "foreign_receipt") await db.update(agentWakeupRequests).set({ companyId: (await seed()).companyId }).where(eq(agentWakeupRequests.id, f.wake.id));
      if (kind === "foreign_run") await db.update(heartbeatRuns).set({ companyId: (await seed()).companyId }).where(eq(heartbeatRuns.id, f.runId));
      if (kind === "wrong_issue") await db.update(agentWakeupRequests).set({ payload: { ...f.wake.payload, issueId: randomUUID() } }).where(eq(agentWakeupRequests.id, f.wake.id));
      if (kind === "wrong_run_issue") await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: randomUUID() } }).where(eq(heartbeatRuns.id, f.runId));
      if (kind === "missing_run") await db.update(agentWakeupRequests).set({ runId: null }).where(eq(agentWakeupRequests.id, f.wake.id));
      if (kind === "unfinished_wake") await db.update(agentWakeupRequests).set({ finishedAt: null }).where(eq(agentWakeupRequests.id, f.wake.id));
      if (kind === "cancelled_receipt") await db.update(agentWakeupRequests).set({ status: "cancelled" }).where(eq(agentWakeupRequests.id, f.wake.id));
      if (kind === "unfinished_run") await db.update(heartbeatRuns).set({ finishedAt: null }).where(eq(heartbeatRuns.id, f.runId));
      if (kind === "retry") await db.update(heartbeatRuns).set({ scheduledRetryAt: new Date(now + 1000) }).where(eq(heartbeatRuns.id, f.runId));
      if (kind === "accounting") await db.update(heartbeatRuns).set({ costAccountingPending: true }).where(eq(heartbeatRuns.id, f.runId));
      if (kind === "unknown_descriptor") await db.execute(sql`UPDATE issues SET unblock_descriptor = unblock_descriptor || '{"unknown":true}'::jsonb WHERE id = ${f.issue.id}`);
      expect(await readIssueSchedules()).toEqual(present);
    },
  );

  it.each(["typed", "legacy-typed", "interaction", "run", "origin", "agent-state"])(
    "allows an untouched onboarding task, but retains it after %s activity", async activity => {
      const f = await seed();
      const [issue] = await db.insert(issues).values({ companyId: f.companyId, title: "First task",
        status: "todo", assigneeAgentId: f.agentId, originKind: ONBOARDING_FIRST_TASK_ORIGIN_KIND }).returning();
      await db.insert(issueComments).values({ companyId: f.companyId, issueId: issue!.id,
        authorType: "agent", authorAgentId: f.agentId, body: "Seeded greeting" });
      const [card] = await db.insert(issueThreadInteractions).values({ companyId: f.companyId,
        issueId: issue!.id, kind: "request_confirmation", payload: { version: 1, prompt: "Start?" } }).returning();
      expect(await readScheduled()).toEqual(present);
      expect(await readIssueSchedules()).toEqual(none);
      if (activity === "typed" || activity === "legacy-typed") {
        await db.insert(issueComments).values({ companyId: f.companyId, issueId: issue!.id,
          authorType: activity === "typed" ? "user" : null, authorUserId: "fixture-user", body: "Start work" });
      }
      if (activity === "interaction") await db.update(issueThreadInteractions).set({ status: "resolved",
        resolvedByUserId: "fixture-user", resolvedAt: new Date(now) }).where(eq(issueThreadInteractions.id, card!.id));
      if (activity === "run") await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: issue!.id } }).where(eq(heartbeatRuns.id, f.runId));
      if (activity === "origin") await db.update(issues).set({ originKind: "manual" }).where(eq(issues.id, issue!.id));
      if (activity === "agent-state") await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
      expect(await readIssueSchedules()).toEqual(present);
    },
  );

  it("keeps resolved dependency repair awake while allowing an unresolved blocked task", async () => {
    const f = await seed();
    const [blocker] = await db.insert(issues).values({ companyId: f.companyId, title: "Unassigned blocker", status: "todo" }).returning();
    const [dependent] = await db.insert(issues).values({ companyId: f.companyId, title: "Waiting task", status: "blocked", assigneeAgentId: f.agentId }).returning();
    await db.insert(issueRelations).values({ companyId: f.companyId, issueId: blocker!.id, relatedIssueId: dependent!.id, type: "blocks" });
    expect(await readIssueSchedules()).toEqual(none);
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, blocker!.id));
    expect(await readIssueSchedules()).toEqual(none);
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, blocker!.id));
    expect(await readIssueSchedules()).toEqual(present);
  });

  it("combines routine and issue monitor deadlines across companies without changing dispatch state", async () => {
    await scheduledRoutine(now + 900_000);
    const f = await monitoredIssue();
    expect(await readScheduled()).toEqual(present);
    const first = await readIssueSchedules();
    expect(first).toMatchObject({ version: 2, backgroundWork: "none", scheduledWake: {
      version: 1, kind: "routines_and_issue_monitors", nextWakeAt: f.monitor.nextCheckAt } });
    expect((await readIssueSchedules()).scheduledWake).toEqual(first.scheduledWake);
    const earlier = new Date(now + 400_000);
    await db.update(issues).set({ monitorNextCheckAt: earlier, executionPolicy: { monitor: { ...f.monitor, nextCheckAt: earlier.toISOString() } } }).where(eq(issues.id, f.issue.id));
    const edited = await readIssueSchedules();
    expect(edited.scheduledWake?.nextWakeAt).toBe(earlier.toISOString());
    expect(edited.scheduledWake?.generation).not.toBe(first.scheduledWake?.generation);
    expect(await db.select().from(issues).where(eq(issues.id, f.issue.id))).toMatchObject([{ monitorNextCheckAt: earlier, monitorWakeRequestedAt: null, monitorAttemptCount: 0 }]);
    await db.update(issues).set({ status: "blocked", monitorNextCheckAt: null, executionPolicy: null }).where(eq(issues.id, f.issue.id));
    expect(await readIssueSchedules()).toMatchObject({ version: 2, backgroundWork: "none", scheduledWake: {
      kind: "routines", nextWakeAt: new Date(now + 900_000).toISOString() } });
  });

  it.each(["due", "mismatch", "claimed", "timeout", "exhausted", "negative-attempts", "pending-review", "quota", "unowned"])(
    "retains %s monitor work", async kind => {
      const f = await monitoredIssue();
      const patch: Partial<typeof issues.$inferInsert> = {};
      if (kind === "due") patch.monitorNextCheckAt = new Date(now);
      if (kind === "mismatch") patch.monitorNextCheckAt = new Date(now + 700_000);
      if (kind === "claimed") patch.monitorWakeRequestedAt = new Date(now);
      if (kind === "pending-review") patch.executionState = { status: "pending" };
      if (kind === "unowned") patch.assigneeAgentId = null;
      if (kind === "timeout") patch.executionPolicy = { monitor: { ...f.monitor, timeoutAt: new Date(now + 500_000).toISOString() } };
      if (kind === "exhausted") { patch.monitorAttemptCount = 2; patch.executionPolicy = { monitor: { ...f.monitor, maxAttempts: 2 } }; }
      if (kind === "negative-attempts") patch.monitorAttemptCount = -1;
      if (kind === "quota") patch.executionPolicy = { monitor: { ...f.monitor, serviceName: PROVIDER_QUOTA_MONITOR_SERVICE_NAME } };
      await db.update(issues).set(patch).where(eq(issues.id, f.issue.id));
      expect(await readIssueSchedules()).toEqual(present);
    },
  );

  it("retains a cross-company assignee and unknown issue states", async () => {
    const f = await monitoredIssue();
    const other = await seed();
    await db.update(issues).set({ assigneeAgentId: other.agentId }).where(eq(issues.id, f.issue.id));
    expect(await readIssueSchedules()).toEqual(present);
    await db.update(issues).set({ assigneeAgentId: f.agentId, status: "unknown" }).where(eq(issues.id, f.issue.id));
    expect(await readIssueSchedules()).toEqual(present);
  });

  it("retains an unknown assignee state even for a blocked task", async () => {
    const f = await seed();
    await db.insert(issues).values({ companyId: f.companyId, title: "Blocked fixture", status: "blocked", assigneeAgentId: f.agentId });
    await db.execute(sql`UPDATE agents SET status = 'unknown' WHERE id = ${f.agentId}`);
    expect(await readIssueSchedules()).toEqual(present);
  });

  it("refuses monitor sleep if a new run or external credential needs the instance", async () => {
    const f = await monitoredIssue();
    await db.update(heartbeatRuns).set({ status: "queued" }).where(eq(heartbeatRuns.id, f.runId));
    expect(await readIssueSchedules()).toEqual(present);
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.runId));
    await db.insert(agentApiKeys).values({ companyId: f.companyId, agentId: f.agentId, name: "Fixture external client", keyHash: "fixture-key-hash" });
    expect(await readIssueSchedules()).toEqual(present);
  });

  it("retains a monitor which becomes due during the owned backup checkpoint", async () => {
    await monitoredIssue(now + 1000);
    let clock = now;
    const backup = async () => {
      const done = beginIdleTrackedWork();
      try { clock += 1000; return true; } finally { done(); }
    };
    expect(await readIdleSleepSafety(db, owned, () => clock, ownerId, emptyLocal, undefined, backup, true, true)).toEqual(present);
    expect(idleWorkSnapshot().active).toBe(0);
  });

});
