import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat daily-stats tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/** Mittag UTC am Tag `daysAgo` vor heute — mittags, damit keine Zeitzone den Tag kippt. */
function utcNoonDaysAgo(daysAgo: number): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysAgo, 12, 0, 0),
  );
}

function utcDateKey(daysAgo: number): string {
  return utcNoonDaysAgo(daysAgo).toISOString().slice(0, 10);
}

describeEmbeddedPostgres("heartbeat listDailyStats", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;
  let otherAgentId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-daily-stats-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyWithAgents() {
    companyId = randomUUID();
    agentId = randomUUID();
    otherAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    for (const [id, name] of [
      [agentId, "CodexCoder"],
      [otherAgentId, "OtherAgent"],
    ] as const) {
      await db.insert(agents).values({
        id,
        companyId,
        name,
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
    }
  }

  async function insertRun(status: string, daysAgo: number, forAgentId = agentId) {
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: forAgentId,
      status,
      createdAt: utcNoonDaysAgo(daysAgo),
    });
  }

  it("groups runs per UTC day and counts succeeded, failed and other", async () => {
    await seedCompanyWithAgents();
    await insertRun("succeeded", 1);
    await insertRun("succeeded", 1);
    await insertRun("failed", 1);
    await insertRun("queued", 1);
    await insertRun("succeeded", 0);
    await insertRun("cancelled", 0);

    const stats = await heartbeatService(db).listDailyStats(companyId, 14);

    expect(stats).toEqual([
      { date: utcDateKey(1), succeeded: 2, failed: 1, other: 1 },
      { date: utcDateKey(0), succeeded: 1, failed: 0, other: 1 },
    ]);
  });

  it("counts error and timeout runs as failed, not as other", async () => {
    await seedCompanyWithAgents();
    await insertRun("error", 0);
    await insertRun("timeout", 0);
    await insertRun("running", 0);

    const stats = await heartbeatService(db).listDailyStats(companyId, 14);

    expect(stats).toEqual([{ date: utcDateKey(0), succeeded: 0, failed: 2, other: 1 }]);
  });

  it("only counts runs inside the requested day window", async () => {
    await seedCompanyWithAgents();
    await insertRun("succeeded", 0);
    await insertRun("succeeded", 1);
    // Ausserhalb eines 2-Tage-Fensters (heute + gestern)
    await insertRun("succeeded", 5);

    const stats = await heartbeatService(db).listDailyStats(companyId, 2);

    expect(stats.map((row) => row.date)).toEqual([utcDateKey(1), utcDateKey(0)]);
  });

  it("filters by agent when an agentId is given", async () => {
    await seedCompanyWithAgents();
    await insertRun("succeeded", 0);
    await insertRun("failed", 0, otherAgentId);

    const stats = await heartbeatService(db).listDailyStats(companyId, 14, agentId);

    expect(stats).toEqual([{ date: utcDateKey(0), succeeded: 1, failed: 0, other: 0 }]);
  });

  it("returns an empty list when the company has no runs", async () => {
    await seedCompanyWithAgents();

    await expect(heartbeatService(db).listDailyStats(companyId, 14)).resolves.toEqual([]);
  });
});
