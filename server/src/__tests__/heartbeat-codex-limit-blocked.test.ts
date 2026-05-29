/**
 * KSI-687 — Commit 2 tests: heartbeat wiring for codex usage-limit blocked
 *
 * Verifies that:
 * 1. scheduleBoundedRetry transitions the issue to `blocked` and adds the
 *    `codex-limit` label when outcome is "scheduled" for a codex_local agent.
 * 2. promoteDueScheduledRetries transitions the issue back to `in_progress`
 *    and removes the `codex-limit` label.
 * 3. A non-codex_local agent (claude_local) does NOT trigger the blocked
 *    transition even when transient_upstream fires.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueLabels,
  issues,
  labels,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { CODEX_LIMIT_LABEL_NAME } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat codex-limit blocked tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat wiring: codex-limit blocked/unblocked (KSI-687)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-codex-limit-blocked-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueLabels);
    await db.delete(labels);
    await db.delete(heartbeatRunEvents);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /** Seed a company, a codex_local agent, an in_progress issue and a failed run. */
  async function seedCodexLimitFixture(opts?: {
    adapterType?: "codex_local" | "claude_local";
    retryNotBefore?: string;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const now = new Date("2026-05-01T12:00:00.000Z");
    const adapterType = opts?.adapterType ?? "codex_local";
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
      name: adapterType === "claude_local" ? "ClaudeCoder" : "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType,
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    const resultJson: Record<string, unknown> = {
      errorFamily: "transient_upstream",
    };
    if (opts?.retryNotBefore) {
      resultJson.retryNotBefore = opts.retryNotBefore;
      resultJson.transientRetryNotBefore = opts.retryNotBefore;
    }

    // Insert run BEFORE issue (FK: issues.execution_run_id → heartbeat_runs.id)
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      error: "Usage limit exceeded",
      errorCode: "codex_transient_upstream",
      finishedAt: now,
      scheduledRetryAttempt: 0,
      scheduledRetryReason: null,
      resultJson,
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
      },
      updatedAt: now,
      createdAt: now,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Issue under usage-limit",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      executionRunId: runId,
      executionAgentNameKey: adapterType === "claude_local" ? "claudecoder" : "codexcoder",
      executionLockedAt: now,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentId, issueId, runId, now };
  }

  async function getIssueStatus(issueId: string) {
    return db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]?.status ?? null);
  }

  async function getIssueCodexLimitLabel(issueId: string, companyId: string) {
    const label = await db
      .select({ id: labels.id })
      .from(labels)
      .where(and(eq(labels.companyId, companyId), eq(labels.name, CODEX_LIMIT_LABEL_NAME)))
      .then((rows) => rows[0] ?? null);
    if (!label) return false;
    const applied = await db
      .select({ issueId: issueLabels.issueId })
      .from(issueLabels)
      .where(and(eq(issueLabels.issueId, issueId), eq(issueLabels.labelId, label.id)))
      .then((rows) => rows[0] ?? null);
    return applied != null;
  }

  async function getIssueComments(issueId: string) {
    return db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
  }

  it("scheduleBoundedRetry: codex_local transient → issue becomes blocked + codex-limit label applied + comment added", async () => {
    const { companyId, issueId, runId } = await seedCodexLimitFixture();

    const result = await heartbeat.scheduleBoundedRetry(runId);

    expect(result.outcome).toBe("scheduled");

    const status = await getIssueStatus(issueId);
    expect(status).toBe("blocked");

    const hasLabel = await getIssueCodexLimitLabel(issueId, companyId);
    expect(hasLabel).toBe(true);

    const comments = await getIssueComments(issueId);
    expect(comments.length).toBeGreaterThan(0);
    expect(comments[0]!.body).toContain("Aguardando retorno do Codex usage-limit");
    expect(comments[0]!.body).toContain("Owner: sistema (auto-resume)");
  });

  it("scheduleBoundedRetry: codex_local with retryNotBefore → blocked + label + comment contains scheduled time", async () => {
    const retryNotBefore = "2026-05-01T13:00:00.000Z";
    const { companyId, issueId, runId } = await seedCodexLimitFixture({ retryNotBefore });

    const result = await heartbeat.scheduleBoundedRetry(runId);
    expect(result.outcome).toBe("scheduled");

    const status = await getIssueStatus(issueId);
    expect(status).toBe("blocked");

    const hasLabel = await getIssueCodexLimitLabel(issueId, companyId);
    expect(hasLabel).toBe(true);

    const comments = await getIssueComments(issueId);
    expect(comments.length).toBeGreaterThan(0);
    expect(comments[0]!.body).toContain("Retry agendado para");
  });

  it("scheduleBoundedRetry: claude_local transient → issue stays in_progress (NOT blocked, no label)", async () => {
    const { companyId, issueId, runId } = await seedCodexLimitFixture({ adapterType: "claude_local" });

    // Patch the run's errorCode to match claude convention
    await db
      .update(heartbeatRuns)
      .set({ errorCode: "claude_transient_upstream" })
      .where(eq(heartbeatRuns.id, runId));

    const result = await heartbeat.scheduleBoundedRetry(runId);
    expect(result.outcome).toBe("scheduled");

    const status = await getIssueStatus(issueId);
    expect(status).toBe("in_progress"); // NOT blocked

    const hasLabel = await getIssueCodexLimitLabel(issueId, companyId);
    expect(hasLabel).toBe(false);
  });

  it("promoteDueScheduledRetries: blocked issue with codex-limit label → returns to in_progress and label removed", async () => {
    const retryNotBefore = "2026-05-01T11:00:00.000Z"; // in the past relative to scheduleNow
    const { companyId, issueId, runId } = await seedCodexLimitFixture({ retryNotBefore });

    // Use a deterministic now for scheduling so scheduledRetryAt is predictable
    const scheduleNow = new Date("2026-05-01T12:00:00.000Z");

    // Schedule the retry at scheduleNow (which will also block the issue and add the label)
    const scheduleResult = await heartbeat.scheduleBoundedRetry(runId, { now: scheduleNow });
    expect(scheduleResult.outcome).toBe("scheduled");

    // Confirm issue is blocked
    expect(await getIssueStatus(issueId)).toBe("blocked");
    expect(await getIssueCodexLimitLabel(issueId, companyId)).toBe(true);

    // Promote at scheduleNow + 3h (well past the 2min delay for attempt 1)
    const promoted = await heartbeat.promoteDueScheduledRetries(
      new Date(scheduleNow.getTime() + 3 * 60 * 60 * 1000),
    );
    expect(promoted.promoted).toBeGreaterThan(0);

    // Issue should be back to in_progress
    expect(await getIssueStatus(issueId)).toBe("in_progress");

    // Label should be removed
    expect(await getIssueCodexLimitLabel(issueId, companyId)).toBe(false);
  });
});
