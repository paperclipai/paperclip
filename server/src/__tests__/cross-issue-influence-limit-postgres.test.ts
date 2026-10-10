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
  CROSS_ISSUE_INFLUENCE_LIMIT,
  ISSUE_CREATE_RUN_ENFORCE_AT,
  ISSUE_CREATE_RUN_LIMIT,
  observeCrossIssueInfluence,
  observeIssueCreate,
  recordRefusedIssueCreate,
} from "../services/cross-issue-influence-limit.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("cross-issue influence limit PostgreSQL serialization", () => {
  /**
   * `observeIssueCreate` takes a transaction, not a `Db`: its run-row lock only
   * serializes inside one, and in production it shares the create's transaction so
   * the charge and the task commit together. Tests therefore open one per attempt,
   * which is also what makes the concurrency case below a real race.
   */
  const charge = (input: Parameters<typeof observeIssueCreate>[1]) =>
    db.transaction((tx) => observeIssueCreate(tx, input));

  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cross-issue-cap-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    // Before heartbeatRuns and agents: issues reference both.
    await db.delete(issues);
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

  // The create budget's own lock. Creates race exactly like comments do, and the
  // decision is derived from a COUNT taken inside the transaction that holds the run
  // row — so only real SQL proves two concurrent creates cannot both read 39.
  it("lets exactly one of concurrent creates take the fortieth slot", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const sourceIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Create Sprayer",
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
      Array.from({ length: ISSUE_CREATE_RUN_LIMIT - 2 }, () => ({
        companyId,
        actorType: "agent" as const,
        actorId: agentId,
        agentId,
        runId,
        action: "issue.issue_create_observed",
        // No issue exists when a create is charged, so the ledger is keyed on the run.
        entityType: "heartbeat_run",
        entityId: runId,
      })),
    );

    const input = {
      companyId,
      runId,
      agentId,
      parentIssueId: null,
      title: "Throwaway probe",
      now: ISSUE_CREATE_RUN_ENFORCE_AT,
    };
    const decisions = await Promise.all([
      charge(input),
      charge(input),
      charge(input),
    ]);

    expect(decisions.map((decision) => decision?.allowed).sort()).toEqual([false, true, true]);
    expect(decisions.map((decision) => decision?.count).sort((a, b) => Number(a) - Number(b)))
      .toEqual([ISSUE_CREATE_RUN_LIMIT - 1, ISSUE_CREATE_RUN_LIMIT, ISSUE_CREATE_RUN_LIMIT + 1]);

    const recorded = await db
      .select({ action: activityLog.action, entityType: activityLog.entityType, entityId: activityLog.entityId })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.runId, runId)));
    expect(recorded.filter((row) => row.action === "issue.issue_create_observed"))
      .toHaveLength(ISSUE_CREATE_RUN_LIMIT);
    // The observer records only the charge it takes. A refusal is recorded by the
    // caller *after* its transaction unwinds — see the two tests below for why it
    // cannot be written here — so none of these three attempts left one.
    expect(recorded.filter((row) => row.action === "issue.issue_create_cap_rejected"))
      .toEqual([]);
    // Nothing landed on the shared comment counter.
    expect(recorded.filter((row) => row.action.startsWith("issue.cross_issue_influence"))).toEqual([]);
  });

  // The charge has to vanish with the task when the create transaction rolls back,
  // or a failed insert silently spends a slot. Only real SQL shows that; the unit
  // fake has no rollback.
  it("rolls the charge back with the transaction that was going to insert", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Rolled Back",
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
      contextSnapshot: { issueId: randomUUID() },
      responsibleUserId: "board-user",
    });

    const input = {
      companyId,
      runId,
      agentId,
      parentIssueId: null,
      title: "Insert that fails",
      now: ISSUE_CREATE_RUN_ENFORCE_AT,
    };

    await expect(db.transaction(async (tx) => {
      await expect(observeIssueCreate(tx, input)).resolves.toMatchObject({
        count: 1,
        allowed: true,
      });
      throw new Error("the insert failed after the charge");
    })).rejects.toThrow("the insert failed after the charge");

    // Charged inside the aborted transaction, so the slot was never spent.
    expect(await db.select().from(activityLog)).toEqual([]);
    // And the next attempt is still attempt 1, not attempt 2.
    await expect(charge(input)).resolves.toMatchObject({ count: 1, allowed: true });
  });

  // Greptile P2 on the in-transaction charge: a refusal throws, the throw rolls the
  // transaction back, and a refusal row written inside it would roll back too —
  // leaving operators nothing but server logs. It also cannot be written from a
  // second connection while the first still holds the run row `FOR UPDATE`: the
  // `activity_log.run_id` foreign key needs `FOR KEY SHARE` on that row, which
  // conflicts, so the two would deadlock. Hence a separate recorder, called after.
  it("records a refused create durably, after the create transaction has gone", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Refused",
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
      contextSnapshot: { issueId: randomUUID() },
      responsibleUserId: "board-user",
    });
    await db.insert(activityLog).values(
      Array.from({ length: ISSUE_CREATE_RUN_LIMIT }, () => ({
        companyId,
        actorType: "agent" as const,
        actorId: agentId,
        agentId,
        runId,
        action: "issue.issue_create_observed",
        entityType: "heartbeat_run",
        entityId: runId,
      })),
    );

    const input = {
      companyId,
      runId,
      agentId,
      parentIssueId: null,
      title: "Throwaway probe 41",
      now: ISSUE_CREATE_RUN_ENFORCE_AT,
    };

    // The route's shape: charge inside the transaction, refuse, let it unwind, then
    // record the refusal on a connection the rollback cannot reach.
    const decision = await db.transaction(async (tx) => {
      const refused = await observeIssueCreate(tx, input);
      expect(refused).toMatchObject({ allowed: false, count: ISSUE_CREATE_RUN_LIMIT + 1 });
      return refused;
    });
    await recordRefusedIssueCreate(db, { ...input, decision: decision! });

    const rejected = await db
      .select({ action: activityLog.action, entityType: activityLog.entityType, entityId: activityLog.entityId, details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.runId, runId), eq(activityLog.action, "issue.issue_create_cap_rejected")));
    expect(rejected).toEqual([{
      action: "issue.issue_create_cap_rejected",
      entityType: "heartbeat_run",
      entityId: runId,
      details: expect.objectContaining({
        title: "Throwaway probe 41",
        cap: ISSUE_CREATE_RUN_LIMIT,
        count: ISSUE_CREATE_RUN_LIMIT + 1,
        allowed: false,
      }),
    }]);
    // The refusal is not a charge: the observed tally is untouched.
    const observed = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(and(eq(activityLog.runId, runId), eq(activityLog.action, "issue.issue_create_observed")));
    expect(observed).toHaveLength(ISSUE_CREATE_RUN_LIMIT);
  });

  // Decomposition under your own epic is free. The predicate is `runScopeIsIssue`,
  // shared with the comment guard, but the parent it is applied to comes from the
  // request — so the real-SQL check is that the run row's snapshot is what it reads.
  it("charges a foreign-parent create and leaves a create under the run's own issue free", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const sourceIssueId = randomUUID();
    const foreignParentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Planner",
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
    await db.insert(issues).values([
      { id: sourceIssueId, companyId, title: "The epic this run owns" },
      { id: foreignParentId, companyId, title: "Someone else's epic" },
    ]);

    const base = { companyId, runId, agentId, now: ISSUE_CREATE_RUN_ENFORCE_AT };

    // Twice, to prove the free path is not a one-shot: a planning run decomposing its
    // own epic into a wave of stages is never bounded.
    await expect(charge({ ...base, parentIssueId: sourceIssueId, title: "[stage:plan]" }))
      .resolves.toBeNull();
    await expect(charge({ ...base, parentIssueId: sourceIssueId, title: "[stage:implement]" }))
      .resolves.toBeNull();
    await expect(charge({ ...base, parentIssueId: foreignParentId, title: "Under a foreign epic" }))
      .resolves.toMatchObject({ count: 1, allowed: true });
    await expect(charge({ ...base, parentIssueId: null, title: "Rootless" }))
      .resolves.toMatchObject({ count: 2, allowed: true });

    const recorded = await db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.runId, runId)));
    expect(recorded.map((row) => (row.details as { title: string }).title))
      .toEqual(["Under a foreign epic", "Rootless"]);
    for (const row of recorded) {
      expect(row.action).toBe("issue.issue_create_observed");
      expect((row.details as { sourceIssueId: string }).sourceIssueId).toBe(sourceIssueId);
    }
  });

  // The point of a *separate* budget: the two counters must not see each
  // other's rows. The tally is a COUNT filtered by `action`, so a dropped filter would
  // fold creates into the shared 20 and silently refuse a correct planning run.
  it("keeps the create ledger and the cross-issue ledger independent", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const spentCommentsRunId = randomUUID();
    const spentCreatesRunId = randomUUID();
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
      name: "Budget Boundary",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    for (const id of [spentCommentsRunId, spentCreatesRunId]) {
      await db.insert(heartbeatRuns).values({
        id,
        companyId,
        agentId,
        status: "running",
        responsibleUserId: "board-user",
        contextSnapshot: { issueId: sourceIssueId },
      });
    }
    await db.insert(issues).values({ id: targetIssueId, companyId, title: "Elsewhere" });
    // One run has spent all 20 cross-issue writes; the other has spent all 40 creates.
    await db.insert(activityLog).values([
      ...Array.from({ length: CROSS_ISSUE_INFLUENCE_LIMIT }, () => ({
        companyId,
        actorType: "agent" as const,
        actorId: agentId,
        agentId,
        runId: spentCommentsRunId,
        action: "issue.cross_issue_influence_observed",
        entityType: "issue",
        entityId: targetIssueId,
      })),
      ...Array.from({ length: ISSUE_CREATE_RUN_LIMIT }, () => ({
        companyId,
        actorType: "agent" as const,
        actorId: agentId,
        agentId,
        runId: spentCreatesRunId,
        action: "issue.issue_create_observed",
        entityType: "heartbeat_run",
        entityId: spentCreatesRunId,
      })),
    ]);

    // A run out of comments is still on create attempt 1.
    await expect(charge({
      companyId,
      runId: spentCommentsRunId,
      agentId,
      parentIssueId: null,
      title: "First create of the run",
      now: ISSUE_CREATE_RUN_ENFORCE_AT,
    })).resolves.toMatchObject({ count: 1, cap: ISSUE_CREATE_RUN_LIMIT, allowed: true });

    // And a run out of creates is still on cross-issue attempt 1.
    await expect(observeCrossIssueInfluence(db, {
      companyId,
      runId: spentCreatesRunId,
      agentId,
      targetIssueId,
      kind: "comment",
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    })).resolves.toMatchObject({ count: 1, cap: CROSS_ISSUE_INFLUENCE_LIMIT, allowed: true });
  });
});
