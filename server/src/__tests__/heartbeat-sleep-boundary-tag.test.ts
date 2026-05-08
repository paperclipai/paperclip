import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  agentRuntimeState,
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
import {
  createSleepBoundaryTracker,
  type SleepBoundaryTracker,
} from "../services/sleep-boundary-tracker.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat sleep boundary tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const noopLog = { warn: () => {}, info: () => {} };

function buildPrimedTracker(boundary: { sleptAt: Date; wokeAt: Date }): SleepBoundaryTracker {
  const tracker = createSleepBoundaryTracker({ log: noopLog });
  const expected = boundary.sleptAt.getTime() + 10_000;
  const wokeAt = boundary.wokeAt.getTime();
  tracker.recordSampleForTest(wokeAt, expected);
  return tracker;
}

async function seedCompanyAgent(db: ReturnType<typeof createDb>) {
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
    name: "CodexCoder",
    role: "engineer",
    status: "running",
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  });

  return { companyId, agentId };
}

describeEmbeddedPostgres("heartbeat sleep boundary tag", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-sleep-boundary-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(agentRuntimeState);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("flags a cancelled run whose wall-clock spans a host sleep boundary", async () => {
    const { companyId, agentId } = await seedCompanyAgent(db);
    const runId = randomUUID();
    const startedAt = new Date("2026-04-28T03:05:24.000Z");
    const wokeAt = new Date("2026-04-28T04:26:49.000Z");

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
      startedAt,
      processStartedAt: startedAt,
    });

    const tracker = buildPrimedTracker({ sleptAt: new Date(startedAt.getTime() + 60_000), wokeAt });
    const heartbeat = heartbeatService(db, { sleepBoundaryTracker: tracker });

    const cancelled = await heartbeat.cancelRun(runId);
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.sleepBoundaryCrossed).toBe(true);

    const [stored] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    expect(stored?.sleepBoundaryCrossed).toBe(true);
  });

  it("leaves the flag false when no sleep boundary occurred during the run", async () => {
    const { companyId, agentId } = await seedCompanyAgent(db);
    const runId = randomUUID();
    const startedAt = new Date("2026-04-28T05:00:00.000Z");

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
      startedAt,
      processStartedAt: startedAt,
    });

    // A sleep boundary that occurred *before* this run started.
    const tracker = buildPrimedTracker({
      sleptAt: new Date("2026-04-28T01:00:00.000Z"),
      wokeAt: new Date("2026-04-28T02:00:00.000Z"),
    });
    const heartbeat = heartbeatService(db, { sleepBoundaryTracker: tracker });

    const cancelled = await heartbeat.cancelRun(runId);
    expect(cancelled?.sleepBoundaryCrossed).toBe(false);
  });
});
