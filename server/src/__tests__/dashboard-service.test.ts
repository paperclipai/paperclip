import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { dashboardService } from "../services/dashboard.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres dashboard service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("dashboardService.summary", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dashboard-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("matches the default issue-list visibility rules for task counts", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Operator",
      role: "general",
      status: "idle",
      adapterType: "opencode_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values([
      {
        id: randomUUID(),
        companyId,
        title: "Visible todo",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
      },
      {
        id: randomUUID(),
        companyId,
        title: "Visible in progress",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
      },
      {
        id: randomUUID(),
        companyId,
        title: "Visible blocked",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: agentId,
      },
      {
        id: randomUUID(),
        companyId,
        title: "Visible done",
        status: "done",
        priority: "medium",
        assigneeAgentId: agentId,
      },
      {
        id: randomUUID(),
        companyId,
        title: "Hidden routine execution",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        originKind: "routine_execution",
      },
      {
        id: randomUUID(),
        companyId,
        title: "Hidden archived issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        hiddenAt: new Date(),
      },
    ]);

    const summary = await dashboardService(db).summary(companyId);

    expect(summary.tasks).toEqual({
      open: 3,
      inProgress: 1,
      blocked: 1,
      done: 1,
    });
  });
});
