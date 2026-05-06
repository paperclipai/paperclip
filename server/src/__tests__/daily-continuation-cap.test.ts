import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  heartbeatRunWatchdogDecisions,
  instanceSettings,
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
    `Skipping embedded Postgres daily continuation cap tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("daily continuation cap", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-daily-cap-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(instanceSettings);
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // Issue created well before the run window so updatedAt guard doesn't filter out runs.
  const ISSUE_CREATED_AT = new Date(Date.now() - 25 * 60 * 60 * 1000);

  async function seedStrandedIssueWithDailyRuns(runCount: number, breakConsecutiveTail = false) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `DC${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Daily Cap Test Co",
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
      title: "Slowly looping issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      createdAt: ISSUE_CREATED_AT,
      updatedAt: ISSUE_CREATED_AT,
    });

    const runSpacingMs = breakConsecutiveTail ? 30 * 60_000 : 30_000;
    // Space runs so all fall within the 24h window. When the fixture is used
    // with other recovery caps, keep the history outside the short rate-limit
    // window so the daily cap is the behavior under test.
    for (let i = 0; i < runCount; i++) {
      const createdAt = new Date(Date.now() - (runCount - i) * runSpacingMs);
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId,
        status: "succeeded",
        livenessState: "advanced",
        invocationSource: "automation",
        triggerDetail: "system",
        startedAt: createdAt,
        finishedAt: new Date(createdAt.getTime() + 10_000),
        createdAt,
        contextSnapshot: {
          issueId,
          retryReason: "issue_continuation_needed",
        },
        logBytes: 0,
      });
    }

    if (breakConsecutiveTail) {
      // Keep this fixture focused on the 24h aggregate cap when combined with
      // the stricter consecutive-continuation cap.
      const createdAt = new Date(Date.now() - 5_000);
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId,
        status: "succeeded",
        livenessState: "advanced",
        invocationSource: "automation",
        triggerDetail: "system",
        startedAt: createdAt,
        finishedAt: new Date(createdAt.getTime() + 1_000),
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

  it("escalates to blocked and inserts watchdog decision after 24 continuation runs in 24h", async () => {
    const { issueId, companyId } = await seedStrandedIssueWithDailyRuns(24, true);
    const enqueueWakeup = vi.fn();
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.escalated).toBe(1);
    expect(result.dailyCapTripped).toBe(1);
    expect(result.continuationRequeued).toBe(0);

    const [updated] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(updated?.status).toBe("blocked");

    expect(enqueueWakeup).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: "issue_continuation_needed" }),
    );

    const decisions = await db
      .select()
      .from(heartbeatRunWatchdogDecisions)
      .where(eq(heartbeatRunWatchdogDecisions.companyId, companyId));
    expect(decisions.length).toBeGreaterThanOrEqual(1);
    expect(decisions[0]?.decision).toBe("rate_limited");
    expect(decisions[0]?.evaluationIssueId).toBe(issueId);
  });

  it("re-queues continuation when fewer than 24 runs exist in the window", async () => {
    const { issueId } = await seedStrandedIssueWithDailyRuns(23, true);
    const enqueueWakeup = vi.fn().mockResolvedValue({ id: randomUUID() });
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.continuationRequeued).toBe(1);
    expect(result.escalated).toBe(0);
    expect(result.dailyCapTripped).toBe(0);

    const [updated] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(updated?.status).toBe("in_progress");

    expect(enqueueWakeup).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: "issue_continuation_needed" }),
    );
  });

  it("uses configured continuation cap and window", async () => {
    const { issueId, companyId } = await seedStrandedIssueWithDailyRuns(10, true);
    await db
      .insert(instanceSettings)
      .values({
        singletonKey: "default",
        general: {
          recoveryProtection: {
            continuationDailyCap: 10,
            continuationDailyWindowHours: 24,
          },
        },
        experimental: {},
      })
      .onConflictDoUpdate({
        target: [instanceSettings.singletonKey],
        set: {
          general: {
            recoveryProtection: {
              continuationDailyCap: 10,
              continuationDailyWindowHours: 24,
            },
          },
          experimental: {},
        },
      });
    const enqueueWakeup = vi.fn();
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.escalated).toBe(1);
    expect(result.dailyCapTripped).toBe(1);

    const decisions = await db
      .select()
      .from(heartbeatRunWatchdogDecisions)
      .where(eq(heartbeatRunWatchdogDecisions.companyId, companyId));
    expect(decisions[0]?.reason).toContain("Continuation cap of 10 reached");
    expect(enqueueWakeup).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: "issue_continuation_needed" }),
    );

    const [updated] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(updated?.status).toBe("blocked");
  });
});
