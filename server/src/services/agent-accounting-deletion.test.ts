import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { agents, companies, costEvents, createDb, heartbeatRuns } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { createAgentLifecycle } from "./agent-lifecycle.js";
import { deleteCompany } from "./company-deletion.js";

describe("agent purge with retained cost history", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("agent-accounting-deletion-");
    db = createDb(temporary.connectionString);
  });
  afterAll(async () => { await temporary?.cleanup(); });

  async function fixture(link: "run" | "agent" | "none") {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Cost deletion", issuePrefix: `K${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Costed worker",
      status: "terminated", lifecycleState: "terminated" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "succeeded" });
    if (link !== "none") {
      await db.insert(costEvents).values({ companyId, agentId: link === "agent" ? agentId : null,
        heartbeatRunId: link === "run" ? runId : null, provider: "openai", model: "gpt-test",
        costCents: 3, occurredAt: new Date() });
    }
    return { companyId, agentId, runId };
  }

  it.each(["run", "agent"] as const)("refuses to purge an agent with cost history linked by %s", async link => {
    const f = await fixture(link);

    await expect(createAgentLifecycle(db).purgeAgent(f.agentId)).rejects.toMatchObject({ status: 409,
      details: { code: "agent_accounting_history_retained" } });

    expect(await db.select().from(agents).where(eq(agents.id, f.agentId))).toMatchObject([{ lifecycleState: "terminated" }]);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId))).toHaveLength(1);
    expect(await db.select().from(costEvents).where(eq(costEvents.companyId, f.companyId))).toHaveLength(1);
  });

  it("still purges an agent without cost history", async () => {
    const f = await fixture("none");

    expect(await createAgentLifecycle(db).purgeAgent(f.agentId)).toMatchObject({ id: f.agentId });

    expect(await db.select().from(agents).where(eq(agents.id, f.agentId))).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId))).toHaveLength(0);
  });

  it("still deletes the whole company with agent cost history", async () => {
    const f = await fixture("run");

    expect(await deleteCompany(db, f.companyId)).toMatchObject({ id: f.companyId });

    expect(await db.select().from(companies).where(eq(companies.id, f.companyId))).toHaveLength(0);
    expect(await db.select().from(costEvents).where(eq(costEvents.companyId, f.companyId))).toHaveLength(0);
  });
});
