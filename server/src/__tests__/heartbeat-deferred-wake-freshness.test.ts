import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return { ...actual, trackAgentFirstHeartbeat: vi.fn() };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "test",
        provider: "test",
        model: "test-model",
      })),
    })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping deferred-wake freshness guard tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// ─── helpers ───────────────────────────────────────────────────────────────

const DEFERRED_WAKE_CONTEXT_KEY = "_paperclipWakeContext";

/**
 * Seed a minimal company + active agent and return their ids.
 */
async function seedCompanyAndAgent(db: ReturnType<typeof createDb>) {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

  await db.insert(companies).values({
    id: companyId,
    name: "Paperclip",
    issuePrefix,
    requireBoardApprovalForNewAgents: false,
  });

  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: "Coder",
    role: "engineer",
    status: "active",
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
    permissions: {},
  });

  return { companyId, agentId, issuePrefix };
}

/**
 * Seed a `done` issue whose executionRunId points to a `running` run.
 * Returns { issueId, runId, wakeupId }.
 */
async function seedTerminalIssueWithRunningExec(
  db: ReturnType<typeof createDb>,
  companyId: string,
  agentId: string,
  issuePrefix: string,
) {
  const issueId = randomUUID();
  const runId = randomUUID();
  const wakeupId = randomUUID();

  // Insert wakeup first (no FK on runId), then run referencing wakeup,
  // then issue referencing run — satisfies all FK constraints.
  await db.insert(agentWakeupRequests).values({
    id: wakeupId,
    companyId,
    agentId,
    source: "automation",
    triggerDetail: "system",
    reason: "test_wake",
    payload: { issueId },
    status: "queued",
  });

  await db.insert(heartbeatRuns).values({
    id: runId,
    companyId,
    agentId,
    invocationSource: "automation",
    triggerDetail: "system",
    status: "running",
    wakeupRequestId: wakeupId,
    contextSnapshot: { issueId, wakeReason: "test_wake" },
    startedAt: new Date(),
  });

  await db.insert(issues).values({
    id: issueId,
    companyId,
    title: "Freshness guard test issue",
    status: "done",
    priority: "medium",
    assigneeAgentId: agentId,
    issueNumber: 1,
    identifier: `${issuePrefix}-1`,
    executionRunId: runId,
    executionAgentNameKey: "coder",
  });

  return { issueId, runId, wakeupId };
}

/**
 * Insert an activity-log entry that records the issue transitioning to `done`
 * at the given timestamp.
 */
async function seedCloseActivityLog(
  db: ReturnType<typeof createDb>,
  companyId: string,
  issueId: string,
  closedAt: Date,
) {
  await db.insert(activityLog).values({
    companyId,
    actorType: "agent",
    actorId: "test-actor",
    action: "issue.updated",
    entityType: "issue",
    entityId: issueId,
    details: { status: "done" },
    createdAt: closedAt,
  });
}

/**
 * Seed an issue comment with an explicit createdAt timestamp.
 * Returns the commentId.
 */
async function seedComment(
  db: ReturnType<typeof createDb>,
  companyId: string,
  issueId: string,
  createdAt: Date,
) {
  const commentId = randomUUID();
  await db.insert(issueComments).values({
    id: commentId,
    companyId,
    issueId,
    body: "test comment",
    authorAgentId: null,
    authorUserId: null,
    createdAt,
    updatedAt: createdAt,
  });
  return commentId;
}

/**
 * Seed a deferred_issue_execution wake for the given commentIds.
 * Returns the wakeup request id.
 */
async function seedDeferredCommentWake(
  db: ReturnType<typeof createDb>,
  companyId: string,
  agentId: string,
  issueId: string,
  commentIds: string[],
) {
  const deferredId = randomUUID();
  await db.insert(agentWakeupRequests).values({
    id: deferredId,
    companyId,
    agentId,
    source: "automation",
    triggerDetail: "system",
    reason: "issue_execution_deferred",
    payload: {
      issueId,
      [DEFERRED_WAKE_CONTEXT_KEY]: {
        issueId,
        wakeCommentIds: commentIds,
        wakeReason: "issue_commented",
      },
    },
    status: "deferred_issue_execution",
  });
  return deferredId;
}

// ─── suite ─────────────────────────────────────────────────────────────────

describeEmbeddedPostgres("deferred-wake freshness guard (POI-237 Option 1)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-deferred-wake-freshness-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 30_000);

  afterEach(async () => {
    vi.clearAllMocks();
    runningProcesses.clear();
    // Wait for any background void executeRun() calls to finish before truncating.
    let idlePolls = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      const hasActiveRun = runs.some((r) => r.status === "queued" || r.status === "running");
      if (!hasActiveRun) {
        idlePolls += 1;
        if (idlePolls >= 3) break;
      } else {
        idlePolls = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // ── Case 1: stale comment → drop ─────────────────────────────────────────
  it("drops a deferred comment wake when the comment predates the issue close", async () => {
    // T1 < T2 < T3: comment posted before close; wake fires after
    const T1 = new Date("2026-04-01T10:00:00.000Z"); // comment created
    const T2 = new Date("2026-04-01T11:00:00.000Z"); // issue closed
    const { companyId, agentId, issuePrefix } = await seedCompanyAndAgent(db);
    const { issueId, runId } = await seedTerminalIssueWithRunningExec(db, companyId, agentId, issuePrefix);

    await seedCloseActivityLog(db, companyId, issueId, T2);
    const commentId = await seedComment(db, companyId, issueId, T1);
    await seedDeferredCommentWake(db, companyId, agentId, issueId, [commentId]);

    await heartbeat.cancelRun(runId);

    // Issue must remain done
    const [issue] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId));
    expect(issue?.status).toBe("done");

    // Deferred wake must be failed with the stale-skip error
    const [deferredWake] = await db
      .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, agentId),
          eq(agentWakeupRequests.status, "failed"),
        ),
      );
    expect(deferredWake?.error).toBe("deferred_comment_wake_terminal_skipped");

    // No activity log entry for a reopen
    const reopenEvents = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityId, issueId),
          eq(activityLog.action, "issue.updated"),
        ),
      );
    // Only the seeded close entry; no reopen entry
    expect(reopenEvents.every((e) => (e.details as Record<string, unknown>)?.reopened !== true)).toBe(true);
  });

  // ── Case 2: fresh comment → reopen ────────────────────────────────────────
  it("reopens the issue and promotes the run when the comment is newer than the close", async () => {
    // T1 < T2 < T3: issue closed first, comment posted after
    const T1 = new Date("2026-04-01T10:00:00.000Z"); // issue closed
    const T2 = new Date("2026-04-01T11:00:00.000Z"); // comment created
    const { companyId, agentId, issuePrefix } = await seedCompanyAndAgent(db);
    const { issueId, runId } = await seedTerminalIssueWithRunningExec(db, companyId, agentId, issuePrefix);

    await seedCloseActivityLog(db, companyId, issueId, T1);
    const commentId = await seedComment(db, companyId, issueId, T2);
    await seedDeferredCommentWake(db, companyId, agentId, issueId, [commentId]);

    await heartbeat.cancelRun(runId);

    // Issue must have been reopened to todo
    const [issue] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId));
    expect(issue?.status).toBe("todo");

    // An activity log entry must record the reopen
    const reopenEvents = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityId, issueId),
          eq(activityLog.action, "issue.updated"),
        ),
      );
    const reopenEntry = reopenEvents.find(
      (e) => (e.details as Record<string, unknown>)?.reopened === true,
    );
    expect(reopenEntry).toBeDefined();
    expect((reopenEntry!.details as Record<string, unknown>)?.source).toBe("deferred_comment_wake");

    // A new run must have been created for the deferred wake agent. The
    // original (cancelled) run is still there, so the promoted run makes 2.
    // We don't assert on status here because the heartbeat scheduler can
    // claim the queued run before this select lands.
    const agentRuns = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(agentRuns.length).toBeGreaterThan(1);
  });

  // ── Case 3: mixed batch — one stale, one fresh → reopen ──────────────────
  it("reopens when batch contains one stale and one fresh comment", async () => {
    const closedAt = new Date("2026-04-01T11:00:00.000Z");
    const staleTime = new Date("2026-04-01T10:00:00.000Z");
    const freshTime = new Date("2026-04-01T12:00:00.000Z");
    const { companyId, agentId, issuePrefix } = await seedCompanyAndAgent(db);
    const { issueId, runId } = await seedTerminalIssueWithRunningExec(db, companyId, agentId, issuePrefix);

    await seedCloseActivityLog(db, companyId, issueId, closedAt);
    const staleCommentId = await seedComment(db, companyId, issueId, staleTime);
    const freshCommentId = await seedComment(db, companyId, issueId, freshTime);
    await seedDeferredCommentWake(db, companyId, agentId, issueId, [staleCommentId, freshCommentId]);

    await heartbeat.cancelRun(runId);

    // Fresh wins — issue must be reopened
    const [issue] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId));
    expect(issue?.status).toBe("todo");

    // Must NOT emit a double stale-skip (the skip only fires when all comments are stale)
    const skipWakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, agentId),
          eq(agentWakeupRequests.error, "deferred_comment_wake_terminal_skipped"),
        ),
      );
    expect(skipWakes).toHaveLength(0);
  });

  // ── Case 4: no activity log entry → treat as fresh (lenient fallback) ────
  it("treats deferred comment as fresh when no terminal activity log entry exists", async () => {
    // Issue is done but activity_log has no terminal transition entry (e.g., imported/backfilled).
    // Defensive fallback: closedAt = null → all comments are considered fresh.
    const commentTime = new Date("2026-04-01T10:00:00.000Z");
    const { companyId, agentId, issuePrefix } = await seedCompanyAndAgent(db);
    const { issueId, runId } = await seedTerminalIssueWithRunningExec(db, companyId, agentId, issuePrefix);

    // Deliberately skip seedCloseActivityLog — no terminal log entry
    const commentId = await seedComment(db, companyId, issueId, commentTime);
    await seedDeferredCommentWake(db, companyId, agentId, issueId, [commentId]);

    await heartbeat.cancelRun(runId);

    // With closedAt = null the guard is lenient: treat comment as fresh → reopen
    const [issue] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId));
    expect(issue?.status).toBe("todo");
  });

  // ── Case 5: deleted comment rows → treat as fresh (lenient fallback) ──────
  it("treats deleted deferred comment rows as fresh instead of silently dropping the wake", async () => {
    const closedAt = new Date("2026-04-01T11:00:00.000Z");
    const commentTime = new Date("2026-04-01T12:00:00.000Z");
    const { companyId, agentId, issuePrefix } = await seedCompanyAndAgent(db);
    const { issueId, runId } = await seedTerminalIssueWithRunningExec(db, companyId, agentId, issuePrefix);

    await seedCloseActivityLog(db, companyId, issueId, closedAt);
    const commentId = await seedComment(db, companyId, issueId, commentTime);
    await seedDeferredCommentWake(db, companyId, agentId, issueId, [commentId]);

    await db.delete(issueComments).where(eq(issueComments.id, commentId));

    await heartbeat.cancelRun(runId);

    const [issue] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId));
    expect(issue?.status).toBe("todo");

    const [deferredWake] = await db
      .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, agentId),
          eq(agentWakeupRequests.reason, "issue_execution_promoted"),
        ),
      );
    expect(deferredWake?.status).not.toBe("failed");
    expect(deferredWake?.error).not.toBe("deferred_comment_wake_terminal_skipped");
  });

  // ── Case 6: non-comment deferred wake on terminal issue → unchanged path ──
  it("promotes non-comment deferred wakes on terminal issues without the freshness check", async () => {
    // A deferred wake with no wakeCommentIds must bypass the freshness guard entirely.
    // This verifies Path B (shouldImplicitlyMoveCommentedIssueToTodoForAgent) is not touched.
    const closedAt = new Date("2026-04-01T10:00:00.000Z");
    const { companyId, agentId, issuePrefix } = await seedCompanyAndAgent(db);
    const { issueId, runId } = await seedTerminalIssueWithRunningExec(db, companyId, agentId, issuePrefix);

    await seedCloseActivityLog(db, companyId, issueId, closedAt);

    // Deferred wake with NO comment ids (e.g., assignment-triggered)
    const deferredId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: deferredId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_execution_deferred",
      payload: {
        issueId,
        [DEFERRED_WAKE_CONTEXT_KEY]: {
          issueId,
          wakeReason: "issue_assigned",
          // no wakeCommentIds
        },
      },
      status: "deferred_issue_execution",
    });

    await heartbeat.cancelRun(runId);

    // The deferred wake must be promoted (reason flipped, runId attached) —
    // and explicitly NOT failed with the stale-skip error. We don't assert on
    // status, because the heartbeat scheduler can claim the promoted wake
    // before this select runs.
    const [promoted] = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        runId: agentWakeupRequests.runId,
        error: agentWakeupRequests.error,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, deferredId));
    expect(promoted?.status).not.toBe("failed");
    expect(promoted?.error).not.toBe("deferred_comment_wake_terminal_skipped");
    expect(promoted?.reason).toBe("issue_execution_promoted");
    expect(promoted?.runId).not.toBeNull();
  });
});
