import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
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
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres checkout idempotency tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("checkout idempotency", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-checkout-idempotency-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssueWithAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `CI${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Checkout Idempotency Co",
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
      title: "Feature work",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "automation",
      triggerDetail: "system",
      startedAt: new Date(),
      createdAt: new Date(),
      contextSnapshot: { issueId },
      logBytes: 0,
    });

    return { companyId, agentId, issueId, runId };
  }

  it("returns isIdempotent=false on first checkout", async () => {
    const { issueId, agentId, runId } = await seedIssueWithAgent();
    const svc = issueService(db);

    const result = await svc.checkout(issueId, agentId, ["todo"], runId);

    expect(result.isIdempotent).toBe(false);
    expect(result.status).toBe("in_progress");
    expect(result.checkoutRunId).toBe(runId);
  });

  it("returns isIdempotent=true when the same run checks out the same issue again", async () => {
    const { issueId, agentId, runId } = await seedIssueWithAgent();
    const svc = issueService(db);

    await svc.checkout(issueId, agentId, ["todo"], runId);
    const second = await svc.checkout(issueId, agentId, ["todo", "in_progress"], runId);

    expect(second.isIdempotent).toBe(true);
    expect(second.status).toBe("in_progress");
  });

  it("returns isIdempotent=false when a different run adopts a stale checkout", async () => {
    const { issueId, agentId, runId, companyId } = await seedIssueWithAgent();
    const svc = issueService(db);
    const newRunId = randomUUID();

    await db.insert(heartbeatRuns).values({
      id: newRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "automation",
      triggerDetail: "system",
      startedAt: new Date(),
      createdAt: new Date(),
      contextSnapshot: { issueId },
      logBytes: 0,
    });

    await svc.checkout(issueId, agentId, ["todo"], runId);
    // Mark old run as terminal so adoptStaleCheckoutRun accepts the transition.
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(
      sql`id = ${runId}::uuid`,
    );
    const second = await svc.checkout(issueId, agentId, ["todo", "in_progress"], newRunId);

    expect(second.isIdempotent).toBe(false);
    expect(second.status).toBe("in_progress");
    expect(second.checkoutRunId).toBe(newRunId);
  });
});
