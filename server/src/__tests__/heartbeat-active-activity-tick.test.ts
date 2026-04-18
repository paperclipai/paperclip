import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
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
    `Skipping embedded Postgres active-activity tick tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat tickActiveAgentActivity", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-activity-tick-");
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

  it("ticks lastActivityAt for agents with a running heartbeat run and leaves lastHeartbeatAt alone", async () => {
    const companyId = randomUUID();
    const runningAgentId = randomUUID();
    const idleAgentId = randomUUID();
    const priorHeartbeat = new Date(Date.now() - 10 * 60 * 1000);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: runningAgentId,
        companyId,
        name: "Running",
        role: "engineer",
        status: "running",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
        lastHeartbeatAt: priorHeartbeat,
      },
      {
        id: idleAgentId,
        companyId,
        name: "Idle",
        role: "engineer",
        status: "idle",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
        lastHeartbeatAt: priorHeartbeat,
      },
    ]);

    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: runningAgentId,
      invocationSource: "assignment",
      status: "running",
      contextSnapshot: {},
    });

    const svc = heartbeatService(db);
    const now = new Date();
    const result = await svc.tickActiveAgentActivity(now);
    expect(result.ticked).toBe(1);

    const [runningRow] = await db.select().from(agents).where(eq(agents.id, runningAgentId));
    const [idleRow] = await db.select().from(agents).where(eq(agents.id, idleAgentId));

    expect(runningRow.lastActivityAt?.getTime()).toBe(now.getTime());
    expect(runningRow.lastHeartbeatAt?.getTime()).toBe(priorHeartbeat.getTime());
    expect(idleRow.lastActivityAt).toBeNull();
    expect(idleRow.lastHeartbeatAt?.getTime()).toBe(priorHeartbeat.getTime());
  });
});
