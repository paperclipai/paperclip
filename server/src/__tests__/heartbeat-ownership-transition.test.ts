/**
 * Regression tests for BLA-206 and BLA-207 — heartbeat ownership transitions.
 *
 * BLA-207: After an issue is reassigned from agent A to agent B, agent A's
 *   orphaned run completing must NOT re-claim the issue via stale deferred
 *   wakeup promotion. assigneeAgentId is the authoritative ownership signal.
 *
 * BLA-206: A deferred wakeup queued by agent A (e.g. EPM scavenging) must
 *   not be promoted into execution if the issue's assigneeAgentId has since
 *   been set to a different agent.
 *
 * Both are fixed in releaseIssueExecutionAndPromote (heartbeat.ts) by reading
 * assigneeAgentId from the issue row and skipping any deferred request whose
 * agentId does not match.
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat ownership tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat ownership transitions (BLA-206 / BLA-207)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-ownership-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    runningProcesses.clear();
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    runningProcesses.clear();
    await tempDb?.cleanup();
  });

  async function seedTwoAgents() {
    const companyId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Test Company",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    const agentAId = randomUUID();
    const agentBId = randomUUID();

    await db.insert(agents).values([
      {
        id: agentAId,
        companyId,
        name: "Agent Alpha",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: agentBId,
        companyId,
        name: "Agent Beta",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    return { companyId, issuePrefix, agentAId, agentBId };
  }

  /**
   * BLA-207 regression: assign issue to agent A → checkout by agent A → issue
   * reassigned to agent B → agent A's orphaned run is reaped →
   * agent A's deferred wakeup MUST NOT be promoted (assigneeAgentId stays B).
   */
  it("BLA-207: reaping agent A run does not promote its deferred wakeup when issue was reassigned to agent B", async () => {
    const { companyId, issuePrefix, agentAId, agentBId } = await seedTwoAgents();

    const issueId = randomUUID();
    const runAId = randomUUID();
    const wakeupAId = randomUUID();
    const deferredWakeupAId = randomUUID();
    const now = new Date("2026-01-01T00:00:00.000Z");

    // Active wakeup / run for agent A that holds execution lock on the issue
    await db.insert(agentWakeupRequests).values({
      id: wakeupAId,
      companyId,
      agentId: agentAId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "claimed",
      runId: runAId,
      claimedAt: now,
    });

    await db.insert(heartbeatRuns).values({
      id: runAId,
      companyId,
      agentId: agentAId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      wakeupRequestId: wakeupAId,
      contextSnapshot: { issueId },
      // Non-zero dead PID so reapOrphanedRuns picks this up as a lost process.
      // processLossRetryCount=1 bypasses the one-retry grace path so
      // releaseIssueExecutionAndPromote is invoked directly.
      processPid: 999_999_999,
      processLossRetryCount: 1,
      startedAt: now,
      updatedAt: now,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Ownership transition test issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentAId,
      checkoutRunId: runAId,
      executionRunId: runAId,
      executionAgentNameKey: "agent alpha",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    // A deferred wakeup for agent A is already queued (e.g. arrived during execution)
    await db.insert(agentWakeupRequests).values({
      id: deferredWakeupAId,
      companyId,
      agentId: agentAId,
      source: "on_demand",
      triggerDetail: "system",
      reason: "issue_comment_wake",
      payload: { issueId },
      status: "deferred_issue_execution",
      requestedAt: new Date("2026-01-01T00:00:05.000Z"),
    });

    // Operator reassigns the issue to agent B — clears checkout lock but
    // executionRunId still points to agent A's running run (mirrors real server
    // behavior where update() clears checkoutRunId on assignee change but the
    // execution lock is only released when the run itself completes/is reaped).
    await db
      .update(issues)
      .set({
        assigneeAgentId: agentBId,
        checkoutRunId: null,
        updatedAt: new Date("2026-01-01T00:00:10.000Z"),
      })
      .where(eq(issues.id, issueId));

    // Reap agent A's orphaned run
    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);

    // Issue must remain owned by agent B
    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    expect(issue?.assigneeAgentId).toBe(agentBId);
    expect(issue?.executionRunId).toBeNull();
    expect(issue?.executionAgentNameKey).toBeNull();

    // Agent A's deferred wakeup must be failed, not promoted to a new run
    const deferred = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, deferredWakeupAId))
      .then((rows) => rows[0] ?? null);

    expect(deferred?.status).toBe("failed");
    expect(deferred?.error).toContain("assigneeAgentId is authoritative");

    // No new heartbeat run must have been created for agent A on this issue
    const agentARuns = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentAId));
    // Only the original (now failed) run — no promoted run
    expect(agentARuns).toHaveLength(1);
    expect(agentARuns[0]?.status).toBe("failed");
  });

  /**
   * BLA-206 regression: a deferred wakeup queued by agent A (e.g. EPM
   * scavenging an issue it thought was unowned) must not be promoted into
   * execution once the issue's assigneeAgentId is set to agent B — even when
   * agent A's run for a different reason completes and triggers the promotion
   * sweep.
   *
   * Scenario: agent A has a stale deferred request on the issue; agent A's
   * orphaned run is reaped; releaseIssueExecutionAndPromote must skip agent A's
   * deferred request because issue.assigneeAgentId = agentBId ≠ agentAId.
   */
  it("BLA-206: stale deferred wakeup from agent A is not promoted when issue is owned by agent B", async () => {
    const { companyId, issuePrefix, agentAId, agentBId } = await seedTwoAgents();

    const issueId = randomUUID();
    const runAId = randomUUID();
    const wakeupAId = randomUUID();
    const deferredScavengeId = randomUUID();
    const now = new Date("2026-01-01T00:00:00.000Z");

    // Agent A has a running heartbeat (on some other work), holding the execution
    // lock on this issue via a stale executionRunId (as would happen if EPM's
    // scavenge path set the lock before the operator re-routed).
    await db.insert(agentWakeupRequests).values({
      id: wakeupAId,
      companyId,
      agentId: agentAId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "claimed",
      runId: runAId,
      claimedAt: now,
    });

    await db.insert(heartbeatRuns).values({
      id: runAId,
      companyId,
      agentId: agentAId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      wakeupRequestId: wakeupAId,
      contextSnapshot: { issueId },
      processPid: 999_999_999, // dead — will be reaped
      processLossRetryCount: 1, // retry exhausted; promotes directly
      startedAt: now,
      updatedAt: now,
    });

    // Issue is already assigned to agent B (the legitimate owner)
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Pre-assigned issue (BLA-206 scenario)",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentBId,
      executionRunId: runAId, // stale lock from agent A's scavenge
      executionAgentNameKey: "agent alpha",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    // Agent A's scavenge queued a deferred wakeup on the issue before the
    // operator corrected the assignment.
    await db.insert(agentWakeupRequests).values({
      id: deferredScavengeId,
      companyId,
      agentId: agentAId,
      source: "automation",
      triggerDetail: "system",
      reason: "scavenge_sprint_child",
      payload: { issueId },
      status: "deferred_issue_execution",
      requestedAt: new Date("2026-01-01T00:00:02.000Z"),
    });

    // Reap agent A's orphaned run
    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);

    // Issue must remain owned by agent B
    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    expect(issue?.assigneeAgentId).toBe(agentBId);
    expect(issue?.executionRunId).toBeNull();
    expect(issue?.executionAgentNameKey).toBeNull();

    // Agent A's scavenge deferred must be failed, not promoted
    const scavenge = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, deferredScavengeId))
      .then((rows) => rows[0] ?? null);

    expect(scavenge?.status).toBe("failed");
    expect(scavenge?.error).toContain("assigneeAgentId is authoritative");

    // No new run must have been created for agent A
    const agentARuns = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentAId));
    expect(agentARuns).toHaveLength(1);
    expect(agentARuns[0]?.id).toBe(runAId);
    expect(agentARuns[0]?.status).toBe("failed");
  });
});
