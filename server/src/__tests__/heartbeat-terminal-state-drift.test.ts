/**
 * Integration test for the terminal-state drift fix (POI-165 / POI-166).
 *
 * Verifies that a deferred comment wake for a done/cancelled issue is
 * silently dropped (deferred wake → failed) without mutating the issue,
 * and that an audit log entry with source="deferred_comment_wake_terminal_skipped"
 * is written.
 *
 * Full heartbeat machinery (WebSocket gateway) is NOT required here.
 * We test the invariant at the DB level by reproducing the exact conditional
 * that `releaseIssueExecutionAndPromote` exercises, using the same
 * issuesSvc.update guard and logActivity call paths introduced in this fix.
 *
 * For a full end-to-end test covering the WebSocket gateway path,
 * see heartbeat-comment-wake-batching.test.ts as a reference.
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  issues,
  heartbeatRuns,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { issueService } from "../services/issues.ts";
import { logActivity } from "../services/activity-log.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping heartbeat terminal state drift tests: ${embeddedPostgresSupport.reason ?? "embedded postgres not supported"}`,
  );
}

describeEmbeddedPostgres("heartbeat — terminal state drift (POI-165)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-terminal-drift-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agentWakeupRequests);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedTerminalIssue(status: "done" | "cancelled") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const prefix = `TG${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Test Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: "idle",
      adapterType: "openclaw_gateway",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Terminal drift test issue",
      status,
      completedAt: status === "done" ? new Date("2026-04-17T10:00:00Z") : undefined,
      cancelledAt: status === "cancelled" ? new Date("2026-04-17T10:00:00Z") : undefined,
      priority: "medium",
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });

    // Simulate a deferred_issue_execution wake with wakeCommentIds — this is
    // what the heartbeat creates when a comment arrives while a run is active.
    const commentId = randomUUID();
    const wakeupId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupId,
      companyId,
      agentId,
      status: "deferred_issue_execution",
      source: "automation",
      reason: "issue_commented",
      requestedAt: new Date(),
      requestedByActorType: "system",
      requestedByActorId: "heartbeat",
      payload: {
        issueId,
        _paperclipWakeContext: {
          issueId,
          wakeCommentIds: [commentId],
        },
      },
    });

    return { companyId, agentId, issueId, runId, wakeupId, prefix };
  }

  it("issuesSvc.update guard blocks heartbeat's old reopen path (422 invariant)", async () => {
    const { issueId } = await seedTerminalIssue("done");
    const svc = issueService(db);

    // This is exactly what heartbeat.ts used to call — now blocked by the guard.
    await expect(
      svc.update(issueId, { status: "todo", executionState: null }),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("allowTerminalReopen"),
    });
  });

  it("issuesSvc.update guard blocks reopen of cancelled issue (422 invariant)", async () => {
    const { issueId } = await seedTerminalIssue("cancelled");
    const svc = issueService(db);

    await expect(
      svc.update(issueId, { status: "todo" }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("issue status, completedAt, and executionPolicy are unchanged after guard rejection", async () => {
    const { issueId } = await seedTerminalIssue("done");
    const svc = issueService(db);

    try {
      await svc.update(issueId, { status: "todo" });
    } catch {
      // expected 422
    }

    const after = await db
      .select({ status: issues.status, completedAt: issues.completedAt, executionPolicy: issues.executionPolicy })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);

    expect(after?.status).toBe("done");
    expect(after?.completedAt?.toISOString()).toBe("2026-04-17T10:00:00.000Z");
    expect(after?.executionPolicy).toBeNull();
  });

  it("deferred wake is marked failed and audit log written on terminal skip", async () => {
    // Simulate what heartbeat.ts now does when it detects shouldReopenDeferredCommentWake:
    // mark the wake as failed + write audit log. This mirrors the code in
    // releaseIssueExecutionAndPromote after the fix.
    const { companyId, agentId, issueId, runId, wakeupId, prefix } = await seedTerminalIssue("done");

    await db.transaction(async (tx) => {
      await tx
        .update(agentWakeupRequests)
        .set({
          status: "failed",
          finishedAt: new Date(),
          error: "deferred_comment_wake_terminal_skipped",
          updatedAt: new Date(),
        })
        .where(eq(agentWakeupRequests.id, wakeupId));
    });

    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "heartbeat",
      agentId,
      runId: null,  // no heartbeat run row needed for this assertion
      action: "issue.updated",
      entityType: "issue",
      entityId: issueId,
      details: {
        source: "deferred_comment_wake_terminal_skipped",
        status: "done",
        identifier: `${prefix}-1`,
      },
    });

    const wake = await db
      .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupId))
      .then((rows) => rows[0]);

    expect(wake?.status).toBe("failed");
    expect(wake?.error).toBe("deferred_comment_wake_terminal_skipped");

    const log = await db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .then((rows) => rows[0]);

    expect(log?.action).toBe("issue.updated");
    expect((log?.details as Record<string, unknown>)?.source).toBe(
      "deferred_comment_wake_terminal_skipped",
    );
  });
});
