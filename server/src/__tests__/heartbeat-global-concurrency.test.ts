import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
    `Skipping embedded Postgres heartbeat global concurrency tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat global concurrency limit", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousGlobalLimit = process.env.PAPERCLIP_MAX_CONCURRENT_HEARTBEAT_RUNS;

  beforeAll(async () => {
    process.env.PAPERCLIP_MAX_CONCURRENT_HEARTBEAT_RUNS = "1";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-global-concurrency-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterAll(async () => {
    if (previousGlobalLimit == null) {
      delete process.env.PAPERCLIP_MAX_CONCURRENT_HEARTBEAT_RUNS;
    } else {
      process.env.PAPERCLIP_MAX_CONCURRENT_HEARTBEAT_RUNS = previousGlobalLimit;
    }
    await tempDb?.cleanup();
  });

  async function waitForStatus(runId: string, status: "queued" | "running", timeoutMs = 3_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      if (run?.status === status) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for run ${runId} to reach ${status}`);
  }

  it("keeps later agent runs queued when the global cap is full", async () => {
    const companyId = randomUUID();
    const firstAgentId = randomUUID();
    const secondAgentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    for (const [agentId, name] of [
      [firstAgentId, "AgentOne"],
      [secondAgentId, "AgentTwo"],
    ] as const) {
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name,
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {
          command: process.execPath,
          args: ["-e", "setTimeout(() => process.exit(0), 1500)"],
        },
        runtimeConfig: {
          heartbeat: {
            wakeOnDemand: true,
            maxConcurrentRuns: 5,
          },
        },
        permissions: {},
      });
    }

    const firstRun = await heartbeat.invoke(firstAgentId, "on_demand", {}, "manual");
    expect(firstRun).not.toBeNull();
    await waitForStatus(firstRun!.id, "running");

    const secondRun = await heartbeat.invoke(secondAgentId, "on_demand", {}, "manual");
    expect(secondRun).not.toBeNull();
    await waitForStatus(secondRun!.id, "queued");

    const allRuns = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns);

    expect(allRuns.filter((run) => run.status === "running")).toHaveLength(1);
    expect(allRuns.find((run) => run.id === secondRun!.id)?.status).toBe("queued");
  });
});
