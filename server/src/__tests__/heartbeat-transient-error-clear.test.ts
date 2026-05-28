import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentRuntimeState,
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
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping transient error clear tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("reconcileTransientErrorAgents", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-transient-error-clear-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.teardown();
  });

  async function seedCompanyAndAgent(overrides?: Partial<typeof agents.$inferInsert>) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Test Co",
      slug: `test-co-${companyId.slice(0, 8)}`,
    });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "coder",
      adapterType: "claude_local",
      adapterConfig: {},
      status: "error",
      lastHeartbeatAt: new Date(Date.now() - 8 * 60 * 60 * 1000), // 8h ago
      ...overrides,
    });
    return { companyId, agentId };
  }

  async function seedFailedRun(agentId: string, companyId: string, errorCode: string | null) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      agentId,
      companyId,
      status: "failed",
      errorCode,
      finishedAt: new Date(Date.now() - 8 * 60 * 60 * 1000),
    });
    return runId;
  }

  it("clears agent in error with transient error code and no active issues", async () => {
    const { agentId, companyId } = await seedCompanyAndAgent();
    await seedFailedRun(agentId, companyId, "claude_transient_upstream");

    const result = await heartbeat.reconcileTransientErrorAgents({ cooldownMs: 1 });

    expect(result.cleared).toBe(1);
    expect(result.clearedAgentIds).toContain(agentId);

    const agent = await db.select().from(agents).where(eq(agents.id, agentId)).then((r) => r[0]);
    expect(agent?.status).toBe("idle");
  });

  it("does not clear agent with non-transient error code", async () => {
    const { agentId, companyId } = await seedCompanyAndAgent();
    await seedFailedRun(agentId, companyId, "max_turns_exhausted");

    const result = await heartbeat.reconcileTransientErrorAgents({ cooldownMs: 1 });

    expect(result.cleared).toBe(0);
    const agent = await db.select().from(agents).where(eq(agents.id, agentId)).then((r) => r[0]);
    expect(agent?.status).toBe("error");
  });

  it("does not clear agent before cooldown window", async () => {
    const { agentId, companyId } = await seedCompanyAndAgent({
      lastHeartbeatAt: new Date(Date.now() - 1 * 60 * 60 * 1000), // 1h ago, inside 6h window
    });
    await seedFailedRun(agentId, companyId, "claude_auth_required");

    const result = await heartbeat.reconcileTransientErrorAgents({ cooldownMs: 6 * 60 * 60 * 1000 });

    expect(result.cleared).toBe(0);
  });

  it("does not clear agent that has active issues", async () => {
    const { agentId, companyId } = await seedCompanyAndAgent();
    await seedFailedRun(agentId, companyId, "claude_transient_upstream");

    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "Pending task",
      status: "in_progress",
      assigneeAgentId: agentId,
      identifier: `TST-1`,
      issueNumber: 1,
    });

    const result = await heartbeat.reconcileTransientErrorAgents({ cooldownMs: 1 });

    expect(result.cleared).toBe(0);
    const agent = await db.select().from(agents).where(eq(agents.id, agentId)).then((r) => r[0]);
    expect(agent?.status).toBe("error");
  });

  it("clears all known transient error codes", async () => {
    const transientCodes = [
      "claude_auth_required",
      "claude_transient_upstream",
      "codex_transient_upstream",
      "issue_terminal_status",
      "issue_assignee_changed",
      "issue_cancelled",
    ];

    for (const code of transientCodes) {
      const { agentId, companyId } = await seedCompanyAndAgent();
      await seedFailedRun(agentId, companyId, code);
    }

    const result = await heartbeat.reconcileTransientErrorAgents({ cooldownMs: 1 });

    expect(result.cleared).toBe(transientCodes.length);
  });
});
