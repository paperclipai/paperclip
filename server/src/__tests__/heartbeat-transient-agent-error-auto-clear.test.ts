import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  instanceSettings,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";

// TWB-305: the scheduler tick auto-clears transient agent errors (error → idle)
// after a bounded backoff, while leaving hard failures and budget-exhausted agents
// in `error` for human attention.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres transient agent error auto-clear tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const TWO_MIN_MS = 2 * 60 * 1000;

describeEmbeddedPostgres("heartbeat transient agent error auto-clear", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let settings!: ReturnType<typeof instanceSettingsService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-transient-agent-error-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    settings = instanceSettingsService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndErroredAgent(input: { agentName: string }) {
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
      name: input.agentName,
      role: "engineer",
      status: "error",
      adapterType: "claude_local",
      adapterConfig: {},
      // Heartbeats off — mirrors the real engineer fleet that gets stuck in error.
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function insertFailedRun(input: {
    companyId: string;
    agentId: string;
    finishedAt: Date;
    errorCode: string;
    status?: "failed" | "timed_out";
  }) {
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      status: input.status ?? "failed",
      error: "boom",
      errorCode: input.errorCode,
      finishedAt: input.finishedAt,
    });
  }

  async function agentStatus(agentId: string) {
    const [row] = await db
      .select({ status: agents.status })
      .from(agents)
      .where(eq(agents.id, agentId));
    return row?.status ?? null;
  }

  it("clears a transient error to idle once the backoff has elapsed", async () => {
    const now = new Date("2026-06-06T12:00:00.000Z");
    const { companyId, agentId } = await seedCompanyAndErroredAgent({ agentName: "Frontend" });
    // Failed 5 minutes ago with a transient adapter_failed code → past the 2m backoff.
    await insertFailedRun({
      companyId,
      agentId,
      finishedAt: new Date(now.getTime() - 5 * 60 * 1000),
      errorCode: "adapter_failed",
    });

    const result = await heartbeat.reconcileTransientAgentErrors(now);

    expect(result.cleared).toBe(1);
    expect(await agentStatus(agentId)).toBe("idle");
  });

  it("retains a transient error while the backoff has not yet elapsed", async () => {
    const now = new Date("2026-06-06T12:00:00.000Z");
    const { companyId, agentId } = await seedCompanyAndErroredAgent({ agentName: "DevOps" });
    // Failed 30 seconds ago — first-attempt backoff is 2 minutes.
    await insertFailedRun({
      companyId,
      agentId,
      finishedAt: new Date(now.getTime() - 30 * 1000),
      errorCode: "adapter_failed",
    });

    const result = await heartbeat.reconcileTransientAgentErrors(now);

    expect(result.cleared).toBe(0);
    expect(result.retained).toBe(1);
    expect(await agentStatus(agentId)).toBe("error");
  });

  it("never auto-clears a hard failure", async () => {
    const now = new Date("2026-06-06T12:00:00.000Z");
    const { companyId, agentId } = await seedCompanyAndErroredAgent({ agentName: "Backend" });
    await insertFailedRun({
      companyId,
      agentId,
      finishedAt: new Date(now.getTime() - 60 * 60 * 1000),
      errorCode: "budget_exhausted",
    });

    const result = await heartbeat.reconcileTransientAgentErrors(now);

    expect(result.cleared).toBe(0);
    expect(await agentStatus(agentId)).toBe("error");
  });

  it("stops auto-clearing after the bounded retry budget is exhausted", async () => {
    const now = new Date("2026-06-06T12:00:00.000Z");
    const { companyId, agentId } = await seedCompanyAndErroredAgent({ agentName: "Frontend" });
    // 5 consecutive transient failures > default maxAttempts (4) → retained for human.
    for (let i = 0; i < 5; i += 1) {
      await insertFailedRun({
        companyId,
        agentId,
        finishedAt: new Date(now.getTime() - (i + 1) * 60 * 60 * 1000),
        errorCode: "adapter_failed",
      });
    }

    const result = await heartbeat.reconcileTransientAgentErrors(now);

    expect(result.cleared).toBe(0);
    expect(await agentStatus(agentId)).toBe("error");
  });

  it("is a no-op when the setting is disabled", async () => {
    const now = new Date("2026-06-06T12:00:00.000Z");
    await settings.updateExperimental({ enableTransientAgentErrorAutoClear: false });
    const { companyId, agentId } = await seedCompanyAndErroredAgent({ agentName: "DevOps" });
    await insertFailedRun({
      companyId,
      agentId,
      finishedAt: new Date(now.getTime() - 10 * 60 * 1000),
      errorCode: "adapter_failed",
    });

    const result = await heartbeat.reconcileTransientAgentErrors(now);

    expect(result).toEqual({ scanned: 0, cleared: 0, retained: 0 });
    expect(await agentStatus(agentId)).toBe("error");
  });

  it("clears a bare timed-out run as transient after backoff", async () => {
    const now = new Date("2026-06-06T12:00:00.000Z");
    const { companyId, agentId } = await seedCompanyAndErroredAgent({ agentName: "Backend" });
    await insertFailedRun({
      companyId,
      agentId,
      finishedAt: new Date(now.getTime() - TWO_MIN_MS - 1000),
      errorCode: "timeout",
      status: "timed_out",
    });

    const result = await heartbeat.reconcileTransientAgentErrors(now);

    expect(result.cleared).toBe(1);
    expect(await agentStatus(agentId)).toBe("idle");
  });
});
