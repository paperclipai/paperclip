import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
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

/**
 * Spec 0079 — when an issue is handed off in place (reassigned to a new agent
 * while it was checked out by a live run of the previous agent), the engine
 * defers the new assignee's wake and must promote it once the carrier is free.
 *
 * The dominant suspect (spec §1) is the legacy re-adoption
 * (heartbeat.ts:10142-10181): when the carrier has no active execution run, the
 * engine re-locks it to ANY queued/running run whose contextSnapshot.issueId =
 * carrier, WITHOUT checking that run belongs to the current assignee. A stale
 * continuation run of the previous owner therefore re-locks the carrier to the
 * outgoing agent, and the new assignee's wake is orphaned (deferred forever).
 */
describe("spec 0079 — deferred wake handoff promotion", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("paperclip-deferred-wake-handoff-");
    db = createDb(started.connectionString);
    tempDb = started;
  }, 120_000);

  afterAll(async () => {
    await closeDbClient(db);
    await tempDb?.cleanup();
  });

  it("wakes the new assignee even when a stale continuation run of the previous owner is queued on the carrier", async () => {
    const companyId = randomUUID();
    const previousOwnerId = randomUUID(); // agent A (the outgoing triage)
    const newAssigneeId = randomUUID(); // agent B (the gate)
    const issueId = randomUUID();
    const otherIssueId = randomUUID();
    const staleRunId = randomUUID();
    const busyRunId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    // A is a root agent (invokable); B reports to A (invokable via the chain).
    await db.insert(agents).values([
      {
        id: previousOwnerId,
        companyId,
        name: "Triage",
        role: "ceo",
        status: "running",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: newAssigneeId,
        companyId,
        name: "Director of Data",
        role: "manager",
        status: "idle",
        reportsTo: previousOwnerId,
        adapterType: "process",
        adapterConfig: {},
        // One concurrency slot, occupied by B's own in-flight run below, so the
        // promoted carrier wake stays queued (no adapter execution in this unit
        // test).
        runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
        permissions: {},
      },
    ]);

    // B's own in-flight run (occupies its concurrency slot). Inserted before the
    // issues so the carrier issue's execution_run_id FK can reference it.
    await db.insert(heartbeatRuns).values({
      id: busyRunId,
      companyId,
      agentId: newAssigneeId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: {
        issueId: otherIssueId,
        taskId: otherIssueId,
        wakeReason: "issue_assigned",
      },
    });

    // The in-place handoff is done: the carrier is now assigned to B, the
    // triage's original run has ended, and the execution lock is released.
    await db.insert(issues).values([
      {
        id: issueId,
        companyId,
        title: "Governed case carrier",
        status: "todo",
        priority: "medium",
        assigneeAgentId: newAssigneeId,
        executionRunId: null,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        // B is a busy manager: it already has a run in flight on its own work.
        // This occupies B's single concurrency slot so the promoted wake stays
        // queued (no real adapter execution in this unit test); it does not
        // touch the carrier and is unrelated to the re-adoption under test.
        id: otherIssueId,
        companyId,
        title: "B's own in-flight work",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: newAssigneeId,
        executionRunId: busyRunId,
        executionAgentNameKey: "director_of_data",
        executionLockedAt: new Date(),
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);

    // A stale continuation run of the PREVIOUS owner (A), still queued on the
    // carrier. This is the run the legacy re-adoption latches onto.
    await db.insert(heartbeatRuns).values({
      id: staleRunId,
      companyId,
      agentId: previousOwnerId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "queued",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "run_liveness_continuation",
      },
    });

    // The assignment wake for the new owner B (what routes/issues.ts fires on
    // an in-place reassignment).
    const wokenRun = await heartbeat.wakeup(newAssigneeId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_assigned",
      },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });

    // The new assignee must be woken — a queued run for B on the carrier.
    expect(wokenRun).not.toBeNull();
    expect(wokenRun?.agentId).toBe(newAssigneeId);

    // No deferred wake left orphaned for B.
    const deferredForB = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.agentId, newAssigneeId),
          eq(agentWakeupRequests.status, "deferred_issue_execution"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    expect(deferredForB).toBeNull();

    // B has exactly one run scoped to the carrier, and it is active (queued),
    // not deferred. (B's busy slot keeps it from starting in this unit test.)
    const carrierRunsForB = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, newAssigneeId))
      .then((rows) =>
        rows.filter((run) => (run.contextSnapshot as Record<string, unknown>)?.issueId === issueId),
      );
    expect(carrierRunsForB).toHaveLength(1);
    expect(carrierRunsForB[0]?.status).toBe("queued");

    // The carrier's stale run of the previous owner was NOT re-adopted as the
    // execution lock (root cause, CA-8).
    const issueAfter = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(issueAfter?.executionRunId).not.toBe(staleRunId);

    // The fix does NOT over-correct: the previous owner's stale run is left in
    // place (still queued), to be cancelled lazily at claim time by the engine's
    // existing evaluateQueuedRunStaleness → "issue_assignee_changed" path. It is
    // not eagerly cancelled in the wake handler.
    const staleRunAfter = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, staleRunId))
      .then((rows) => rows[0]);
    expect(staleRunAfter?.status).toBe("queued");
  });

  it("still defers the new assignee while the previous owner's run is genuinely running on the carrier (CA-3: one agent at a time)", async () => {
    const companyId = randomUUID();
    const previousOwnerId = randomUUID(); // agent A
    const newAssigneeId = randomUUID(); // agent B
    const issueId = randomUUID();
    const activeRunId = randomUUID();
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
        id: previousOwnerId,
        companyId,
        name: "Triage",
        role: "ceo",
        status: "running",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: newAssigneeId,
        companyId,
        name: "Director of Data",
        role: "manager",
        status: "idle",
        reportsTo: previousOwnerId,
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    // The previous owner A's run is GENUINELY RUNNING and still holds the
    // execution lock (mid-handoff: the carrier was reassigned to B but A's run
    // has not finished). The wake for B must be deferred, never started.
    await db.insert(heartbeatRuns).values({
      id: activeRunId,
      companyId,
      agentId: previousOwnerId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Governed case carrier (lock held)",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: newAssigneeId,
      executionRunId: activeRunId,
      executionAgentNameKey: "triage",
      executionLockedAt: new Date(),
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    const wokenRun = await heartbeat.wakeup(newAssigneeId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });

    // No premature promotion: B is deferred while A genuinely runs.
    expect(wokenRun).toBeNull();

    const deferredForB = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.agentId, newAssigneeId),
          eq(agentWakeupRequests.status, "deferred_issue_execution"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    expect(deferredForB).not.toBeNull();

    // The active lock of A is untouched; B has no run.
    const issueAfter = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(issueAfter?.executionRunId).toBe(activeRunId);

    const bRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, newAssigneeId));
    expect(bRuns).toHaveLength(0);
  });

  it("still re-adopts a run that belongs to the issue's CURRENT assignee (crash/continuation recovery preserved)", async () => {
    const companyId = randomUUID();
    const ownerId = randomUUID(); // agent A, still the assignee
    const issueId = randomUUID();
    const otherIssueId = randomUUID();
    const continuationRunId = randomUUID();
    const busyRunId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const heartbeat = heartbeatService(db);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: ownerId,
      companyId,
      name: "Owner",
      role: "ceo",
      status: "running",
      adapterType: "process",
      adapterConfig: {},
      // One slot, occupied below, so the re-adopted/coalesced run stays queued.
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
      permissions: {},
    });

    // A busy run on unrelated work occupies the agent's single slot.
    await db.insert(heartbeatRuns).values({
      id: busyRunId,
      companyId,
      agentId: ownerId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId: otherIssueId, taskId: otherIssueId, wakeReason: "issue_assigned" },
    });

    await db.insert(issues).values([
      {
        id: issueId,
        companyId,
        title: "Owner's own carrier (lock released, run still queued)",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: ownerId,
        executionRunId: null,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: otherIssueId,
        companyId,
        title: "Owner's unrelated in-flight work",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: ownerId,
        executionRunId: busyRunId,
        executionAgentNameKey: "owner",
        executionLockedAt: new Date(),
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);

    // A queued continuation run of the SAME assignee on the carrier — the engine
    // SHOULD re-adopt it (this is the legitimate crash/continuation recovery the
    // re-adoption exists for).
    await db.insert(heartbeatRuns).values({
      id: continuationRunId,
      companyId,
      agentId: ownerId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "queued",
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "run_liveness_continuation" },
    });

    const wokenRun = await heartbeat.wakeup(ownerId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });

    // Same-agent wake coalesces into the re-adopted run (not null, not deferred).
    expect(wokenRun).not.toBeNull();

    // The carrier was re-locked to the assignee's own continuation run.
    const issueAfter = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(issueAfter?.executionRunId).toBe(continuationRunId);

    const deferred = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.status, "deferred_issue_execution"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    expect(deferred).toBeNull();

    // No duplicate run was created for the carrier.
    const carrierRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, ownerId))
      .then((rows) =>
        rows.filter((run) => (run.contextSnapshot as Record<string, unknown>)?.issueId === issueId),
      );
    expect(carrierRuns).toHaveLength(1);
    expect(carrierRuns[0]?.id).toBe(continuationRunId);
  });
});
