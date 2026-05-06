import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRunWatchdogDecisions,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { recoveryService } from "../services/recovery/service.ts";

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: vi.fn(),
  };
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
        summary: "ok",
        provider: "test",
        model: "test-model",
      })),
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres per-issue recovery rate limit tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("per-issue recovery rate limit", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-per-issue-rate-limit-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedInProgressIssueWithRecentRecoveryRuns(
    retryReasons: Array<"assignment_recovery" | "issue_continuation_needed">,
  ) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `RL${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Rate Limit Test Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Looping issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    // Seed runs within the last 5 minutes
    for (let i = 0; i < retryReasons.length; i++) {
      const createdAt = new Date(Date.now() - (retryReasons.length - i) * 30_000);
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId,
        status: "succeeded",
        livenessState: "advanced",
        invocationSource: "automation",
        triggerDetail: "system",
        startedAt: createdAt,
        finishedAt: new Date(createdAt.getTime() + 20_000),
        createdAt,
        contextSnapshot: {
          issueId,
          retryReason: retryReasons[i],
        },
        logBytes: 0,
      });
    }

    return { companyId, agentId, issueId };
  }

  async function seedInProgressIssueWithRecentContinuationRuns(runCount: number) {
    return seedInProgressIssueWithRecentRecoveryRuns(Array(runCount).fill("issue_continuation_needed"));
  }

  it("trips the continuation-path rate limit, escalates to blocked, and pauses agent after 5 enqueues in window", async () => {
    const { issueId, agentId } = await seedInProgressIssueWithRecentContinuationRuns(5);
    const enqueueWakeup = vi.fn();
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.assignmentDispatched).toBe(0);
    expect(result.dispatchRequeued).toBe(0);
    expect(result.rateLimitTripped).toBe(1);
    expect(result.continuationRequeued).toBe(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();

    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(updatedIssue?.status).toBe("blocked");

    const [updatedAgent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(updatedAgent?.status).toBe("paused");
    expect(updatedAgent?.pauseReason).toContain("recovery loop");

    const decisions = await db
      .select()
      .from(heartbeatRunWatchdogDecisions)
      .where(eq(heartbeatRunWatchdogDecisions.evaluationIssueId, issueId));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.decision).toBe("rate_limited");
  });

  it("does not trip when fewer than 5 enqueues in window", async () => {
    const { issueId } = await seedInProgressIssueWithRecentContinuationRuns(4);
    const enqueueWakeup = vi.fn().mockResolvedValue({ id: randomUUID() });
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.assignmentDispatched).toBe(0);
    expect(result.dispatchRequeued).toBe(0);
    expect(result.rateLimitTripped).toBe(0);
    expect(result.continuationRequeued).toBe(1);

    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(updatedIssue?.status).toBe("in_progress");
  });

  it("does not count assignment recovery runs against the continuation rate limit", async () => {
    const { issueId } = await seedInProgressIssueWithRecentRecoveryRuns([
      "assignment_recovery",
      "assignment_recovery",
      "assignment_recovery",
      "assignment_recovery",
      "issue_continuation_needed",
    ]);
    const enqueueWakeup = vi.fn().mockResolvedValue({ id: randomUUID() });
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.rateLimitTripped).toBe(0);
    expect(result.continuationRequeued).toBe(1);

    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(updatedIssue?.status).toBe("in_progress");
  });
});
