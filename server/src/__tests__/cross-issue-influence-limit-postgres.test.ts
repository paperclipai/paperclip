import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
  observeCrossIssueInfluence,
} from "../services/cross-issue-influence-limit.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("cross-issue influence limit PostgreSQL serialization", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cross-issue-cap-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("allows exactly one of concurrent attempts 20 and 21", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const sourceIssueId = randomUUID();
    const targetIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Concurrent Coder",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      responsibleUserId: "board-user",
      contextSnapshot: { issueId: sourceIssueId },
    });
    await db.insert(activityLog).values(
      Array.from({ length: 18 }, () => ({
        companyId,
        actorType: "agent" as const,
        actorId: agentId,
        agentId,
        runId,
        action: "issue.cross_issue_influence_observed",
        entityType: "issue",
        entityId: targetIssueId,
      })),
    );

    const input = {
      companyId,
      runId,
      agentId,
      targetIssueId,
      targetIssueIdentifier: "CAP-2",
      kind: "comment" as const,
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    };
    // A comment, a PATCH, and an issue-thread interaction resolution race for the
    // last slot of the shared budget: the row lock must let exactly one of 19/20
    // through per attempt and fail the twenty-first closed.
    const decisions = await Promise.all([
      observeCrossIssueInfluence(db, input),
      observeCrossIssueInfluence(db, { ...input, kind: "update" }),
      observeCrossIssueInfluence(db, { ...input, kind: "interaction_resolution" }),
    ]);

    expect(decisions.map((decision) => decision?.allowed).sort()).toEqual([false, true, true]);
    expect(decisions.map((decision) => decision?.count).sort((a, b) => Number(a) - Number(b)))
      .toEqual([19, 20, 21]);

    const recorded = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.runId, runId)));
    expect(recorded.filter((row) => row.action === "issue.cross_issue_influence_observed")).toHaveLength(20);
    expect(recorded.filter((row) => row.action === "issue.cross_issue_influence_cap_rejected")).toHaveLength(1);
  });

  // TES-43. A timer run is dispatched with no source issue, so the snapshot
  // carries nothing. Against a real database the run lock, the issue lookup, and
  // the `.for("update")` locking all have to hold, not just the pure helper.
  it("attributes a checkout-bound run whose snapshot names no issue", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Timer Coder",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      responsibleUserId: "board-user",
      contextSnapshot: {},
    });
    // Exactly what svc.checkout writes for the run that owns this issue.
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "TES-43",
      title: "checkout-bound heartbeat run",
      status: "in_progress",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
    });

    await expect(observeCrossIssueInfluence(db, {
      companyId,
      runId,
      agentId,
      targetIssueId: issueId,
      targetIssueIdentifier: "TES-43",
      kind: "comment",
    })).resolves.toBeNull();
  });

  // TES-101. The 403 tells an agent that checking a task out is how to get a
  // write channel, so against a real database the run's *own* checked-out issue
  // has to satisfy the guard for any target. Otherwise the recovery step costs a
  // checkout and changes nothing, and no agent can clear the status of an issue
  // it did not wake on.
  it("admits a run bound to one task writing to a different issue", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const checkedOutIssueId = randomUUID();
    const targetIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Timer Coder",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      responsibleUserId: "board-user",
      contextSnapshot: {},
    });
    // The run checked out task X and is writing to task Y.
    await db.insert(issues).values([
      {
        id: checkedOutIssueId,
        companyId,
        identifier: "TES-101",
        title: "the task this run owns",
        status: "in_progress",
        assigneeAgentId: agentId,
        checkoutRunId: runId,
        executionRunId: runId,
      },
      {
        id: targetIssueId,
        companyId,
        identifier: "TES-61",
        title: "the task this run is trying to unblock",
        status: "blocked",
        assigneeAgentId: agentId,
      },
    ]);

    await expect(observeCrossIssueInfluence(db, {
      companyId,
      runId,
      agentId,
      targetIssueId,
      targetIssueIdentifier: "TES-61",
      kind: "update",
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    })).resolves.toMatchObject({ allowed: true, count: 1, mode: "enforce" });

    // The per-source counter needs a real source, not the issue being written.
    const recorded = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.runId, runId),
        eq(activityLog.action, "issue.cross_issue_influence_observed"),
      ));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.details).toMatchObject({
      sourceIssueId: checkedOutIssueId,
      targetIssueId,
    });
  });

  // The exact transcript in TES-101, reproduced against a real database: a
  // timer run holds no wake binding, checks out its own task, and is then
  // refused for writing to a different one. Nothing about the target's own
  // binding can rescue that case, because the run does not hold the target.
  it("admits a run bound to one task writing to a different issue, and charges the bound task", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const checkedOutIssueId = randomUUID();
    const targetIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Timer Coder",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    // A timer run: no wake binding, nothing in the snapshot.
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      responsibleUserId: "board-user",
      contextSnapshot: {},
    });
    // Exactly what svc.checkout wrote on run f0f29e0f: both columns on the run's
    // own task, and nothing at all on the task it is trying to write to.
    await db.insert(issues).values([
      {
        id: checkedOutIssueId,
        companyId,
        identifier: "TES-98",
        title: "the task this run checked out",
        status: "in_progress",
        assigneeAgentId: agentId,
        checkoutRunId: runId,
        executionRunId: runId,
      },
      {
        id: targetIssueId,
        companyId,
        identifier: "TES-61",
        title: "the blocked task this run is trying to clear",
        status: "blocked",
        assigneeAgentId: agentId,
        checkoutRunId: null,
        executionRunId: null,
      },
    ]);

    await expect(observeCrossIssueInfluence(db, {
      companyId,
      runId,
      agentId,
      targetIssueId,
      targetIssueIdentifier: "TES-61",
      kind: "update",
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    })).resolves.toMatchObject({ allowed: true, count: 1, mode: "enforce" });

    // Charged to the task the run checked out, never the issue being written.
    const recorded = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.runId, runId),
        eq(activityLog.action, "issue.cross_issue_influence_observed"),
      ));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.details).toMatchObject({
      sourceIssueId: checkedOutIssueId,
      targetIssueId,
    });
  });

  // The run's own task is not cross-issue influence, so it must not spend the
  // budget, even with another link in play.
  it("does not count a write to the task the run is bound to", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const checkedOutIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Timer Coder",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      responsibleUserId: "board-user",
      contextSnapshot: {},
    });
    await db.insert(issues).values({
      id: checkedOutIssueId,
      companyId,
      identifier: "TES-98",
      title: "the task this run checked out",
      status: "in_progress",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
    });

    await expect(observeCrossIssueInfluence(db, {
      companyId,
      runId,
      agentId,
      targetIssueId: checkedOutIssueId,
      targetIssueIdentifier: "TES-98",
      kind: "update",
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    })).resolves.toBeNull();
  });

  it("still refuses a snapshot-less run that never checked the issue out", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const otherRunId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Timer Coder",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      responsibleUserId: "board-user",
      contextSnapshot: {},
    });
    // Another run holds the lock. Attribution must not be borrowed from it.
    // The FK on issues.checkout_run_id requires it to be a real run row.
    await db.insert(heartbeatRuns).values({
      id: otherRunId,
      companyId,
      agentId,
      status: "running",
      responsibleUserId: "board-user",
      contextSnapshot: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "TES-43",
      title: "issue checked out by a different run",
      status: "in_progress",
      assigneeAgentId: agentId,
      checkoutRunId: otherRunId,
      executionRunId: otherRunId,
    });

    await expect(observeCrossIssueInfluence(db, {
      companyId,
      runId,
      agentId,
      targetIssueId: issueId,
      targetIssueIdentifier: "TES-43",
      kind: "comment",
    })).rejects.toMatchObject({
      status: 403,
      details: { code: "cross_issue_influence_unattributed_run" },
    });
  });

  // TES-106. Acceptance case 1, against a real database, and the specific
  // regression this rebase exists to prevent: the refusal must name the
  // *unattributed* code, not the run-context one. The run row was found and the
  // caller's identity on it checked out, so the run-context copy — which tells
  // the agent to send X-Paperclip-Run-Id — is false advice, since that header
  // was the thing already read and accepted.
  it("refuses an unbound cross-issue write as unattributed, never as run-context", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const targetIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Timer Coder",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    // A live, correctly identified run that is bound to nothing: no snapshot
    // issue, and no issue anywhere carrying this run's binding.
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      responsibleUserId: "board-user",
      contextSnapshot: {},
    });
    await db.insert(issues).values({
      id: targetIssueId,
      companyId,
      identifier: "TES-61",
      title: "the task this run is trying to clear",
      status: "blocked",
      assigneeAgentId: agentId,
    });

    // The error is caught so the copy can be inspected, not just the code.
    const thrown = await observeCrossIssueInfluence(db, {
      companyId,
      runId,
      agentId,
      targetIssueId,
      targetIssueIdentifier: "TES-61",
      kind: "comment",
    }).then(
      () => null,
      (error: { status?: number; details?: { code?: string; description?: string } }) => error,
    );

    expect(thrown).toMatchObject({
      status: 403,
      details: { code: "cross_issue_influence_unattributed_run" },
    });
    // The regression itself: the refused write must not be told to resend a
    // header that was already read and validated above.
    expect(thrown?.details?.code).not.toBe("cross_issue_influence_run_context_required");
    expect(thrown?.details?.description ?? "").not.toMatch(/X-Paperclip-Run-Id/);

    // A refused write must not spend the budget.
    const observed = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.runId, runId)));
    expect(observed).toEqual([]);
  });
});
