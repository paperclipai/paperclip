import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
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
  CROSS_ISSUE_INFLUENCE_SERVICE_KEY_LIMIT,
  observeCrossIssueInfluence,
  observeServiceKeyCrossIssueInfluence,
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

  it("serializes concurrent run-less service-key attempts at the cap and scopes the window per key", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const targetIssueId = randomUUID();
    const routerKeyId = randomUUID();
    const otherKeyId = randomUUID();
    const now = new Date();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Inbox Router",
      role: "integration",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(activityLog).values(
      Array.from({ length: CROSS_ISSUE_INFLUENCE_SERVICE_KEY_LIMIT - 1 }, () => ({
        companyId,
        actorType: "agent" as const,
        actorId: agentId,
        agentId,
        runId: null,
        action: "issue.cross_issue_influence_observed",
        entityType: "issue",
        entityId: targetIssueId,
        details: { serviceKeyId: routerKeyId },
      })),
    );

    const input = {
      companyId,
      agentId,
      serviceKeyId: routerKeyId,
      targetIssueId,
      targetIssueIdentifier: "CAP-3",
      kind: "comment" as const,
      now,
    };
    // Three inbound replies race for the window's last slot. The advisory lock
    // must serialize count-then-insert so exactly one lands at the cap and the
    // burst cannot read the same prior count and all pass.
    const decisions = await Promise.all([
      observeServiceKeyCrossIssueInfluence(db, input),
      observeServiceKeyCrossIssueInfluence(db, input),
      observeServiceKeyCrossIssueInfluence(db, input),
    ]);

    expect(decisions.map((decision) => decision.allowed).sort()).toEqual([false, false, true]);
    // Rejected attempts record a rejection row, not an observation, so both
    // losers see the same next count: the window never advances past the cap.
    expect(decisions.map((decision) => decision.count).sort((a, b) => a - b)).toEqual([
      CROSS_ISSUE_INFLUENCE_SERVICE_KEY_LIMIT,
      CROSS_ISSUE_INFLUENCE_SERVICE_KEY_LIMIT + 1,
      CROSS_ISSUE_INFLUENCE_SERVICE_KEY_LIMIT + 1,
    ]);

    // A different key on the same agent has its own budget: the exhausted
    // router window must not 429 another integration's first reply.
    await expect(
      observeServiceKeyCrossIssueInfluence(db, { ...input, serviceKeyId: otherKeyId }),
    ).resolves.toMatchObject({ allowed: true, count: 1 });

    const recorded = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), isNull(activityLog.runId)));
    expect(recorded.filter((row) => row.action === "issue.cross_issue_influence_observed"))
      .toHaveLength(CROSS_ISSUE_INFLUENCE_SERVICE_KEY_LIMIT + 1);
    expect(recorded.filter((row) => row.action === "issue.cross_issue_influence_cap_rejected"))
      .toHaveLength(2);
  });
});
