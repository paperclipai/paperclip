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

  /** Seeds one company, one agent, and one run with the given context snapshot. */
  async function seedRun(contextSnapshot: Record<string, unknown>) {
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
      contextSnapshot,
    });

    return { companyId, agentId, runId };
  }

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("allows exactly one of concurrent attempts 20 and 21", async () => {
    const sourceIssueId = randomUUID();
    const targetIssueId = randomUUID();
    const { companyId, agentId, runId } = await seedRun({ issueId: sourceIssueId });

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

  it("allows a run with no snapshot issue to write to the issue it checked out", async () => {
    // A timer heartbeat has no issue in its context snapshot. Before this
    // fallback, the run could not comment on the issue it had just checked out.
    const { companyId, agentId, runId } = await seedRun({ wakeReason: "heartbeat_timer" });
    const targetIssueId = randomUUID();
    await db.insert(issues).values({
      id: targetIssueId,
      companyId,
      title: "Checked out by the timer run",
      checkoutRunId: runId,
    });

    await expect(observeCrossIssueInfluence(db, {
      companyId,
      runId,
      agentId,
      targetIssueId,
      targetIssueIdentifier: "CAP-10",
      kind: "comment",
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    })).resolves.toBeNull();

    const recorded = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.runId, runId)));
    expect(recorded).toEqual([]);
  });

  it("treats the execution run binding on the target issue as a same-issue write", async () => {
    const { companyId, agentId, runId } = await seedRun({ wakeReason: "heartbeat_timer" });
    const targetIssueId = randomUUID();
    await db.insert(issues).values({
      id: targetIssueId,
      companyId,
      title: "Executed by the timer run",
      executionRunId: runId,
    });

    await expect(observeCrossIssueInfluence(db, {
      companyId,
      runId,
      agentId,
      targetIssueId,
      kind: "update",
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    })).resolves.toBeNull();
  });

  it("counts a write to another issue from a run anchored only by its checkout", async () => {
    // The checkout anchors the counter, so a genuine cross-issue write from a
    // timer run is still measured against the cap instead of refused.
    const { companyId, agentId, runId } = await seedRun({ wakeReason: "heartbeat_timer" });
    const checkedOutIssueId = randomUUID();
    const targetIssueId = randomUUID();
    await db.insert(issues).values([
      { id: checkedOutIssueId, companyId, title: "Checked out", checkoutRunId: runId },
      { id: targetIssueId, companyId, title: "Someone else's issue" },
    ]);

    await expect(observeCrossIssueInfluence(db, {
      companyId,
      runId,
      agentId,
      targetIssueId,
      kind: "comment",
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    })).resolves.toMatchObject({
      allowed: true,
      mode: "enforce",
      count: 1,
      cap: CROSS_ISSUE_INFLUENCE_LIMIT,
    });

    const recorded = await db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.runId, runId)));
    expect(recorded).toEqual([
      expect.objectContaining({
        action: "issue.cross_issue_influence_observed",
        details: expect.objectContaining({ sourceIssueId: checkedOutIssueId, targetIssueId }),
      }),
    ]);
  });

  it.each(["comment", "interaction_resolution"] as const)(
    "lets a run with no snapshot issue and no checkout make a %s, counted against the cap",
    async (kind) => {
      // The free-heartbeat case: `PAPERCLIP_TASK_ID` unset and nothing checked
      // out. This used to 403 with advice to send a header the caller had
      // already sent, so an agent on a timer heartbeat could open a whole new
      // issue but could not comment on an existing one or reject a stale
      // interaction. The cap keys on the run, so the write is counted, not refused.
      const { companyId, agentId, runId } = await seedRun({ wakeReason: "heartbeat_timer" });
      const targetIssueId = randomUUID();
      await db.insert(issues).values({ id: targetIssueId, companyId, title: "Unrelated issue" });

      await expect(observeCrossIssueInfluence(db, {
        companyId,
        runId,
        agentId,
        targetIssueId,
        kind,
        now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
      })).resolves.toMatchObject({ allowed: true, mode: "enforce", count: 1 });

      const recorded = await db
        .select({ action: activityLog.action, details: activityLog.details })
        .from(activityLog)
        .where(and(eq(activityLog.companyId, companyId), eq(activityLog.runId, runId)));
      expect(recorded).toEqual([
        expect.objectContaining({
          action: "issue.cross_issue_influence_observed",
          details: expect.objectContaining({ kind, sourceIssueId: null, targetIssueId }),
        }),
      ]);
    },
  );

  it("caps a free heartbeat spraying distinct issues at the same per-run budget", async () => {
    // Letting the unanchored run through moves it from "refused everywhere" to
    // "budgeted like every other run" — it does not hand it an unmetered write
    // path across the company. The counter keys on the run, never on the source
    // issue, so touching a fresh issue every time cannot buy extra writes: the
    // twenty-first is refused even though no issue was written twice.
    const { companyId, agentId, runId } = await seedRun({ wakeReason: "heartbeat_timer" });
    const targetIssueIds = Array.from({ length: CROSS_ISSUE_INFLUENCE_LIMIT + 1 }, () => randomUUID());
    await db.insert(issues).values(
      targetIssueIds.map((id, index) => ({ id, companyId, title: `Unrelated issue ${index}` })),
    );

    const decisions = [];
    for (const targetIssueId of targetIssueIds) {
      decisions.push(await observeCrossIssueInfluence(db, {
        companyId,
        runId,
        agentId,
        targetIssueId,
        kind: "comment",
        now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
      }));
    }

    expect(decisions.map((decision) => decision?.allowed)).toEqual([
      ...Array.from({ length: CROSS_ISSUE_INFLUENCE_LIMIT }, () => true),
      false,
    ]);
    expect(decisions.at(-1)).toMatchObject({
      allowed: false,
      mode: "enforce",
      count: CROSS_ISSUE_INFLUENCE_LIMIT + 1,
    });

    const recorded = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.runId, runId)));
    expect(recorded.filter((row) => row.action === "issue.cross_issue_influence_observed"))
      .toHaveLength(CROSS_ISSUE_INFLUENCE_LIMIT);
    expect(recorded.filter((row) => row.action === "issue.cross_issue_influence_cap_rejected"))
      .toHaveLength(1);
  });

  it("fails a run whose id names no run of this agent with the run-identity code", async () => {
    // The header is well-formed and was sent. "Send the header" is an
    // inoperative remedy here, so the copy must name the real condition.
    const { companyId, agentId } = await seedRun({ wakeReason: "heartbeat_timer" });

    await expect(observeCrossIssueInfluence(db, {
      companyId,
      runId: randomUUID(),
      agentId,
      targetIssueId: randomUUID(),
      kind: "comment",
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    })).rejects.toMatchObject({
      status: 403,
      details: { code: "cross_issue_influence_run_not_recognized" },
    });
  });

  it("counts a scoped run's write to another issue that the same run checked out", async () => {
    // Checkout stamps the run onto any issue the agent may claim. A scoped run
    // must not clear the cap by checking out each target before it writes.
    const sourceIssueId = randomUUID();
    const { companyId, agentId, runId } = await seedRun({ issueId: sourceIssueId });
    const targetIssueId = randomUUID();
    await db.insert(issues).values([
      { id: sourceIssueId, companyId, title: "Scoped issue" },
      { id: targetIssueId, companyId, title: "Also checked out by this run", checkoutRunId: runId },
    ]);

    await expect(observeCrossIssueInfluence(db, {
      companyId,
      runId,
      agentId,
      targetIssueId,
      kind: "comment",
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    })).resolves.toMatchObject({ allowed: true, mode: "enforce", count: 1 });

    const recorded = await db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.runId, runId)));
    expect(recorded).toEqual([
      expect.objectContaining({
        action: "issue.cross_issue_influence_observed",
        details: expect.objectContaining({ sourceIssueId, targetIssueId }),
      }),
    ]);
  });

  it("leaves a scoped run's same-issue write uncounted", async () => {
    const targetIssueId = randomUUID();
    const { companyId, agentId, runId } = await seedRun({ issueId: targetIssueId });
    await db.insert(issues).values({ id: targetIssueId, companyId, title: "Scoped issue" });

    await expect(observeCrossIssueInfluence(db, {
      companyId,
      runId,
      agentId,
      targetIssueId,
      kind: "update",
      now: CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
    })).resolves.toBeNull();

    const recorded = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.runId, runId)));
    expect(recorded).toEqual([]);
  });
});
