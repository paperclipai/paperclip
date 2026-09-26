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
});

/**
 * Database-backed coverage for the assignee exemption on the fail-closed
 * `no_context_source_and_target_unbound` branch.
 *
 * The in-memory suite cannot hold this line. Its fake `db` returns a supplied
 * issue row from a `where()` that ignores its own predicate, so those tests
 * still pass when the production lookup selects the wrong issue or drops the
 * company scope. That is precisely the failure a cross-company authorization
 * relaxation cannot afford, so the exemption is pinned here against a real
 * database where `issues.id` and `issues.company_id` are actually the columns
 * the query filters on.
 */
describeEmbeddedPostgres("cross-issue assignee exemption (postgres)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let issueSequence = 0;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-assignee-cap-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  // `issues` references both `agents` and `heartbeatRuns`, so it has to go
  // before them. Every assertion is scoped to its own seeded run rather than
  // relying on the table being empty. A failed delete is not swallowed: the
  // order above is the only order the foreign keys allow, so a delete that
  // throws is the real reason a later seed failed, and hiding it would turn
  // fixture isolation into a mystery.
  afterEach(async () => {
    const cleanups = [
      () => db.delete(activityLog),
      () => db.delete(issues),
      () => db.delete(heartbeatRuns),
      () => db.delete(agents),
      () => db.delete(companies),
    ];
    for (const cleanup of cleanups) await cleanup();
  });

  afterAll(async () => {
    // End the client before stopping the server, so an in-flight write cannot
    // fire against a dropped socket.
    await db.$client.end();
    await tempDb?.cleanup();
  });

  async function seedCompany(name: string) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `${name.replace(/[^A-Za-z]/g, "").slice(0, 6).toUpperCase()}${companyId
        .replace(/-/g, "")
        .slice(0, 3)
        .toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  /** A run with no context source issue: the only shape that reaches the gate. */
  async function seedSourceLessRun(companyId: string, agentId: string, status = "running") {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status,
      responsibleUserId: "board-user",
      contextSnapshot: {},
    });
    return runId;
  }

  async function seedIssue(options: {
    companyId: string;
    identifier: string;
    assigneeAgentId?: string | null;
    checkoutRunId?: string | null;
    executionRunId?: string | null;
  }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: options.companyId,
      identifier: options.identifier,
      title: `issue ${options.identifier}`,
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: options.assigneeAgentId ?? null,
      checkoutRunId: options.checkoutRunId ?? null,
      executionRunId: options.executionRunId ?? null,
    });
    return issueId;
  }

  async function recordedActions(runId: string) {
    return db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(eq(activityLog.runId, runId));
  }

  it("admits the assignee when the target resolves through the real query", async () => {
    const companyId = await seedCompany("Assignee");
    const agentId = await seedAgent(companyId, "Assignee Agent");
    const runId = await seedSourceLessRun(companyId, agentId);
    issueSequence += 1;
    const targetIssueId = await seedIssue({
      companyId,
      identifier: `ASG-${issueSequence}`,
      assigneeAgentId: agentId,
    });

    // The whole point of the exemption: the assignee can record a finding on
    // its own ticket instead of opening a duplicate.
    await expect(
      observeCrossIssueInfluence(db, {
        companyId,
        runId,
        agentId,
        targetIssueId,
        kind: "comment",
        now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
      }),
    ).resolves.toBeNull();

    // Exempt means uncounted, not merely allowed: nothing is written to the
    // shared budget.
    expect(await recordedActions(runId)).toEqual([]);
  });

  it("still refuses the write when the agent is not the assignee", async () => {
    const companyId = await seedCompany("NonAssignee");
    const agentId = await seedAgent(companyId, "Writing Agent");
    const otherAgentId = await seedAgent(companyId, "Other Agent");
    const runId = await seedSourceLessRun(companyId, agentId);
    issueSequence += 1;
    const targetIssueId = await seedIssue({
      companyId,
      identifier: `NAS-${issueSequence}`,
      assigneeAgentId: otherAgentId,
    });

    // Same real query path as the admitted case above, opposite relationship.
    // Without this the file would prove the exemption fires but never prove the
    // containment around it.
    await expect(
      observeCrossIssueInfluence(db, {
        companyId,
        runId,
        agentId,
        targetIssueId,
        kind: "comment",
        now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
      }),
    ).rejects.toMatchObject({
      status: 403,
      details: {
        code: "cross_issue_influence_run_context_required",
        reason: "no_context_source_and_target_unbound",
      },
    });

    expect(await recordedActions(runId)).toEqual([]);
  });

  it("does not exempt a sibling issue the agent owns when a different issue is the target", async () => {
    const companyId = await seedCompany("Sibling");
    const agentId = await seedAgent(companyId, "Owning Agent");
    const runId = await seedSourceLessRun(companyId, agentId);
    issueSequence += 1;

    // The agent is the assignee of a *sibling*, not of the target. A lookup
    // that matched on the assignee alone, or that ignored `issues.id`, would
    // return the sibling and wrongly exempt this write.
    await seedIssue({
      companyId,
      identifier: `SIB-${issueSequence}-OWNED`,
      assigneeAgentId: agentId,
    });
    const targetIssueId = await seedIssue({
      companyId,
      identifier: `SIB-${issueSequence}-TARGET`,
      assigneeAgentId: null,
    });

    await expect(
      observeCrossIssueInfluence(db, {
        companyId,
        runId,
        agentId,
        targetIssueId,
        kind: "comment",
        now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
      }),
    ).rejects.toMatchObject({
      status: 403,
      details: { reason: "no_context_source_and_target_unbound" },
    });

    expect(await recordedActions(runId)).toEqual([]);
  });

  it("does not exempt a target that belongs to another company", async () => {
    const companyId = await seedCompany("Home");
    const otherCompanyId = await seedCompany("Foreign");
    const agentId = await seedAgent(companyId, "Home Agent");
    const runId = await seedSourceLessRun(companyId, agentId);
    issueSequence += 1;

    // The agent is genuinely the assignee of this issue, and the run genuinely
    // belongs to another company. The lookup filters on `issues.company_id`, so
    // the row must not be visible: dropping that predicate would let a run in
    // one company write into another company's board.
    const foreignIssueId = await seedIssue({
      companyId: otherCompanyId,
      identifier: `FOR-${issueSequence}`,
      assigneeAgentId: agentId,
    });

    await expect(
      observeCrossIssueInfluence(db, {
        companyId,
        runId,
        agentId,
        targetIssueId: foreignIssueId,
        kind: "comment",
        now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
      }),
    ).rejects.toMatchObject({
      status: 403,
      details: {
        code: "cross_issue_influence_run_context_required",
        reason: "no_context_source_and_target_unbound",
      },
    });

    expect(await recordedActions(runId)).toEqual([]);
  });

  it("exempts a target bound to the run by checkout or execution, resolved through the real query", async () => {
    const companyId = await seedCompany("Bound");
    const agentId = await seedAgent(companyId, "Bound Agent");
    issueSequence += 1;

    for (const binding of ["checkoutRunId", "executionRunId"] as const) {
      const runId = await seedSourceLessRun(companyId, agentId);
      const targetIssueId = await seedIssue({
        companyId,
        identifier: `BND-${issueSequence}-${binding}`,
        assigneeAgentId: null,
        [binding]: runId,
      });

      await expect(
        observeCrossIssueInfluence(db, {
          companyId,
          runId,
          agentId,
          targetIssueId,
          kind: "comment",
          now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
        }),
      ).resolves.toBeNull();

      expect(await recordedActions(runId)).toEqual([]);
    }
  });

  it("does not trust a terminal run's stale binding on the target", async () => {
    const companyId = await seedCompany("Stale");
    const agentId = await seedAgent(companyId, "Stale Agent");

    for (const status of ["succeeded", "failed", "cancelled", "timed_out", "interrupted"] as const) {
      issueSequence += 1;
      const runId = await seedSourceLessRun(companyId, agentId, status);
      const targetIssueId = await seedIssue({
        companyId,
        identifier: `STL-${issueSequence}`,
        assigneeAgentId: null,
        checkoutRunId: runId,
        executionRunId: runId,
      });

      await expect(
        observeCrossIssueInfluence(db, {
          companyId,
          runId,
          agentId,
          targetIssueId,
          kind: "comment",
          now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
        }),
      ).rejects.toMatchObject({
        status: 403,
        details: { reason: "no_context_source_and_target_unbound" },
      });

      expect(await recordedActions(runId)).toEqual([]);
    }
  });
});
