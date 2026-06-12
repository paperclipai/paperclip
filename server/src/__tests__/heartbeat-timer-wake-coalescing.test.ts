import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
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
    `Skipping embedded Postgres timer wake coalescing tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const allowCcrotateGate = {
  checkAdapter: async () => ({ allow: true as const }),
};

describeEmbeddedPostgres("heartbeat timer wake coalescing", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-timer-wake-coalescing-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("coalesces timer wakes into an existing heartbeat task row", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const existingRunId = randomUUID();
    const existingWakeupId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Timer Co",
      status: "active",
      issuePrefix: "TIM",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Timer Agent",
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

    await db.insert(agentWakeupRequests).values({
      id: existingWakeupId,
      companyId,
      agentId,
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
      status: "queued",
      requestedByActorType: "system",
      requestedByActorId: "heartbeat_scheduler",
    });
    await db.insert(heartbeatRuns).values({
      id: existingRunId,
      companyId,
      agentId,
      invocationSource: "timer",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId: existingWakeupId,
      contextSnapshot: {
        wakeReason: "heartbeat_timer",
        wakeSource: "timer",
        taskKey: "__heartbeat__",
      },
    });

    const heartbeat = heartbeatService(db, {
      ccrotateGate: allowCcrotateGate,
      skipQueuedRunDispatch: true,
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
      requestedByActorType: "system",
      requestedByActorId: "heartbeat_scheduler",
      contextSnapshot: {
        source: "scheduler",
        reason: "interval_elapsed",
        now: "2026-06-12T20:00:00.000Z",
      },
    });

    expect(run?.id).toBe(existingRunId);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.contextSnapshot).toMatchObject({
      taskKey: "__heartbeat__",
      wakeReason: "heartbeat_timer",
      wakeSource: "timer",
    });

    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups.map((wakeup) => wakeup.status).sort()).toEqual(["coalesced", "queued"]);
  });
});
