import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.ts";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.ts";

async function closeDbClient(db: ReturnType<typeof createDb> | undefined) {
  await db?.$client?.end?.({ timeout: 0 });
}

// ELB-445 regression: an orphan queued heartbeat run owned by a *prior* assignee
// must not be re-stamped onto an issue after the issue has been reassigned to a
// new agent. Before the fix at services/heartbeat.ts (legacy-run reattach), the
// reattach scan matched runs by issueId only and ignored agentId, so the next
// wake on the issue would silently restamp executionRunId with the orphan run id
// — blocking the new assignee's checkout with a 409 ~1s after a bare PATCH.
describe("heartbeat ELB-445 cross-assignee reattach guard", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-elb-445-");
    db = createDb(started.connectionString);
    tempDb = started;
  }, 120_000);

  afterAll(async () => {
    await closeDbClient(db);
    await tempDb?.cleanup();
  });

  it("does not reattach an orphan queued run from the prior assignee after reassignment", async () => {
    const companyId = randomUUID();
    const priorAssigneeAgentId = randomUUID();
    const newAssigneeAgentId = randomUUID();
    const orphanQueuedRunId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: priorAssigneeAgentId,
        companyId,
        name: "GameDeveloper",
        role: "engineer",
        status: "active",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: newAssigneeAgentId,
        companyId,
        name: "Architect",
        role: "engineer",
        status: "active",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    // Orphan queued run for the prior assignee, with contextSnapshot.issueId
    // pointing at the issue. Simulates a leftover wake from a sweep PATCH-with-
    // comment cross-issue assignment that was later released and reassigned.
    await db.insert(heartbeatRuns).values({
      id: orphanQueuedRunId,
      companyId,
      agentId: priorAssigneeAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_assigned",
      },
    });

    // Issue is freshly reassigned to the new agent. executionRunId is null
    // (just-cleared by the bare PATCH path). Status todo, not in_progress.
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Reassigned target",
      status: "todo",
      priority: "high",
      assigneeAgentId: newAssigneeAgentId,
      checkoutRunId: null,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    // Trigger an issue-scoped wake for the NEW assignee, which exercises the
    // legacy-run reattach path inside enqueueWakeup.
    await heartbeat.wakeup(newAssigneeAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId, mutation: "update" },
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_assigned",
        source: "issue.update",
      },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });

    const issueAfter = await db
      .select({
        executionRunId: issues.executionRunId,
        executionAgentNameKey: issues.executionAgentNameKey,
        executionLockedAt: issues.executionLockedAt,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);

    expect(issueAfter?.assigneeAgentId).toBe(newAssigneeAgentId);

    // Core assertion: the orphan run owned by the *prior* assignee must NOT be
    // reattached to the issue. If executionRunId is set at all, it must belong
    // to a run owned by the current assignee (e.g. the freshly-queued wake run
    // promoted by Fix A lazy locking).
    expect(issueAfter?.executionRunId).not.toBe(orphanQueuedRunId);
    if (issueAfter?.executionRunId) {
      const stampedRun = await db
        .select({ agentId: heartbeatRuns.agentId })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, issueAfter.executionRunId))
        .then((rows) => rows[0]);
      expect(stampedRun?.agentId).toBe(newAssigneeAgentId);
    }

    // The orphan run is left in place — cleanup is the responsibility of the
    // run-cancellation path, not the reattach guard. We only assert that the
    // legacy reattach did not restamp it onto the issue.
    const orphan = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, orphanQueuedRunId))
      .then((rows) => rows[0]);
    expect(orphan?.status).toBe("queued");
  });

  it("does not stamp the requesting run R onto target B when PATCH crosses checkout boundary", async () => {
    // Acceptance scenario from the ELB-445 wake comment:
    //   "Server fix: PATCH on issue B from run R-on-A leaves B's
    //    executionRunId/executionLockedAt untouched (or null)."
    // Setup: CPO holds checkout on issue A with running run R. Sweep flow then
    // PATCH-with-comments issue B reassigning it to X. The async wake fired by
    // the PATCH targets X on B. The legacy reattach in enqueueWakeup must filter
    // by issue.assigneeAgentId so CPO's R (a running run with contextSnapshot
    // issueId = A) is never matched as a "legacy run" for issue B.
    const companyId = randomUUID();
    const cpoAgentId = randomUUID();
    const newAssigneeAgentId = randomUUID();
    const cpoRunningRunId = randomUUID();
    const issueAId = randomUUID();
    const issueBId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: cpoAgentId,
        companyId,
        name: "CPO",
        role: "executive",
        status: "active",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: newAssigneeAgentId,
        companyId,
        name: "GameDeveloper",
        role: "engineer",
        status: "active",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    // CPO's *running* sweep run on issue A — this is the "R-on-A" run id.
    const startedAt = new Date();
    await db.insert(heartbeatRuns).values({
      id: cpoRunningRunId,
      companyId,
      agentId: cpoAgentId,
      invocationSource: "on_demand",
      triggerDetail: "sweep",
      status: "running",
      startedAt,
      contextSnapshot: {
        issueId: issueAId,
        taskId: issueAId,
        wakeReason: "sweep",
      },
    });

    // Issue A is checked out by CPO under run R.
    await db.insert(issues).values({
      id: issueAId,
      companyId,
      title: "CPO sweep run holder",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: cpoAgentId,
      checkoutRunId: cpoRunningRunId,
      executionRunId: cpoRunningRunId,
      executionAgentNameKey: "cpo",
      executionLockedAt: startedAt,
      startedAt,
      issueNumber: 3,
      identifier: `${issuePrefix}-3`,
    });

    // Issue B simulates the post-PATCH state: assignee already swapped to the
    // new assignee, executionRunId already cleared by issueService.update.
    await db.insert(issues).values({
      id: issueBId,
      companyId,
      title: "Sweep reassignment target",
      status: "todo",
      priority: "high",
      assigneeAgentId: newAssigneeAgentId,
      checkoutRunId: null,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
      issueNumber: 4,
      identifier: `${issuePrefix}-4`,
    });

    // Mimic the async wake the PATCH route fires after addComment.
    await heartbeat.wakeup(newAssigneeAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: issueBId, mutation: "update", commentId: randomUUID() },
      contextSnapshot: {
        issueId: issueBId,
        taskId: issueBId,
        wakeReason: "issue_assigned",
        source: "issue.update",
      },
      requestedByActorType: "agent",
      requestedByActorId: cpoAgentId,
    });

    const issueBAfter = await db
      .select({
        executionRunId: issues.executionRunId,
        executionAgentNameKey: issues.executionAgentNameKey,
        executionLockedAt: issues.executionLockedAt,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(eq(issues.id, issueBId))
      .then((rows) => rows[0]);

    // Core acceptance: B.executionRunId is never CPO's run R.
    expect(issueBAfter?.executionRunId).not.toBe(cpoRunningRunId);
    expect(issueBAfter?.assigneeAgentId).toBe(newAssigneeAgentId);

    if (issueBAfter?.executionRunId) {
      // Anything stamped on B must be a run owned by the new assignee.
      const stampedRun = await db
        .select({ agentId: heartbeatRuns.agentId, status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, issueBAfter.executionRunId))
        .then((rows) => rows[0]);
      expect(stampedRun?.agentId).toBe(newAssigneeAgentId);
    } else {
      expect(issueBAfter?.executionLockedAt).toBeNull();
      expect(issueBAfter?.executionAgentNameKey).toBeNull();
    }

    // PATCH on the run's own checkout — current behavior preserved.
    // Issue A (CPO's checkout) must remain stamped with R; the cross-issue wake
    // on B must not disturb A.
    const issueAAfter = await db
      .select({
        executionRunId: issues.executionRunId,
        checkoutRunId: issues.checkoutRunId,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(eq(issues.id, issueAId))
      .then((rows) => rows[0]);
    expect(issueAAfter?.executionRunId).toBe(cpoRunningRunId);
    expect(issueAAfter?.checkoutRunId).toBe(cpoRunningRunId);
    expect(issueAAfter?.assigneeAgentId).toBe(cpoAgentId);
  });
});
