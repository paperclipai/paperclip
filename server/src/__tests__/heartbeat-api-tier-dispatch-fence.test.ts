import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companySkills,
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
import { heartbeatService } from "../services/heartbeat.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres API-tier dispatch-fence tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// BLO-9089 / Failure B: runs were being claimed + executed on the paperclip-api
// replicas, which skip bundled-adapter load (the workers tier owns the adapter
// lifecycle). The api tier then resolved every external adapter to the process
// fallback and died with "Process adapter missing command", launching no agent
// pod. The fence: the api tier must NEVER claim/dispatch a queued run.
describeEmbeddedPostgres("heartbeat API-tier dispatch fence", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-api-tier-dispatch-fence-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(companySkills);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgentWithQueuedRun() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const now = new Date("2026-06-05T06:30:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "TST",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Staff Engineer",
      role: "engineer",
      status: "active",
      // Use the always-loaded built-in adapter so a RED run (no fence) finalizes
      // quickly instead of attempting a real external dispatch.
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true, maxConcurrentRuns: 1 },
      },
      permissions: {},
      lastHeartbeatAt: now,
      createdAt: now,
      updatedAt: now,
    });
    // A dispatchable queued run with a free concurrency slot (no running run).
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      contextSnapshot: { taskKey: `task:${randomUUID()}`, wakeReason: "test_dispatch" },
      createdAt: now,
      updatedAt: now,
    });
    return { companyId, agentId, runId };
  }

  it("does NOT claim or dispatch a queued run when paperclipNodeRole is 'api'", async () => {
    const { agentId, runId } = await seedAgentWithQueuedRun();
    const heartbeat = heartbeatService(db, { paperclipNodeRole: "api" });

    await heartbeat.resumeQueuedRuns();

    // The api tier must leave the run queued for the workers tier to claim.
    const run = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]);
    expect(run?.status).toBe("queued");

    // And it must not have spawned any execution events for the run.
    const events = await db
      .select()
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.agentId, agentId));
    expect(events).toHaveLength(0);
  });
});
