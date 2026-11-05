import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { agents, companies, costEvents, createDb, financeEvents, heartbeatRuns } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { createAgentLifecycle } from "./agent-lifecycle.js";
import { deleteCompany } from "./company-deletion.js";

type Ledger = "cost" | "finance";
type Link = "run" | "agent";

describe("agent purge with retained accounting history", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("agent-accounting-deletion-");
    db = createDb(temporary.connectionString);
  });
  afterAll(async () => { await temporary?.cleanup(); });

  async function fixture(ledger?: Ledger, link?: Link) {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Cost deletion", issuePrefix: `K${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Costed worker",
      status: "terminated", lifecycleState: "terminated" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "succeeded" });
    const linkedAgentId = link === "agent" ? agentId : null;
    const heartbeatRunId = link === "run" ? runId : null;
    if (ledger === "cost") {
      await db.insert(costEvents).values({ companyId, agentId: linkedAgentId, heartbeatRunId,
        usageKind: link === "agent" ? "agent" : "decision", provider: "openai", model: "gpt-test",
        costCents: 3, occurredAt: new Date() });
    }
    if (ledger === "finance") {
      await db.insert(financeEvents).values({ companyId, agentId: linkedAgentId, heartbeatRunId,
        eventKind: "usage", biller: "openai", amountCents: 3, occurredAt: new Date() });
    }
    return { companyId, agentId, runId };
  }

  async function ledgerRows(ledger: Ledger, companyId: string) {
    return ledger === "cost"
      ? db.select().from(costEvents).where(eq(costEvents.companyId, companyId))
      : db.select().from(financeEvents).where(eq(financeEvents.companyId, companyId));
  }

  it.each([["cost", "run"], ["cost", "agent"], ["finance", "run"], ["finance", "agent"]] as const)(
    "refuses to purge an agent with %s history linked by %s", async (ledger, link) => {
      const f = await fixture(ledger, link);

      await expect(createAgentLifecycle(db).purgeAgent(f.agentId)).rejects.toMatchObject({ status: 409,
        details: { code: "agent_accounting_history_retained" } });

      expect(await db.select().from(agents).where(eq(agents.id, f.agentId))).toMatchObject([{ lifecycleState: "terminated" }]);
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId))).toHaveLength(1);
      expect(await ledgerRows(ledger, f.companyId)).toHaveLength(1);
    });

  it("still purges an agent without accounting history", async () => {
    const f = await fixture();

    expect(await createAgentLifecycle(db).purgeAgent(f.agentId)).toMatchObject({ id: f.agentId });

    expect(await db.select().from(agents).where(eq(agents.id, f.agentId))).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId))).toHaveLength(0);
  });

  it("still deletes the whole company with run-linked cost history", async () => {
    const f = await fixture("cost", "run");

    expect(await deleteCompany(db, f.companyId)).toMatchObject({ id: f.companyId });

    expect(await db.select().from(companies).where(eq(companies.id, f.companyId))).toHaveLength(0);
    expect(await ledgerRows("cost", f.companyId)).toHaveLength(0);
  });
});
