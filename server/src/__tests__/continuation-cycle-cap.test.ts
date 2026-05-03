import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
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
    `Skipping embedded Postgres continuation cycle cap tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("continuation cycle cap", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-continuation-cap-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const ISSUE_CREATED_AT = new Date("2026-04-25T09:00:00.000Z");
  const RUNS_BASE_TIME = new Date("2026-04-25T10:00:00.000Z");

  async function seedStrandedIssueWithRuns(
    runCount: number,
    issueUpdatedAt = ISSUE_CREATED_AT,
    latestRecoveryBreakAfterIssueUpdate = false,
  ) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `CC${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Cap Test Co",
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
      title: "Stuck implementation",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      createdAt: ISSUE_CREATED_AT,
      updatedAt: issueUpdatedAt,
    });

    for (let i = 0; i < runCount; i++) {
      const createdAt = new Date(RUNS_BASE_TIME.getTime() + i * 60_000);
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId,
        status: "succeeded",
        invocationSource: "automation",
        triggerDetail: "system",
        startedAt: createdAt,
        finishedAt: new Date(createdAt.getTime() + 30_000),
        createdAt,
        contextSnapshot: {
          issueId,
          retryReason: "issue_continuation_needed",
        },
        logBytes: 0,
      });
    }

    if (latestRecoveryBreakAfterIssueUpdate) {
      const createdAt = new Date(issueUpdatedAt.getTime() + 60_000);
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId,
        status: "failed",
        invocationSource: "automation",
        triggerDetail: "system",
        startedAt: createdAt,
        finishedAt: new Date(createdAt.getTime() + 30_000),
        createdAt,
        contextSnapshot: {
          issueId,
          retryReason: "assignment_recovery",
        },
        logBytes: 0,
      });
    }

    return { companyId, agentId, issueId };
  }

  it("escalates to blocked after 3 consecutive succeeded continuation runs", async () => {
    const { issueId } = await seedStrandedIssueWithRuns(3);
    const enqueueWakeup = vi.fn();
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.escalated).toBe(1);
    expect(result.continuationRequeued).toBe(0);

    const [updated] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(updated?.status).toBe("blocked");

    expect(enqueueWakeup).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: "issue_continuation_needed" }),
    );

    const wakeupRequests = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, updated!.companyId));
    const continuationWakes = wakeupRequests.filter(
      (w) => (w.payload as Record<string, unknown>)?.issueId === issueId,
    );
    expect(continuationWakes).toHaveLength(0);
  });

  it("observes continuation success when fewer than 3 consecutive succeeded runs exist", async () => {
    const { issueId } = await seedStrandedIssueWithRuns(2);
    const enqueueWakeup = vi.fn().mockResolvedValue({ id: randomUUID() });
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.successfulContinuationObserved).toBe(1);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);

    const [updated] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(updated?.status).toBe("in_progress");

    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("re-queues after operator manually unblocks without immediately triggering a new run", async () => {
    // The 3 continuation runs predate the operator's manual unblock (issueUpdatedAt is after all runs).
    // The cap must not fire on runs that predate the last status change.
    const operatorUnblockedAt = new Date(RUNS_BASE_TIME.getTime() + 10 * 60_000);
    const { issueId } = await seedStrandedIssueWithRuns(3, operatorUnblockedAt, true);
    const enqueueWakeup = vi.fn().mockResolvedValue({ id: randomUUID() });
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.continuationRequeued).toBe(1);
    expect(result.escalated).toBe(0);

    const [updated] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(updated?.status).toBe("in_progress");
  });
});
