import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
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
    `Skipping embedded Postgres queued-run claim isolation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat queued-run claim isolation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-queued-run-claim-isolation-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Claim Isolation Co",
      status: "active",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Claim Isolation Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 60,
          wakeOnDemand: true,
        },
      },
      permissions: {},
    });

    return { companyId, agentId };
  }

  // A queued-comment interrupt wake whose receipt cannot be verified. The run
  // identity check rejects it with a 403 every time the run is claimed.
  async function insertUnverifiableInterruptRun(companyId: string, agentId: string) {
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "issue_commented",
      status: "queued",
      idempotencyKey: `queued-comment-interrupt:${randomUUID()}`,
      requestedByActorType: "user",
      requestedByActorId: "board-user",
      runId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      wakeupRequestId,
    });

    return { runId, wakeupRequestId };
  }

  it("cancels a queued run whose claim is rejected instead of failing recovery", async () => {
    const { companyId, agentId } = await insertAgent();
    const { runId, wakeupRequestId } = await insertUnverifiableInterruptRun(companyId, agentId);

    const heartbeat = heartbeatService(db);
    await expect(heartbeat.resumeQueuedRuns()).resolves.toBeUndefined();

    const run = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        error: heartbeatRuns.error,
      })
      .from(heartbeatRuns)
      .then((rows) => rows[0] ?? null);
    expect(run).toMatchObject({
      status: "cancelled",
      errorCode: "queued_run_claim_rejected",
      error: "Cancelled because the queued run cannot be claimed: Queued-message interrupt authority is unavailable",
    });

    const wakeup = await db
      .select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .then((rows) => rows[0] ?? null);
    expect(wakeup).toMatchObject({ id: wakeupRequestId, status: "cancelled" });

    // Recovery runs again on the next cycle and on every restart. The run must
    // stay settled instead of failing the claim loop again.
    await expect(heartbeat.resumeQueuedRuns()).resolves.toBeUndefined();
    const rerun = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .then((rows) => rows[0] ?? null);
    expect(rerun).toMatchObject({ id: runId, status: "cancelled" });
  });

  it("keeps processing other agents' queued runs after one agent's run is rejected", async () => {
    const first = await insertAgent();
    const second = await insertAgent();
    await insertUnverifiableInterruptRun(first.companyId, first.agentId);
    const { runId: secondRunId } = await insertUnverifiableInterruptRun(second.companyId, second.agentId);

    const heartbeat = heartbeatService(db);
    await expect(heartbeat.resumeQueuedRuns()).resolves.toBeUndefined();

    const statuses = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns);
    expect(statuses).toHaveLength(2);
    expect(statuses.every((row) => row.status === "cancelled")).toBe(true);
    expect(statuses.map((row) => row.id)).toContain(secondRunId);
  });
});
