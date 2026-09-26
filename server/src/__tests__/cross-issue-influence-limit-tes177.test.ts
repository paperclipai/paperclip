import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
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

describeEmbeddedPostgres("TES-177 own-task exemption across several bindings", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tes177-own-task-");
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

  async function seedRunWithTwoBindings() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    // Pin the sort order rather than trusting randomUUID, so this test fails
    // against the ordered pick for the reason under test and not by luck.
    const lowId = "00000000-0000-4000-8000-000000000001";
    const highId = "ffffffff-0000-4000-8000-000000000002";

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
    await db.insert(issues).values([
      {
        id: lowId,
        companyId,
        identifier: "TES-101",
        title: "the task whose id sorts first",
        status: "in_progress",
        assigneeAgentId: agentId,
        checkoutRunId: runId,
        executionRunId: runId,
      },
      {
        id: highId,
        companyId,
        identifier: "TES-102",
        title: "the task whose id sorts last",
        status: "in_progress",
        assigneeAgentId: agentId,
        checkoutRunId: runId,
      },
    ]);

    return { companyId, agentId, runId, lowId, highId };
  }

  // A run can hold several bindings at once — neither checkout_run_id nor
  // execution_run_id is unique, and wake-queue dispatch also writes
  // execution_run_id. The ordered pick settled which row wins, but it settled it
  // by UUID, so a run writing to one of its own tasks was charged the cross-issue
  // budget or exempted from it depending on how its ids happened to sort.
  it("does not count a write to one of several tasks the run is bound to, whichever id sorts first", async () => {
    const { companyId, agentId, runId, lowId, highId } = await seedRunWithTwoBindings();

    // Writing to the id-sorting-last task of its own is not cross-issue
    // influence. Under the ordered pick this is charged, because `lowId` wins
    // the orderBy and is a different issue from the target.
    await expect(observeCrossIssueInfluence(db, {
      companyId,
      runId,
      agentId,
      targetIssueId: highId,
      targetIssueIdentifier: "TES-102",
      kind: "update",
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    })).resolves.toBeNull();

    // And writing to the id-sorting-first task stays exempt too, so the fix is
    // not just moving the charge onto the other own task.
    await expect(observeCrossIssueInfluence(db, {
      companyId,
      runId,
      agentId,
      targetIssueId: lowId,
      targetIssueIdentifier: "TES-101",
      kind: "update",
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    })).resolves.toBeNull();

    // A genuinely different issue is still charged, so the own-task exemption
    // did not widen into a blanket exemption for a multi-bound run.
    const otherIssueId = "7fffffff-0000-4000-8000-000000000003";
    await db.insert(issues).values({
      id: otherIssueId,
      companyId,
      identifier: "TES-103",
      title: "a task this run is not bound to",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    await expect(observeCrossIssueInfluence(db, {
      companyId,
      runId,
      agentId,
      targetIssueId: otherIssueId,
      targetIssueIdentifier: "TES-103",
      kind: "update",
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    })).resolves.toMatchObject({ count: 1, allowed: true });

    // The charge is still attributed to one of the run's own bindings, chosen by
    // the stable order — the fix changed which issue counts as the source for the
    // run's *own* task, not which source a genuinely foreign write is billed to.
    const recorded = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.runId, runId),
          eq(activityLog.action, "issue.cross_issue_influence_observed"),
        ),
      )
      .then((rows) => rows.map((row) => row.details as Record<string, unknown> | null));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ sourceIssueId: lowId, targetIssueId: otherIssueId });
  });

  // Boundary: a run bound to nothing is the unattributable case. The own-task
  // exemption must not turn that refusal into a silent pass, and must not throw
  // on an empty row set.
  it("still refuses a run bound to no issue at all", async () => {
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
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      responsibleUserId: "board-user",
      contextSnapshot: {},
    });

    await expect(observeCrossIssueInfluence(db, {
      companyId,
      runId,
      agentId,
      targetIssueId,
      kind: "update",
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    })).rejects.toThrow();
  });

  // Boundary: two concurrent writes from the same multi-bound run must each
  // resolve to their own target. If the first writer's ordered pick leaked into
  // the second, one of these would be charged for writing to its own task.
  it("resolves two concurrent own-task writes to their own targets", async () => {
    const { companyId, agentId, runId, lowId, highId } = await seedRunWithTwoBindings();

    const [toLow, toHigh] = await Promise.all([
      observeCrossIssueInfluence(db, {
        companyId,
        runId,
        agentId,
        targetIssueId: lowId,
        targetIssueIdentifier: "TES-101",
        kind: "update",
        now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
      }),
      observeCrossIssueInfluence(db, {
        companyId,
        runId,
        agentId,
        targetIssueId: highId,
        targetIssueIdentifier: "TES-102",
        kind: "update",
        now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
      }),
    ]);

    expect(toLow).toBeNull();
    expect(toHigh).toBeNull();
  });
});
