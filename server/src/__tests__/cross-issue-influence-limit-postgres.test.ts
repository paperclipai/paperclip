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
  bindRunContextToCheckedOutIssue,
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

  it("binds a taskless run at checkout so same-issue writes pass the gate", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const checkedOutIssueId = randomUUID();
    const otherIssueId = randomUUID();

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
    // A timer-woken run with no task context: no issueId, no taskId.
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      responsibleUserId: "board-user",
      contextSnapshot: { source: "timer" },
    });

    // Before the bind, even a same-issue write is rejected for missing context.
    await expect(observeCrossIssueInfluence(db, {
      companyId,
      runId,
      agentId,
      targetIssueId: checkedOutIssueId,
      kind: "comment",
    })).rejects.toMatchObject({ status: 403 });

    expect(await bindRunContextToCheckedOutIssue(db, {
      companyId,
      agentId,
      runId,
      issueId: checkedOutIssueId,
    })).toBe(true);

    const [run] = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    expect(run.contextSnapshot).toMatchObject({ issueId: checkedOutIssueId, source: "timer" });

    // Same-issue writes now pass without a throw.
    await expect(observeCrossIssueInfluence(db, {
      companyId,
      runId,
      agentId,
      targetIssueId: checkedOutIssueId,
      kind: "comment",
    })).resolves.toBeNull();
    await expect(observeCrossIssueInfluence(db, {
      companyId,
      runId,
      agentId,
      targetIssueId: checkedOutIssueId,
      kind: "update",
    })).resolves.toBeNull();

    // Cross-issue writes stay metered against the bound source.
    await expect(observeCrossIssueInfluence(db, {
      companyId,
      runId,
      agentId,
      targetIssueId: otherIssueId,
      kind: "comment",
    })).resolves.toMatchObject({ allowed: true, count: 1 });
  });

  it("binds once: an existing source issue or task wins and null snapshots are supported", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
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
      name: "Once Binder",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const insertRun = (runId: string, contextSnapshot: Record<string, unknown> | null) =>
      db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        status: "running",
        responsibleUserId: "board-user",
        contextSnapshot,
      });

    const taskRunId = randomUUID();
    await insertRun(taskRunId, { taskId: "task-1", source: "task" });
    expect(await bindRunContextToCheckedOutIssue(db, {
      companyId,
      agentId,
      runId: taskRunId,
      issueId,
    })).toBe(false);
    const [taskRun] = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, taskRunId));
    expect(taskRun.contextSnapshot).toEqual({ taskId: "task-1", source: "task" });

    const anchoredRunId = randomUUID();
    await insertRun(anchoredRunId, { issueId: randomUUID() });
    expect(await bindRunContextToCheckedOutIssue(db, {
      companyId,
      agentId,
      runId: anchoredRunId,
      issueId,
    })).toBe(false);

    const nullSnapshotRunId = randomUUID();
    await insertRun(nullSnapshotRunId, null);
    expect(await bindRunContextToCheckedOutIssue(db, {
      companyId,
      agentId,
      runId: nullSnapshotRunId,
      issueId,
    })).toBe(true);
    const [nullRun] = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, nullSnapshotRunId));
    expect(nullRun.contextSnapshot).toEqual({ issueId });
  });
});
