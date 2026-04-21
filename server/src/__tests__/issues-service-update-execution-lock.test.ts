import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("issue service update clears execution lock", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-service-update-execution-lock-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedRun(input: { companyId: string; agentId: string; issueId: string; runId: string }) {
    const now = new Date("2026-03-19T00:00:00.000Z");
    const wakeupRequestId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId: input.companyId,
      agentId: input.agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: input.issueId },
      status: "claimed",
      runId: input.runId,
      claimedAt: now,
    });

    await db.insert(heartbeatRuns).values({
      id: input.runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      wakeupRequestId,
      contextSnapshot: { issueId: input.issueId },
      processPid: null,
      processLossRetryCount: 0,
      errorCode: null,
      error: null,
      startedAt: now,
      updatedAt: now,
    });
  }

  it("clears executionRunId when moving away from in_progress", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const projectId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const now = new Date("2026-03-19T00:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "App Dev",
      role: "engineer",
      status: "active",
      adapterType: "cursor",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Test Project",
      status: "planned",
      goalId: null,
      leadAgentId: null,
      targetDate: null,
      color: "#000000",
      pauseReason: null,
      pausedAt: null,
      archivedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const runId = randomUUID();
    await seedRun({ companyId, agentId, issueId, runId });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      goalId: null,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      title: "Update test issue",
      description: null,
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      assigneeUserId: null,
      checkoutRunId: runId,
      executionRunId: runId,
      executionAgentNameKey: "app dev",
      executionLockedAt: now,
      startedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    const svc = issueService(db);
    const updated = await svc.update(issueId, { status: "in_review" });
    expect(updated?.status).toBe("in_review");

    const row = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(row.checkoutRunId).toBeNull();
    expect(row.executionRunId).toBeNull();
    expect(row.executionAgentNameKey).toBeNull();
    expect(row.executionLockedAt).toBeNull();
  });
});

