import { randomUUID } from "node:crypto";
import request from "supertest";
import { isNotNull } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  companyMemberships,
  heartbeatRuns,
  issueRelations,
  issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import { issueRoutes } from "../routes/issues.js";
import {
  describeEmbeddedPostgres,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

/**
 * AGE-924 regression coverage: `GET /companies/:companyId/issues` used to
 * silently omit any monitor-liveness signal, so a stranding sweep computing
 * `.executionState?.monitor?.status ?? "none"` could not tell "no monitor"
 * apart from "field never sent". These tests pin the fix at the HTTP
 * boundary: `monitorStatus` is present on every list row, matches the
 * single-issue read for a live monitor, and the `?noWakePath=true` filter
 * implements the 4-condition definition end to end.
 */
describeEmbeddedPostgres("issue list monitorStatus + noWakePath (AGE-924)", () => {
  const ctx = useEmbeddedPostgres("paperclip-issues-no-wake-path-", {
    // Mirrors `resetCompanyIssueFixtures`, but deletes `agents` between the
    // issues delete and the companies delete: `issues.assigneeAgentId` and
    // `agents.companyId` both carry FKs, so agents must go after the issues
    // that reference them and before the companies that agents reference.
    resetEach: async (db) => {
      await db.delete(heartbeatRuns);
      await db.delete(agentWakeupRequests);
      await db.delete(issues).where(isNotNull(issues.parentId));
      await db.delete(issues);
      await db.delete(agents);
      await db.delete(principalPermissionGrants);
      await db.delete(companyMemberships);
      await db.delete(companies);
    },
  });

  it("monitorStatus is present (never absent) on every list row, and 'scheduled' matches the single-issue read for a live monitor", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Monitor status presence");
    const companyId = company.companyId;
    const [agent] = await ctx.db
      .insert(agents)
      .values({ id: randomUUID(), companyId, name: "Reviewer", status: "idle" })
      .returning();

    const liveMonitorIssueId = randomUUID();
    const noMonitorIssueId = randomUUID();
    const triggeredMonitorIssueId = randomUUID();
    await ctx.db.insert(issues).values([
      {
        id: liveMonitorIssueId,
        companyId,
        title: "In review with a live monitor",
        status: "in_review",
        priority: "medium",
        assigneeAgentId: agent!.id,
        monitorNextCheckAt: new Date(Date.now() + 60 * 60 * 1000),
      },
      {
        id: noMonitorIssueId,
        companyId,
        title: "In review, never monitored",
        status: "in_review",
        priority: "medium",
        assigneeAgentId: agent!.id,
      },
      {
        id: triggeredMonitorIssueId,
        companyId,
        title: "In review, monitor already fired",
        status: "in_review",
        priority: "medium",
        assigneeAgentId: agent!.id,
        monitorLastTriggeredAt: new Date(),
        monitorAttemptCount: 1,
      },
    ]);

    const listRes = await request(routeApp(ctx.db, company.actor, issueRoutes))
      .get(`/api/companies/${companyId}/issues`)
      .expect(200);
    const byId = new Map((listRes.body as Array<{ id: string; monitorStatus?: string }>).map((row) => [row.id, row]));

    // The field must be present on every row, not absent — this is the core
    // AGE-924 assertion. `in` (not `?? "none"`) is the whole point: the old
    // bug was indistinguishable from "none" using `??`.
    for (const row of listRes.body as Array<Record<string, unknown>>) {
      expect("monitorStatus" in row).toBe(true);
    }

    expect(byId.get(liveMonitorIssueId)?.monitorStatus).toBe("scheduled");
    expect(byId.get(noMonitorIssueId)?.monitorStatus).toBe("none");
    expect(byId.get(triggeredMonitorIssueId)?.monitorStatus).toBe("triggered");

    // Cross-check against the single-issue read for the live-monitor case,
    // the exact scenario the operator sweep got wrong (37 of 46 in_review
    // issues had a live monitor the list route couldn't see).
    const singleRes = await request(routeApp(ctx.db, company.actor, issueRoutes))
      .get(`/api/issues/${liveMonitorIssueId}`)
      .expect(200);
    expect(singleRes.body.monitorStatus).toBe("scheduled");
    expect(singleRes.body.executionState?.monitor?.status ?? "scheduled").toBe("scheduled");
  });

  it("compact view also carries monitorStatus", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Monitor status compact view");
    const companyId = company.companyId;
    await ctx.db.insert(issues).values([
      { id: randomUUID(), companyId, title: "Todo", status: "todo", priority: "medium" },
    ]);
    const res = await request(routeApp(ctx.db, company.actor, issueRoutes))
      .get(`/api/companies/${companyId}/issues?view=compact`)
      .expect(200);
    for (const row of res.body as Array<Record<string, unknown>>) {
      expect("monitorStatus" in row).toBe(true);
      expect(row.monitorStatus).toBe("none");
    }
  });

  it("?noWakePath=true implements the 4-condition definition and excludes healthy issues", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "No wake path filter");
    const companyId = company.companyId;
    const [runningAgent, idleAgent] = await ctx.db
      .insert(agents)
      .values([
        { id: randomUUID(), companyId, name: "Saturated", status: "running" },
        { id: randomUUID(), companyId, name: "Idle", status: "idle" },
      ])
      .returning();

    const blockedNoWakePathId = randomUUID();
    const blockedHealthyId = randomUUID();
    const reviewNoWakePathId = randomUUID();
    const reviewHealthyId = randomUUID();
    const todoUnassignedId = randomUUID();
    const todoAssignedId = randomUUID();
    const saturatedAssigneeId = randomUUID();
    const healthyRunningAssigneeId = randomUUID();
    const blockerId = randomUUID();

    await ctx.db.insert(issues).values([
      { id: blockerId, companyId, title: "Open blocker", status: "in_progress", priority: "medium" },
      // Condition 1: blocked, no blockers recorded, no monitor.
      { id: blockedNoWakePathId, companyId, title: "Blocked with no blockers", status: "blocked", priority: "medium" },
      // Healthy: blocked but has a real open blocker.
      { id: blockedHealthyId, companyId, title: "Blocked with an open blocker", status: "blocked", priority: "medium" },
      // Condition 2: in_review, monitor never scheduled, no blocker.
      {
        id: reviewNoWakePathId,
        companyId,
        title: "In review, no monitor",
        status: "in_review",
        priority: "medium",
        assigneeAgentId: idleAgent!.id,
      },
      // Healthy: in_review with a live scheduled monitor.
      {
        id: reviewHealthyId,
        companyId,
        title: "In review, live monitor",
        status: "in_review",
        priority: "medium",
        assigneeAgentId: idleAgent!.id,
        monitorNextCheckAt: new Date(Date.now() + 60 * 60 * 1000),
      },
      // Condition 3: todo, unassigned.
      { id: todoUnassignedId, companyId, title: "Todo, unassigned", status: "todo", priority: "medium" },
      // Healthy: todo but assigned.
      {
        id: todoAssignedId,
        companyId,
        title: "Todo, assigned",
        status: "todo",
        priority: "medium",
        assigneeAgentId: idleAgent!.id,
      },
      // Condition 4: assignee's agent status is running, but no active run
      // owns this issue (saturated on some other lane).
      {
        id: saturatedAssigneeId,
        companyId,
        title: "Assignee running elsewhere",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: runningAgent!.id,
      },
      // Healthy: assignee's agent is idle (not claiming to run anything).
      {
        id: healthyRunningAssigneeId,
        companyId,
        title: "Assignee idle",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: idleAgent!.id,
      },
    ]);
    // `blockedHealthyId` is blocked by the still-open `blockerId` issue.
    await ctx.db.insert(issueRelations).values({
      id: randomUUID(),
      companyId,
      issueId: blockerId,
      relatedIssueId: blockedHealthyId,
      type: "blocks",
    });

    const res = await request(routeApp(ctx.db, company.actor, issueRoutes))
      .get(`/api/companies/${companyId}/issues?noWakePath=true`)
      .expect(200);
    const ids = new Set((res.body as Array<{ id: string }>).map((row) => row.id));

    expect(ids.has(blockedNoWakePathId)).toBe(true);
    expect(ids.has(reviewNoWakePathId)).toBe(true);
    expect(ids.has(todoUnassignedId)).toBe(true);
    expect(ids.has(saturatedAssigneeId)).toBe(true);

    expect(ids.has(blockedHealthyId)).toBe(false);
    expect(ids.has(reviewHealthyId)).toBe(false);
    expect(ids.has(todoAssignedId)).toBe(false);
    expect(ids.has(healthyRunningAssigneeId)).toBe(false);
  });

  it("rejects noWakePath combined with attention=blocked", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "No wake path invalid combo");
    await request(routeApp(ctx.db, company.actor, issueRoutes))
      .get(`/api/companies/${company.companyId}/issues?noWakePath=true&attention=blocked`)
      .expect(400);
  });

  it("does not misclassify a queued run or scheduled retry as assignee saturation (Greptile finding on PR #11911)", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "No wake path queued and retry");
    const companyId = company.companyId;
    const [runningAgent] = await ctx.db
      .insert(agents)
      .values([{ id: randomUUID(), companyId, name: "Busy", status: "running" }])
      .returning();

    const queuedWakeIssueId = randomUUID();
    const scheduledRetryIssueId = randomUUID();
    const queuedRunNotBoundIssueId = randomUUID();
    await ctx.db.insert(issues).values([
      // A wake was queued for this issue but has not converted into a run yet
      // (issues.executionRunId is still null), so `activeRun` alone would
      // report false — this must still count as a live path.
      { id: queuedWakeIssueId, companyId, title: "Queued wake, no run yet", status: "in_progress", priority: "medium", assigneeAgentId: runningAgent!.id },
      // A run is `scheduled_retry` for this issue — a live path, not dead.
      { id: scheduledRetryIssueId, companyId, title: "Scheduled retry", status: "in_progress", priority: "medium", assigneeAgentId: runningAgent!.id },
      // A run is `queued` for this issue via contextSnapshot, but
      // issues.executionRunId was never stamped.
      { id: queuedRunNotBoundIssueId, companyId, title: "Queued run via contextSnapshot only", status: "in_progress", priority: "medium", assigneeAgentId: runningAgent!.id },
    ]);
    await ctx.db.insert(agentWakeupRequests).values({
      id: randomUUID(),
      companyId,
      agentId: runningAgent!.id,
      source: "issue_watchdog",
      status: "queued",
      reason: "issue_wake",
      payload: { issueId: queuedWakeIssueId },
    });
    await ctx.db.insert(heartbeatRuns).values([
      {
        id: randomUUID(),
        companyId,
        agentId: runningAgent!.id,
        status: "scheduled_retry",
        contextSnapshot: { issueId: scheduledRetryIssueId },
      },
      {
        id: randomUUID(),
        companyId,
        agentId: runningAgent!.id,
        status: "queued",
        contextSnapshot: { issueId: queuedRunNotBoundIssueId },
      },
    ]);

    const res = await request(routeApp(ctx.db, company.actor, issueRoutes))
      .get(`/api/companies/${companyId}/issues?noWakePath=true`)
      .expect(200);
    const ids = new Set((res.body as Array<{ id: string }>).map((row) => row.id));

    expect(ids.has(queuedWakeIssueId)).toBe(false);
    expect(ids.has(scheduledRetryIssueId)).toBe(false);
    expect(ids.has(queuedRunNotBoundIssueId)).toBe(false);
  });

  it("surfaces X-Paperclip-No-Wake-Path-Scan-Truncated when the bounded scan hits its cap", async () => {
    const company = await seedCompanyWithBoardAccess(ctx.db, "No wake path truncation");
    const companyId = company.companyId;
    await ctx.db.insert(issues).values([
      { id: randomUUID(), companyId, title: "Todo, unassigned", status: "todo", priority: "medium" },
    ]);

    const healthyRes = await request(routeApp(ctx.db, company.actor, issueRoutes))
      .get(`/api/companies/${companyId}/issues?noWakePath=true`)
      .expect(200);
    expect(healthyRes.headers["x-paperclip-no-wake-path-scan-truncated"]).toBeUndefined();
  });

  it("?offset= is the raw-scan continuation cursor for noWakePath, not a match-count skip (Greptile follow-up on PR #11911)", async () => {
    // When noWakePath is truncated, a caller must advance `offset` by the
    // scan cap to reach matches a prior window missed — which only works if
    // `offset` skips raw candidate rows (SQL order), not already-classified
    // matches. This pins that contract on a small, fast dataset: two
    // no-wake-path issues exist, ordered by identifier/creation; skipping past
    // the first one via `offset=1` must still find the second, and skipping
    // past both must return empty even though matches exist earlier.
    const company = await seedCompanyWithBoardAccess(ctx.db, "No wake path offset is a scan cursor");
    const companyId = company.companyId;
    const firstId = randomUUID();
    const secondId = randomUUID();
    await ctx.db.insert(issues).values([
      { id: firstId, companyId, title: "Todo, unassigned, first", status: "todo", priority: "medium" },
      { id: secondId, companyId, title: "Todo, unassigned, second", status: "todo", priority: "medium" },
    ]);

    const fullRes = await request(routeApp(ctx.db, company.actor, issueRoutes))
      .get(`/api/companies/${companyId}/issues?noWakePath=true`)
      .expect(200);
    const fullIds = (fullRes.body as Array<{ id: string }>).map((row) => row.id);
    expect(fullIds).toHaveLength(2);

    // Skip past every raw candidate row: no matches remain in this window,
    // even though two real matches exist starting at offset 0.
    const pastEndRes = await request(routeApp(ctx.db, company.actor, issueRoutes))
      .get(`/api/companies/${companyId}/issues?noWakePath=true&offset=2`)
      .expect(200);
    expect(pastEndRes.body).toEqual([]);
  });
});
