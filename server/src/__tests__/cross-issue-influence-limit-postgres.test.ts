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
  bindCheckoutRunSourceIssueIfUnset,
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

  it("binds a run with no recorded source issue to the first write's target, persists it on the row, and caps only writes to a different issue thereafter", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueA = randomUUID();
    const issueB = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Unscoped Wake Agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    // The exact shape a plain unscoped-wake heartbeat run starts with: no
    // issueId/taskId recorded yet.
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      responsibleUserId: "board-user",
      contextSnapshot: {},
    });

    // First write of the run's life, against the issue it checked out (A):
    // must succeed and must not be treated as a cross-issue write.
    const firstWrite = await observeCrossIssueInfluence(db, {
      companyId,
      runId,
      agentId,
      targetIssueId: issueA,
      kind: "comment",
    });
    expect(firstWrite).toBeNull();

    const [boundRun] = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    expect(boundRun?.contextSnapshot).toMatchObject({ issueId: issueA, source: "first_write_bind" });

    // A second write to the same issue A still costs nothing against the cap.
    const secondWriteSameIssue = await observeCrossIssueInfluence(db, {
      companyId,
      runId,
      agentId,
      targetIssueId: issueA,
      kind: "update",
    });
    expect(secondWriteSameIssue).toBeNull();

    // A write to a different issue B is gated by the existing cross-issue cap,
    // not unconditionally rejected — it is allowed here (well under the cap).
    const crossIssueWrite = await observeCrossIssueInfluence(db, {
      companyId,
      runId,
      agentId,
      targetIssueId: issueB,
      kind: "comment",
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    });
    expect(crossIssueWrite).toMatchObject({ allowed: true, count: 1 });

    // Re-fetching the row (simulating a process-lost/retried run reusing the
    // same run id) shows the bind still persisted and no further mutation on
    // the second same-issue write above.
    const [runAfter] = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    expect(runAfter?.contextSnapshot).toMatchObject({ issueId: issueA, source: "first_write_bind" });
  });

  it("bindCheckoutRunSourceIssueIfUnset binds the calling actor's own run at checkout time, and never overwrites an already-bound run", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueA = randomUUID();
    const issueB = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Checkout Binder",
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
      contextSnapshot: null,
    });

    await bindCheckoutRunSourceIssueIfUnset(db, { companyId, runId, agentId, issueId: issueA });

    const [afterCheckout] = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    expect(afterCheckout?.contextSnapshot).toMatchObject({ issueId: issueA, source: "issue.checkout" });

    // A later checkout of a different issue by the same run must not clobber
    // the already-bound source issue.
    await bindCheckoutRunSourceIssueIfUnset(db, { companyId, runId, agentId, issueId: issueB });
    const [afterSecondCheckout] = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    expect(afterSecondCheckout?.contextSnapshot).toMatchObject({ issueId: issueA, source: "issue.checkout" });
  });

  it("bindCheckoutRunSourceIssueIfUnset merges into an existing populated contextSnapshot instead of replacing it", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueA = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Checkout Binder Merge",
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
      contextSnapshot: { wakeReason: "heartbeat_timer", modelProfile: "reasoning-high" },
    });

    await bindCheckoutRunSourceIssueIfUnset(db, { companyId, runId, agentId, issueId: issueA });

    const [afterCheckout] = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    expect(afterCheckout?.contextSnapshot).toEqual({
      wakeReason: "heartbeat_timer",
      modelProfile: "reasoning-high",
      issueId: issueA,
      source: "issue.checkout",
    });
  });
});
