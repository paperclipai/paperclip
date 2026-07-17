import { randomUUID } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
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

const mockAdapterExecute = vi.hoisted(() => vi.fn(async () => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  errorMessage: null,
  summary: "Unexpected admitted throttle test run.",
  provider: "test",
  model: "test-model",
})));

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

import { heartbeatService } from "../services/heartbeat.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue re-wake throttle tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat issue re-wake throttle", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-rewake-throttle-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
    mockAdapterExecute.mockClear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedNoProgressRuns() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `RW${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const now = Date.now();

    await db.insert(companies).values({
      id: companyId,
      name: "Re-wake Throttle Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Worker",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "No-evidence retry loop",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    await db.insert(heartbeatRuns).values([
      {
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "succeeded",
        contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
        createdAt: new Date(now - 45_000),
        startedAt: new Date(now - 45_000),
        finishedAt: new Date(now - 40_000),
      },
      {
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "succeeded",
        contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
        createdAt: new Date(now - 15_000),
        startedAt: new Date(now - 15_000),
        finishedAt: new Date(now - 10_000),
      },
    ]);

    return { companyId, agentId, issueId };
  }

  async function assignmentWake(agentId: string, issueId: string) {
    return heartbeatService(db).wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      requestedByActorType: "system",
      requestedByActorId: "test",
    });
  }

  it("persists a skipped wake after two no-evidence runs and ignores system status churn", async () => {
    const seeded = await seedNoProgressRuns();

    expect(await assignmentWake(seeded.agentId, seeded.issueId)).toBeNull();
    await db.insert(activityLog).values({
      companyId: seeded.companyId,
      actorType: "system",
      actorId: "recovery.reconcile",
      action: "issue.updated",
      entityType: "issue",
      entityId: seeded.issueId,
      details: { status: "in_progress" },
    });
    expect(await assignmentWake(seeded.agentId, seeded.issueId)).toBeNull();

    const skipped = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, seeded.agentId))
      .orderBy(desc(agentWakeupRequests.requestedAt));
    expect(skipped).toHaveLength(2);
    expect(skipped.every((wake) => wake.status === "skipped")).toBe(true);
    expect(skipped.every((wake) => wake.reason === "issue_rewake_throttled")).toBe(true);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });
});
