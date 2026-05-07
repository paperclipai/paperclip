import { randomUUID } from "node:crypto";
import { and, eq, notInArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRunEvents, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent pause race tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent pause status race", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-pause-race-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertCompanyAndAgent(status: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Test Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    return { companyId, agentId };
  }

  it("cancelRun preserves paused status when agent is already paused", async () => {
    const { companyId, agentId } = await insertCompanyAndAgent("paused");

    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "queued",
      contextSnapshot: { issueId: randomUUID() },
    });

    await heartbeatService(db).cancelRun(runId);

    const [updated] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(updated?.status).toBe("paused");
  });

  it("finalizeAgentStatus WHERE clause does not overwrite paused status (atomicity guard)", async () => {
    const { agentId } = await insertCompanyAndAgent("paused");

    // Simulate the race: the UPDATE that finalizeAgentStatus issues (with notInArray guard)
    // should match 0 rows when agent is paused, leaving status unchanged.
    const rows = await db
      .update(agents)
      .set({ status: "idle" })
      .where(
        and(
          eq(agents.id, agentId),
          notInArray(agents.status, ["paused", "terminated"]),
        ),
      )
      .returning();

    expect(rows).toHaveLength(0);

    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(row?.status).toBe("paused");
  });

  it("finalizeAgentStatus WHERE clause does not overwrite terminated status (atomicity guard)", async () => {
    const { agentId } = await insertCompanyAndAgent("terminated");

    const rows = await db
      .update(agents)
      .set({ status: "idle" })
      .where(
        and(
          eq(agents.id, agentId),
          notInArray(agents.status, ["paused", "terminated"]),
        ),
      )
      .returning();

    expect(rows).toHaveLength(0);

    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(row?.status).toBe("terminated");
  });

  it("finalizeAgentStatus WHERE clause DOES update non-protected statuses", async () => {
    const { agentId } = await insertCompanyAndAgent("running");

    const rows = await db
      .update(agents)
      .set({ status: "idle" })
      .where(
        and(
          eq(agents.id, agentId),
          notInArray(agents.status, ["paused", "terminated"]),
        ),
      )
      .returning();

    expect(rows).toHaveLength(1);

    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(row?.status).toBe("idle");
  });
});
