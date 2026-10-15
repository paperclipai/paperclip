import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ONBOARDING_FIRST_TASK_ORIGIN_KIND, PROVIDER_QUOTA_MONITOR_SERVICE_NAME } from "@paperclipai/shared";
import { agents, agentApiKeys, companies, createDb, heartbeatRuns, issues, issueComments, issueRelations, issueThreadInteractions, routines, routineTriggers } from "@paperclipai/db";
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
