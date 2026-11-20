import { eq } from "drizzle-orm";
import { beforeAll, expect, it, vi } from "vitest";
import { activityLog, agents, type createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.ts";
import { normalizeIssueExecutionPolicy, parseIssueExecutionState } from "../services/issue-execution-policy.ts";
import { describeEmbeddedPostgres, useIssueMonitorSchedulerFixture } from "./helpers/issue-monitor-scheduler-fixture.js";

vi.mock("../services/company-skills.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/company-skills.js")>();
  return { ...actual, companySkillService: (...args: Parameters<typeof actual.companySkillService>) => {
    const service = actual.companySkillService(...args);
    return { ...service, withRuntimeSkillEntries: async <T>(_companyId: string,
      options: Parameters<typeof service.withRuntimeSkillEntries>[1],
      consume: (entries: Awaited<ReturnType<typeof service.listRuntimeSkillEntries>>) => T | Promise<T>) => {
      await options.selectVersions?.([]);
      return consume([]);
    } };
  } };
});

describeEmbeddedPostgres("issue monitor held fires", () => {
  const fixture = useIssueMonitorSchedulerFixture();
  let db!: ReturnType<typeof createDb>;
  beforeAll(() => {
    db = fixture.db;
  });
  const { seedFixture, waitForHeartbeatIdle } = fixture;

  async function holdMonitorWakes(agentId: string) {
    await db.update(agents).set({ runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxDailyRuns: 0 } } })
      .where(eq(agents.id, agentId));
  }

  async function releaseMonitorWakes(agentId: string) {
    await db.update(agents).set({ runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } } })
      .where(eq(agents.id, agentId));
  }

  async function readIssue(issueId: string) {
    return db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
  }

  async function issueActions(issueId: string) {
    return (await db.select().from(activityLog).where(eq(activityLog.entityId, issueId))).map((row) => row.action);
  }

  it("counts and backs off held monitor fires until maxAttempts clears them", async () => {
    const { issueId, agentId, nextCheckAt } = await seedFixture({
      monitor: { maxAttempts: 3, recoveryPolicy: "escalate_to_board" },
    });
    await holdMonitorWakes(agentId);
    const heartbeat = heartbeatService(db);

    let dueAt = new Date(nextCheckAt.getTime() + 60_000);
    let previousDelay = 0;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect((await heartbeat.tickTimers(dueAt)).enqueued).toBe(0);
      const issue = await readIssue(issueId);
      expect(issue.monitorAttemptCount).toBe(attempt);
      expect(issue.monitorWakeRequestedAt).toBeNull();
      expect(issue.monitorNextCheckAt!.getTime()).toBeGreaterThan(dueAt.getTime());
      const delay = issue.monitorNextCheckAt!.getTime() - dueAt.getTime();
      expect(delay).toBeGreaterThanOrEqual(previousDelay);
      previousDelay = delay;
      expect(normalizeIssueExecutionPolicy(issue.executionPolicy)?.monitor?.nextCheckAt)
        .toBe(issue.monitorNextCheckAt!.toISOString());
      expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
        status: "scheduled", attemptCount: attempt, nextCheckAt: issue.monitorNextCheckAt!.toISOString(),
      });
      await heartbeat.tickTimers(new Date(dueAt.getTime() + 1_000));
      expect((await readIssue(issueId)).monitorAttemptCount).toBe(attempt);
      dueAt = issue.monitorNextCheckAt!;
    }

    await heartbeat.tickTimers(dueAt);
    const cleared = await readIssue(issueId);
    expect(cleared.monitorNextCheckAt).toBeNull();
    expect(normalizeIssueExecutionPolicy(cleared.executionPolicy)?.monitor ?? null).toBeNull();
    expect(parseIssueExecutionState(cleared.executionState)?.monitor).toMatchObject({
      status: "cleared", clearReason: "max_attempts_exhausted",
    });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId))).toHaveLength(0);
    const actions = await issueActions(issueId);
    expect(actions.filter((action) => action === "issue.monitor_deferred")).toHaveLength(3);
    expect(actions).toContain("issue.monitor_exhausted");
    expect(actions).not.toContain("issue.monitor_triggered");
  });

  it("bounds held monitor fires without maxAttempts or timeoutAt", async () => {
    const { issueId, agentId, nextCheckAt } = await seedFixture({ monitor: { recoveryPolicy: "escalate_to_board" } });
    await holdMonitorWakes(agentId);
    const heartbeat = heartbeatService(db);

    let dueAt = new Date(nextCheckAt.getTime() + 60_000);
    let fires = 0;
    for (; fires < 40; fires += 1) {
      await heartbeat.tickTimers(dueAt);
      const issue = await readIssue(issueId);
      if (!issue.monitorNextCheckAt) break;
      expect(issue.monitorNextCheckAt.getTime()).toBeGreaterThan(dueAt.getTime());
      expect(issue.monitorNextCheckAt.getTime() - dueAt.getTime()).toBeLessThanOrEqual(30 * 60_000);
      dueAt = issue.monitorNextCheckAt;
    }
    expect(fires).toBe(10);
    const cleared = await readIssue(issueId);
    expect(cleared.monitorNextCheckAt).toBeNull();
    expect(parseIssueExecutionState(cleared.executionState)?.monitor).toMatchObject({
      status: "cleared", clearReason: "dispatch_deferred_exhausted",
    });
    const actions = await issueActions(issueId);
    expect(actions.filter((action) => action === "issue.monitor_deferred")).toHaveLength(10);
    expect(actions).toContain("issue.monitor_exhausted");
  });

  it("does not apply the ten-fire fallback to a monitor with its own maxAttempts", async () => {
    const { issueId, agentId, nextCheckAt } = await seedFixture({
      monitor: { maxAttempts: 100, recoveryPolicy: "escalate_to_board" },
    });
    await holdMonitorWakes(agentId);
    const heartbeat = heartbeatService(db);

    let dueAt = new Date(nextCheckAt.getTime() + 60_000);
    for (let fire = 0; fire < 11; fire += 1) {
      await heartbeat.tickTimers(dueAt);
      const issue = await readIssue(issueId);
      expect(issue.monitorNextCheckAt).not.toBeNull();
      dueAt = issue.monitorNextCheckAt!;
    }
    const issue = await readIssue(issueId);
    expect(issue.monitorAttemptCount).toBe(11);
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({ status: "scheduled" });
    const actions = await issueActions(issueId);
    expect(actions.filter((action) => action === "issue.monitor_deferred")).toHaveLength(11);
    expect(actions).not.toContain("issue.monitor_exhausted");
  });

  it("clamps the held-fire backoff to timeoutAt and then clears the monitor as timed out", async () => {
    const timeoutAt = new Date("2026-04-11T12:31:30.000Z");
    const { issueId, agentId } = await seedFixture({
      monitor: { timeoutAt: timeoutAt.toISOString(), recoveryPolicy: "escalate_to_board" },
    });
    await holdMonitorWakes(agentId);
    const heartbeat = heartbeatService(db);
    await heartbeat.tickTimers(new Date("2026-04-11T12:31:00.000Z"));
    expect((await readIssue(issueId)).monitorNextCheckAt).toEqual(timeoutAt);
    await heartbeat.tickTimers(new Date("2026-04-11T12:31:31.000Z"));
    const cleared = await readIssue(issueId);
    expect(cleared.monitorNextCheckAt).toBeNull();
    expect(parseIssueExecutionState(cleared.executionState)?.monitor).toMatchObject({
      status: "cleared", clearReason: "timeout_exceeded",
    });
  });

  it("backs off a held owner-recovery wake and delivers it once the hold ends", async () => {
    const { issueId, agentId, nextCheckAt } = await seedFixture({ monitorAttemptCount: 1, monitor: { maxAttempts: 1 } });
    await holdMonitorWakes(agentId);
    const heartbeat = heartbeatService(db);

    const firstTick = new Date(nextCheckAt.getTime() + 60_000);
    await heartbeat.tickTimers(firstTick);
    const waiting = await readIssue(issueId);
    expect(waiting.monitorNextCheckAt!.getTime()).toBeGreaterThan(firstTick.getTime());
    expect(waiting.monitorWakeRequestedAt).toBeNull();
    await heartbeat.tickTimers(new Date(firstTick.getTime() + 1_000));
    const deferred = (await db.select().from(activityLog).where(eq(activityLog.entityId, issueId)))
      .filter((row) => row.action === "issue.monitor_deferred");
    expect(deferred).toHaveLength(1);
    expect(deferred[0]?.details).toMatchObject({ reason: "monitor_recovery_deferred", deferredCount: 1 });
    let actions = await issueActions(issueId);
    expect(actions).not.toContain("issue.monitor_exhausted");

    await releaseMonitorWakes(agentId);
    await heartbeat.tickTimers(waiting.monitorNextCheckAt!);
    const cleared = await readIssue(issueId);
    expect(cleared.monitorNextCheckAt).toBeNull();
    expect(parseIssueExecutionState(cleared.executionState)?.monitor).toMatchObject({
      status: "cleared", clearReason: "max_attempts_exhausted",
    });
    actions = await issueActions(issueId);
    expect(actions).toContain("issue.monitor_exhausted");
    expect(actions.filter((action) => action === "issue.monitor_recovery_wake_queued")).toHaveLength(1);
    await waitForHeartbeatIdle();
  });

  it("keeps the owner recovery pending after held fires exhaust a monitor without limits", async () => {
    const { issueId, agentId, nextCheckAt } = await seedFixture();
    await holdMonitorWakes(agentId);
    const heartbeat = heartbeatService(db);

    let dueAt = new Date(nextCheckAt.getTime() + 60_000);
    for (let fire = 0; fire < 11; fire += 1) {
      await heartbeat.tickTimers(dueAt);
      dueAt = (await readIssue(issueId)).monitorNextCheckAt!;
      expect(dueAt).not.toBeNull();
    }
    let actions = await issueActions(issueId);
    expect(actions.filter((action) => action === "issue.monitor_deferred")).toHaveLength(11);
    expect(actions).not.toContain("issue.monitor_exhausted");

    await releaseMonitorWakes(agentId);
    await heartbeat.tickTimers(dueAt);
    const cleared = await readIssue(issueId);
    expect(cleared.monitorNextCheckAt).toBeNull();
    expect(parseIssueExecutionState(cleared.executionState)?.monitor).toMatchObject({
      status: "cleared", clearReason: "dispatch_deferred_exhausted",
    });
    actions = await issueActions(issueId);
    expect(actions.filter((action) => action === "issue.monitor_recovery_wake_queued")).toHaveLength(1);
    expect(actions).not.toContain("issue.monitor_triggered");
    await waitForHeartbeatIdle();
  });

  it("does not clobber a monitor replaced while a held fire is being deferred", async () => {
    const { issueId, agentId } = await seedFixture();
    await holdMonitorWakes(agentId);
    const replacementAt = new Date("2026-04-11T13:30:00.000Z");
    let replaced = false;
    const racingDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "transaction") return Reflect.get(target, property, receiver);
        return async (callback: Parameters<typeof db.transaction>[0]) => {
          const result = await db.transaction(callback);
          const row = result as { id?: string; monitorWakeRequestedAt?: Date | null } | null;
          if (!replaced && row?.id === issueId && row.monitorWakeRequestedAt) {
            replaced = true;
            await db.update(issues).set({ monitorNextCheckAt: replacementAt, monitorWakeRequestedAt: null,
              executionPolicy: { monitor: { nextCheckAt: replacementAt.toISOString(), notes: "New check", scheduledBy: "assignee" } },
            }).where(eq(issues.id, issueId));
          }
          return result;
        };
      },
    });
    await heartbeatService(racingDb).tickTimers(new Date("2026-04-11T12:31:00.000Z"));
    expect(replaced).toBe(true);
    const issue = await readIssue(issueId);
    expect(issue.monitorNextCheckAt).toEqual(replacementAt);
    expect(issue.monitorAttemptCount).toBe(0);
    expect(normalizeIssueExecutionPolicy(issue.executionPolicy)?.monitor?.nextCheckAt).toBe(replacementAt.toISOString());
  });
});
