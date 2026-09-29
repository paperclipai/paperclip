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
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedTasklessRun() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const targetIssueId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Manual run company",
      issuePrefix: `M${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Assigned agent", role: "engineer", status: "idle",
    });
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, status: "running",
      invocationSource: "on_demand", triggerDetail: "manual", contextSnapshot: {},
    });
    await db.insert(issues).values({
      id: targetIssueId, companyId, title: "Assigned at creation", status: "in_progress",
      assigneeAgentId: agentId, checkoutRunId: runId, executionRunId: runId,
    });
    return { companyId, agentId, runId, targetIssueId, now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT };
  }

  it("binds a manual run's held issue and preserves its source after completion", async () => {
    const input = await seedTasklessRun();
    for (const kind of ["comment", "update", "interaction_resolution"] as const) {
      expect(await observeCrossIssueInfluence(db, { ...input, kind })).toBeNull();
    }
    expect(await db.select().from(activityLog)).toHaveLength(1);
    await db.update(issues).set({ status: "done", checkoutRunId: null, executionRunId: null })
      .where(eq(issues.id, input.targetIssueId));
    expect(await observeCrossIssueInfluence(db, { ...input, kind: "comment" }))
      .toBeNull();
    const [receipt] = await db.select().from(activityLog);
    expect(receipt.action).toBe("issue.cross_issue_influence_source_bound");
    expect(receipt.details).toMatchObject({ sourceIssueId: input.targetIssueId });
  });

  it.each(["checkoutRunId", "executionRunId"] as const)(
    "accepts ownership established by %s alone", async (binding) => {
      const input = await seedTasklessRun();
      await db.update(issues).set({
        checkoutRunId: null, executionRunId: null, [binding]: input.runId,
      }).where(eq(issues.id, input.targetIssueId));
      expect(await observeCrossIssueInfluence(db, { ...input, kind: "comment" })).toBeNull();
    },
  );

  it.each([
    "assignment only", "other agent", "other company", "done", "cancelled",
    "conflicting checkout", "conflicting execution",
  ])("does not exempt a taskless write with %s", async (condition) => {
    const input = await seedTasklessRun();
    const otherCompanyId = randomUUID();
    const otherAgentId = randomUUID();
    const otherRunId = randomUUID();
    await db.insert(companies).values({ id: otherCompanyId, name: "Other company", issuePrefix: "OTHER" });
    await db.insert(agents).values({ id: otherAgentId, companyId: input.companyId, name: "Other agent", role: "engineer" });
    await db.insert(heartbeatRuns).values({ id: otherRunId, companyId: input.companyId, agentId: input.agentId, status: "running" });
    const patch: Partial<typeof issues.$inferInsert> =
      condition === "assignment only" ? { checkoutRunId: null, executionRunId: null } :
      condition === "other agent" ? { assigneeAgentId: otherAgentId } :
      condition === "other company" ? { companyId: otherCompanyId } :
      condition === "conflicting checkout" ? { checkoutRunId: otherRunId } :
      condition === "conflicting execution" ? { executionRunId: otherRunId } :
      { status: condition };
    await db.update(issues).set(patch).where(eq(issues.id, input.targetIssueId));
    expect(await observeCrossIssueInfluence(db, { ...input, kind: "update" }))
      .toMatchObject({ allowed: true, count: 1 });
  });

  it("serializes the cap for valid runs without a source", async () => {
    const input = await seedTasklessRun();
    await db.update(issues).set({ checkoutRunId: null, executionRunId: null })
      .where(eq(issues.id, input.targetIssueId));
    await db.insert(activityLog).values(Array.from({ length: 19 }, () => ({
      companyId: input.companyId, actorType: "agent", actorId: input.agentId, agentId: input.agentId,
      runId: input.runId, action: "issue.cross_issue_influence_observed", entityType: "issue", entityId: input.targetIssueId,
    })));
    const decisions = await Promise.all([
      observeCrossIssueInfluence(db, { ...input, kind: "comment" }),
      observeCrossIssueInfluence(db, { ...input, kind: "update" }),
    ]);
    expect(decisions.map((decision) => decision?.allowed).sort()).toEqual([false, true]);
    expect(decisions.map((decision) => decision?.count).sort()).toEqual([20, 21]);
  });

  it("pins one source when a taskless run holds multiple issues concurrently", async () => {
    const input = await seedTasklessRun();
    const otherIssueId = randomUUID();
    await db.insert(issues).values({
      id: otherIssueId,
      companyId: input.companyId,
      title: "Second checkout",
      status: "in_progress",
      assigneeAgentId: input.agentId,
      checkoutRunId: input.runId,
      executionRunId: input.runId,
    });
    const decisions = await Promise.all([
      observeCrossIssueInfluence(db, { ...input, kind: "comment" }),
      observeCrossIssueInfluence(db, { ...input, targetIssueId: otherIssueId, kind: "update" }),
    ]);
    expect(decisions.filter((decision) => decision === null)).toHaveLength(1);
    expect(decisions.filter((decision) => decision !== null)).toEqual([
      expect.objectContaining({ allowed: true, count: 1 }),
    ]);
    const receipts = await db.select().from(activityLog);
    const bindings = receipts.filter((row) => row.action === "issue.cross_issue_influence_source_bound");
    expect(bindings).toHaveLength(1);
    const sourceIssueId = bindings[0]!.entityId;
    const countedIssueId = sourceIssueId === input.targetIssueId ? otherIssueId : input.targetIssueId;

    // Later snapshot writes and release must not move the guard's source.
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: countedIssueId } })
      .where(eq(heartbeatRuns.id, input.runId));
    await db.update(issues).set({ assigneeAgentId: null, checkoutRunId: null, executionRunId: null })
      .where(eq(issues.id, sourceIssueId));
    expect(await observeCrossIssueInfluence(db, { ...input, targetIssueId: sourceIssueId, kind: "comment" }))
      .toBeNull();
    expect(await observeCrossIssueInfluence(db, { ...input, targetIssueId: countedIssueId, kind: "comment" }))
      .toMatchObject({ allowed: true, count: 2 });
  });

  it("counts a concurrently released issue without binding stale ownership", async () => {
    const input = await seedTasklessRun();
    await db.transaction(async (tx) => {
      await tx.update(issues).set({ assigneeAgentId: null, checkoutRunId: null, executionRunId: null })
        .where(eq(issues.id, input.targetIssueId));
      expect(await observeCrossIssueInfluence(db, { ...input, kind: "comment" }))
        .toMatchObject({ allowed: true, count: 1 });
    });
    const receipts = await db.select().from(activityLog);
    expect(receipts.map((row) => row.action)).toEqual([
      "issue.cross_issue_influence_observed",
    ]);
    expect(await observeCrossIssueInfluence(db, { ...input, kind: "update" }))
      .toMatchObject({ allowed: true, count: 2 });
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
