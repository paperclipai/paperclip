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

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issues service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue service checkout", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-service-checkout-");
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

  async function seedFixture(opts?: {
    issueStatus?: "todo" | "in_review" | "blocked";
    checkoutRunId?: string | null;
    executionRunId?: string | null;
  }) {
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

    if (opts?.executionRunId) await seedRun({ companyId, agentId, issueId, runId: opts.executionRunId });
    if (opts?.checkoutRunId) await seedRun({ companyId, agentId, issueId, runId: opts.checkoutRunId });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      goalId: null,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      title: "Checkout test issue",
      description: null,
      status: opts?.issueStatus ?? "in_review",
      priority: "high",
      assigneeAgentId: null,
      assigneeUserId: null,
      checkoutRunId: opts?.checkoutRunId ?? null,
      executionRunId: opts?.executionRunId ?? null,
      createdAt: now,
      updatedAt: now,
    });

    return { companyId, agentId, issueId };
  }

  it("allows checkout when checkoutRunId is null even if executionRunId is stale", async () => {
    const { companyId, agentId, issueId } = await seedFixture({
      issueStatus: "in_review",
      checkoutRunId: null,
      executionRunId: randomUUID(),
    });
    const svc = issueService(db);

    const runId = randomUUID();
    await seedRun({ companyId, agentId, issueId, runId });
    const updated = await svc.checkout(issueId, agentId, ["in_review"], runId);
    expect(updated.assigneeAgentId).toBe(agentId);
    expect(updated.status).toBe("in_progress");
    expect(updated.checkoutRunId).toBe(runId);
    expect(updated.executionRunId).toBe(runId);

    const row = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(row.checkoutRunId).toBe(runId);
    expect(row.executionRunId).toBe(runId);
    expect(row.assigneeAgentId).toBe(agentId);
  });

  it("still conflicts when another checkoutRunId is present", async () => {
    const { agentId, issueId } = await seedFixture({
      issueStatus: "in_review",
      checkoutRunId: randomUUID(),
      executionRunId: randomUUID(),
    });
    const svc = issueService(db);

    await expect(svc.checkout(issueId, agentId, ["in_review"], randomUUID())).rejects.toMatchObject({
      message: "Issue checkout conflict",
    });
  });
});

