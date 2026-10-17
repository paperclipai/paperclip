import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createDb,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  activityLog,
  agents,
  agentWakeupRequests,
  authUsers,
  companies,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueRecoveryActions,
  issueRelations,
  issueWorkProducts,
  issues,
} from "@paperclipai/db";
import { classifyContinuationFailure, recoveryService } from "./service.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// Helper: build a minimal LatestIssueRun-shaped object for classifyContinuationFailure.
// Only errorCode, status, and error matter for this test suite.
function run(opts: {
  errorCode?: string | null;
  status?: string;
  error?: string | null;
}): Parameters<typeof classifyContinuationFailure>[0] {
  return {
    errorCode: opts.errorCode ?? null,
    status: opts.status ?? "timed_out",
    error: opts.error ?? null,
  } as unknown as Parameters<typeof classifyContinuationFailure>[0];
}

const OPENCLAW_TIMEOUT_ERROR = "OpenClaw gateway run timed out after 30000ms";

describe("OpenClaw gateway wait timeout: fail-closed guard", () => {
  it("classifies an OpenClaw gateway wait timeout as non_retryable", () => {
    const c = classifyContinuationFailure(run({
      errorCode: "timeout",
      status: "timed_out",
      error: OPENCLAW_TIMEOUT_ERROR,
    }));
    expect(c.kind).toBe("non_retryable");
    expect(c.maxAttempts).toBe(0);
  });

  it("matches various millisecond durations in the OpenClaw error message", () => {
    for (const ms of [1000, 30000, 120000, 999999]) {
      const c = classifyContinuationFailure(run({
        errorCode: "timeout",
        status: "timed_out",
        error: `OpenClaw gateway run timed out after ${ms}ms`,
      }));
      expect(c.kind).toBe("non_retryable");
    }
  });

  it("is case-insensitive on the error message", () => {
    const c = classifyContinuationFailure(run({
      errorCode: "timeout",
      status: "timed_out",
      error: "openclaw gateway run timed out after 60000ms",
    }));
    expect(c.kind).toBe("non_retryable");
  });

  it("does not suppress retry when error message is prefixed before canonical text", () => {
    const c = classifyContinuationFailure(run({
      errorCode: "timeout",
      status: "timed_out",
      error: `Error: ${OPENCLAW_TIMEOUT_ERROR}`,
    }));
    expect(c.kind).toBe("transient_infra");
    expect(c.maxAttempts).toBeGreaterThan(0);
  });

  it("does not suppress retry when error message has a suffix after canonical text", () => {
    const c = classifyContinuationFailure(run({
      errorCode: "timeout",
      status: "timed_out",
      error: `${OPENCLAW_TIMEOUT_ERROR}. Please retry.`,
    }));
    expect(c.kind).toBe("transient_infra");
    expect(c.maxAttempts).toBeGreaterThan(0);
  });

  it("does not suppress retry for a generic timeout (no OpenClaw message)", () => {
    const c = classifyContinuationFailure(run({
      errorCode: "timeout",
      status: "timed_out",
      error: null,
    }));
    expect(c.kind).toBe("transient_infra");
    expect(c.maxAttempts).toBeGreaterThan(0);
  });

  it("does not suppress retry when error message contains unrelated timeout text", () => {
    const c = classifyContinuationFailure(run({
      errorCode: "timeout",
      status: "timed_out",
      error: "Database query timed out after 5000ms",
    }));
    expect(c.kind).toBe("transient_infra");
    expect(c.maxAttempts).toBeGreaterThan(0);
  });

  it("does not suppress retry when status is not timed_out (wrong terminal state)", () => {
    const c = classifyContinuationFailure(run({
      errorCode: "timeout",
      status: "failed",
      error: OPENCLAW_TIMEOUT_ERROR,
    }));
    expect(c.kind).toBe("transient_infra");
  });

  it("does not suppress retry when errorCode is not timeout", () => {
    const c = classifyContinuationFailure(run({
      errorCode: "adapter_failed",
      status: "timed_out",
      error: OPENCLAW_TIMEOUT_ERROR,
    }));
    // adapter_failed is in TRANSIENT_INFRA_CONTINUATION_ERROR_CODES
    expect(c.kind).toBe("transient_infra");
  });

  it("preserves errorCode: timeout in the classification for OpenClaw timeout", () => {
    const c = classifyContinuationFailure(run({
      errorCode: "timeout",
      status: "timed_out",
      error: OPENCLAW_TIMEOUT_ERROR,
    }));
    expect(c.errorCode).toBe("timeout");
  });
});

const OPENCLAW_TIMEOUT_ERROR_120S = "OpenClaw gateway run timed out after 120000ms";

describeEmbeddedPostgres("OpenClaw gateway wait timeout: recoveryService behavioral path", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-openclaw-timeout-behavioral-");
    db = createDb(tempDb.connectionString);
    const now = new Date();
    await db.insert(authUsers).values({
      id: "responsible-user",
      name: "Responsible User",
      email: "responsible-user@example.test",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    await db.delete(agentWakeupRequests);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(issueWorkProducts);
    await db.delete(issueDocuments);
    await db.delete(issueComments);
    await db.delete(issueRecoveryActions);
    await db.delete(issueRelations);
    // Delete child issues before parents to respect FK constraints.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(issueComments);
      try {
        await db.delete(issues);
        break;
      } catch {
        if (attempt === 4) throw new Error("Failed to clean up issues after 5 attempts");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(activityLog);
      try {
        await db.delete(agents);
        break;
      } catch {
        if (attempt === 4) throw new Error("Failed to clean up agents after 5 attempts");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(activityLog);
      try {
        await db.delete(companies);
        break;
      } catch {
        if (attempt === 4) throw new Error("Failed to clean up companies after 5 attempts");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedOpenClawTimeoutIssue(status: "todo" | "in_progress") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const now = new Date("2026-08-25T00:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Test",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "timed_out",
      errorCode: "timeout",
      error: OPENCLAW_TIMEOUT_ERROR_120S,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      startedAt: now,
      finishedAt: new Date("2026-08-25T00:02:00.000Z"),
      updatedAt: new Date("2026-08-25T00:02:00.000Z"),
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Issue with OpenClaw wait timeout",
      status,
      priority: "medium",
      assigneeAgentId: agentId,
      assigneeUserId: null,
      checkoutRunId: status === "in_progress" ? runId : null,
      executionRunId: null,
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentId, issueId, runId };
  }

  it("TODO / assignment path: escalates to blocked and enqueues zero retry/redispatch wakeups for a persisted OpenClaw wait timeout", async () => {
    const { issueId } = await seedOpenClawTimeoutIssue("todo");
    const enqueueWakeup = vi.fn().mockResolvedValue(null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    // Source issue must be moved to blocked — no automatic retry dispatched.
    expect(result.escalated).toBe(1);
    expect(result.issueIds).toContain(issueId);
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");

    // Any enqueueWakeup calls must be recovery escalation wakes (source_scoped_recovery_action /
    // issue_assigned), never a retry redispatch (issue_assignment_recovery) or continuation
    // (issue_continuation_needed). Those retry reasons are the invariant being guarded against.
    const retryReasons = new Set(["issue_assignment_recovery", "issue_continuation_needed"]);
    for (const [, opts] of enqueueWakeup.mock.calls) {
      const reason = (opts as Record<string, unknown> | undefined)?.reason as string | undefined;
      expect(retryReasons.has(reason ?? "")).toBe(false);
      const ctx = (opts as Record<string, unknown> | undefined)?.contextSnapshot as Record<string, unknown> | undefined;
      const wakeReason = ctx?.wakeReason as string | undefined;
      expect(retryReasons.has(wakeReason ?? "")).toBe(false);
    }
  });

  it("IN_PROGRESS / continuation path: escalates to blocked and enqueues zero retry/continuation wakeups for a persisted OpenClaw wait timeout", async () => {
    const { issueId } = await seedOpenClawTimeoutIssue("in_progress");
    const enqueueWakeup = vi.fn().mockResolvedValue(null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    // Source issue must follow the non-retryable escalation path — no continuation enqueued.
    expect(result.escalated).toBe(1);
    expect(result.issueIds).toContain(issueId);
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");

    // Any enqueueWakeup calls must be recovery escalation wakes, never a retry continuation.
    // issue_continuation_needed is the retry reason being guarded against.
    const retryReasons = new Set(["issue_assignment_recovery", "issue_continuation_needed"]);
    for (const [, opts] of enqueueWakeup.mock.calls) {
      const reason = (opts as Record<string, unknown> | undefined)?.reason as string | undefined;
      expect(retryReasons.has(reason ?? "")).toBe(false);
      const ctx = (opts as Record<string, unknown> | undefined)?.contextSnapshot as Record<string, unknown> | undefined;
      const wakeReason = ctx?.wakeReason as string | undefined;
      expect(retryReasons.has(wakeReason ?? "")).toBe(false);
    }
  });
});
