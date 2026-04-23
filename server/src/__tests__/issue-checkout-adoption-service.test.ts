import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
import { issueService } from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres checkout adoption tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issueService.assertCheckoutOwner adoption", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-checkout-adoption-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
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

  async function seedBase() {
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
      name: "Alex",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    return { companyId, agentId };
  }

  async function seedRun(companyId: string, agentId: string, runId: string) {
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId: "placeholder" },
    });
  }

  it("adopts a lingering checkout lock when the issue has no live execution run", async () => {
    const { companyId, agentId } = await seedBase();
    const previousRunId = randomUUID();
    const currentRunId = randomUUID();
    const issueId = randomUUID();

    await seedRun(companyId, agentId, previousRunId);
    await seedRun(companyId, agentId, currentRunId);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Adopt checkout without live execution",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: previousRunId,
      executionRunId: null,
      issueNumber: 1,
      identifier: "PAP-1",
    });

    const ownership = await svc.assertCheckoutOwner(issueId, agentId, currentRunId);

    expect(ownership.adoptedFromRunId).toBe(previousRunId);
    expect(ownership.checkoutRunId).toBe(currentRunId);
    expect(ownership.executionRunId).toBe(currentRunId);
  });

  it("adopts the checkout lock when the current run is already the live executor", async () => {
    const { companyId, agentId } = await seedBase();
    const previousRunId = randomUUID();
    const currentRunId = randomUUID();
    const issueId = randomUUID();

    await seedRun(companyId, agentId, previousRunId);
    await seedRun(companyId, agentId, currentRunId);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Adopt checkout for current executor",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: previousRunId,
      executionRunId: currentRunId,
      issueNumber: 1,
      identifier: "PAP-1",
    });

    const ownership = await svc.assertCheckoutOwner(issueId, agentId, currentRunId);

    expect(ownership.adoptedFromRunId).toBe(previousRunId);
    expect(ownership.checkoutRunId).toBe(currentRunId);
    expect(ownership.executionRunId).toBe(currentRunId);
  });
});
