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

  it("scopes an unscoped run to its agent's own issues, and a scoped run to its source and checkout", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const timerRunId = randomUUID();
    const scopedRunId = randomUUID();
    const sourceIssueId = randomUUID();
    const ownIssueId = randomUUID();
    const ownCheckedOutByScopedRunId = randomUUID();
    const otherAgentsIssueId = randomUUID();
    const unassignedIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
    });
    await db.insert(agents).values([agentId, otherAgentId].map((id, index) => ({
      id,
      companyId,
      name: `Scoped Agent ${index}`,
      role: "engineer",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    })));
    await db.insert(heartbeatRuns).values([
      // A heartbeat timer wake: no issue or task in the run's context.
      { id: timerRunId, companyId, agentId, status: "running", invocationSource: "timer",
        responsibleUserId: "board-user", contextSnapshot: { wakeReason: "heartbeat_timer" } },
      { id: scopedRunId, companyId, agentId, status: "running", invocationSource: "assignment",
        responsibleUserId: "board-user", contextSnapshot: { issueId: sourceIssueId } },
    ]);
    await db.insert(issues).values([
      { id: ownIssueId, companyId, title: "Own", status: "in_progress", assigneeAgentId: agentId },
      { id: ownCheckedOutByScopedRunId, companyId, title: "Own, checked out", status: "in_progress",
        assigneeAgentId: agentId, checkoutRunId: scopedRunId },
      { id: otherAgentsIssueId, companyId, title: "Other agent", status: "in_progress", assigneeAgentId: otherAgentId },
      { id: unassignedIssueId, companyId, title: "Unassigned", status: "todo" },
    ]);

    const attempt = (runId: string, targetIssueId: string) => observeCrossIssueInfluence(db, {
      companyId,
      runId,
      agentId,
      targetIssueId,
      kind: "comment",
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    });

    // Unscoped: its agent's own issues are its work — checkout or not, nothing counted.
    await expect(attempt(timerRunId, ownIssueId)).resolves.toBeNull();
    await expect(attempt(timerRunId, ownCheckedOutByScopedRunId)).resolves.toBeNull();
    expect(await db.select().from(activityLog).where(eq(activityLog.runId, timerRunId))).toHaveLength(0);
    // ...and anything else is still refused outright.
    await expect(attempt(timerRunId, otherAgentsIssueId)).rejects.toMatchObject({ status: 403 });
    await expect(attempt(timerRunId, unassignedIssueId)).rejects.toMatchObject({ status: 403 });

    // Scoped: the issue it holds the checkout on is its own; another of the agent's
    // issues is still cross-issue and counted, exactly as before.
    await expect(attempt(scopedRunId, ownCheckedOutByScopedRunId)).resolves.toBeNull();
    await expect(attempt(scopedRunId, ownIssueId)).resolves.toMatchObject({ allowed: true, count: 1 });
  });
});
