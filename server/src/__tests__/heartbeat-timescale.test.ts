import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  agentWakeupRequests,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat timescale tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat timescale", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-timescale-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("scales scheduled heartbeat intervals proportionally by company time scale", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const now = new Date("2026-04-14T00:00:00.000Z");
    const lastHeartbeatAt = new Date(now.getTime() - 60_000);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      heartbeatTimeScalePercent: 100,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 100,
          // Prevent the service from immediately executing queued runs during this unit test.
          // We only want to validate the scheduler's enqueue decision.
          maxConcurrentRuns: 0,
        },
      },
      permissions: {},
      lastHeartbeatAt,
    });

    // With 1.0x (100%), effective interval is 100s; 60s elapsed should not enqueue.
    await heartbeatService(db).tickTimers(now);
    await expect(db.select().from(agentWakeupRequests)).resolves.toHaveLength(0);

    // With 2.0x (200%), effective interval is 50s; 60s elapsed should enqueue.
    await db.update(companies).set({ heartbeatTimeScalePercent: 200 }).where(eq(companies.id, companyId));
    await heartbeatService(db).tickTimers(now);
    const requests = await db.select().from(agentWakeupRequests);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.agentId).toBe(agentId);
    expect(["queued", "claimed"]).toContain(requests[0]?.status);
  });
});

