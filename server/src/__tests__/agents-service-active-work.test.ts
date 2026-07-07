import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
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
import { agentService } from "../services/agents.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent active-work tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent service active work projection", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-active-work-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("projects assigned active issue while lifecycle status is still idle", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, { status: "idle" });
    const runId = randomUUID();
    const issueId = randomUUID();

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "completed",
      finishedAt: new Date("2026-07-07T15:00:30.000Z"),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Active checkout",
      identifier: "TST-123",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
      executionLockedAt: new Date("2026-07-07T15:00:00.000Z"),
    });

    const [agent] = await agentService(db).list(companyId);

    expect(agent).toMatchObject({
      id: agentId,
      status: "idle",
      activeIssueId: issueId,
      activeIssueIdentifier: "TST-123",
      activeRunId: runId,
      activeRunStatus: null,
      activeWorkStatus: "assigned",
    });
  });

  it("upgrades active work status from live heartbeat run", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, { status: "idle" });
    const runId = randomUUID();

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "queued",
      startedAt: new Date("2026-07-07T15:01:00.000Z"),
    });
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "Queued execution",
      identifier: "TST-124",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
    });

    await expectActiveWork(companyId, {
      activeRunStatus: "queued",
      activeWorkStatus: "queued",
    });

    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, runId));

    await expectActiveWork(companyId, {
      activeRunStatus: "running",
      activeWorkStatus: "running",
    });
  });

  it("clears active work for terminal issues", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, { status: "idle" });
    const runId = randomUUID();
    const issueId = randomUUID();

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Done execution",
      identifier: "TST-125",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
    });

    await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));

    const [agent] = await agentService(db).list(companyId);

    expect(agent).toMatchObject({
      activeIssueId: null,
      activeIssueIdentifier: null,
      activeRunId: null,
      activeRunStatus: null,
      activeWorkStatus: "idle",
    });
  });

  async function expectActiveWork(
    companyId: string,
    expected: { activeRunStatus: "queued" | "running"; activeWorkStatus: "queued" | "running" },
  ) {
    const [agent] = await agentService(db).list(companyId);
    expect(agent).toMatchObject(expected);
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, overrides: Partial<typeof agents.$inferInsert> = {}) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      ...overrides,
    });
    return agentId;
  }
});
