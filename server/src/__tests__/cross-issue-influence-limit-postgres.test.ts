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

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
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
    return { companyId, agentId };
  }

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

  // TES-2107. The unit suite fakes the database, so only this case proves the
  // checkout-lock and assignee lookups are valid queries against the real schema.
  it("resolves a timer wake's scope from durable state, not the snapshot", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    // Exactly what a board/timer wake persists: no issueId, no taskId.
    const timerSnapshot = { actorId: "local-board", wakeSource: "on_demand", triggeredBy: "board" };
    const lockedRunId = randomUUID();
    const looseRunId = randomUUID();
    await db.insert(heartbeatRuns).values([
      { id: lockedRunId, companyId, agentId, status: "running", responsibleUserId: "board-user", contextSnapshot: timerSnapshot },
      { id: looseRunId, companyId, agentId, status: "running", responsibleUserId: "board-user", contextSnapshot: timerSnapshot },
    ]);

    const checkedOutIssueId = randomUUID();
    const ownedIssueId = randomUUID();
    const strangerIssueId = randomUUID();
    await db.insert(issues).values([
      { id: checkedOutIssueId, companyId, title: "Checked out", checkoutRunId: lockedRunId, assigneeAgentId: agentId },
      { id: ownedIssueId, companyId, title: "Owned but not checked out", assigneeAgentId: agentId },
      { id: strangerIssueId, companyId, title: "Someone else's work" },
    ]);

    const base = { companyId, agentId, kind: "update" as const, now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT };

    // The checkout lock stands in for the source issue the snapshot never wrote,
    // so the run's own issue is free — as it would be for a snapshot wake.
    await expect(observeCrossIssueInfluence(db, { ...base, runId: lockedRunId, targetIssueId: checkedOutIssueId }))
      .resolves.toBeNull();
    // Reaching past it to another issue is metered, lock or no lock.
    await expect(observeCrossIssueInfluence(db, { ...base, runId: lockedRunId, targetIssueId: ownedIssueId }))
      .resolves.toMatchObject({ allowed: true, count: 1 });

    // With no lock at all, the agent can still dispose of its own assigned work.
    await expect(observeCrossIssueInfluence(db, { ...base, runId: looseRunId, targetIssueId: ownedIssueId }))
      .resolves.toMatchObject({ allowed: true, count: 1 });
    // TES-2179: and it can reach an issue that is neither locked nor its own. The
    // run is persisted and matches company + agent, so §9.3.1's fail-closed clause
    // does not apply; the write is metered, not refused.
    await expect(observeCrossIssueInfluence(db, { ...base, runId: looseRunId, targetIssueId: strangerIssueId }))
      .resolves.toMatchObject({ allowed: true, count: 2 });

    const unattributed = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.entityId, strangerIssueId)))
      .then((rows) => rows[0]?.details as { sourceOrigin?: string; sourceIssueId?: string | null });
    expect(unattributed).toMatchObject({ sourceOrigin: "none", sourceIssueId: null });
  });
});
