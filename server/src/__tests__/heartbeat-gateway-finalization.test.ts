import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("heartbeat gateway finalization", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-gateway-finalization-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => tempDb?.cleanup());

  it("keeps a normally executed run unacknowledged when gateway token revocation cannot be proven", async () => {
    const company = await db
      .insert(companies)
      .values({
        name: "Gateway Finalization Test",
        issuePrefix: `GF${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);
    const agent = await db
      .insert(agents)
      .values({
        companyId: company.id,
        name: "Gateway Finalization Agent",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
      })
      .returning()
      .then((rows) => rows[0]!);
    let revocationAttempts = 0;
    const heartbeat = heartbeatService(db, {
      runtimeEnv: {},
      revokeRunGatewayTokens: async () => {
        revocationAttempts += 1;
        throw new Error("gateway token store unavailable");
      },
    });

    const run = await heartbeat.wakeup(agent.id, {
      source: "on_demand",
      requestedByActorType: "user",
      requestedByActorId: "board-user",
    });
    expect(run).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();

    await expect(heartbeat.getRun(run!.id)).resolves.toMatchObject({
      status: "failed",
      executionFinalizerCompletedAt: null,
      executionFinalizedAt: null,
    });
    expect(revocationAttempts).toBeGreaterThanOrEqual(1);
  });
});
