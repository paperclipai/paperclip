import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import { costService } from "../services/costs.js";
import { budgetService } from "../services/budgets.js";
import { accountingIntegrityService } from "../services/accounting-integrity.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("accounting mutation sentinels", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("accounting-mutation-"); db = createDb(database.connectionString); }, 30_000);
  afterAll(async () => { await database?.cleanup(); });
  async function fixture() {
    const [company] = await db.insert(companies).values({ name: "Mutation", issuePrefix: `M${randomUUID().slice(0,7)}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Worker", role: "engineer", adapterType: "process", status: "idle" }).returning();
    return { company, agent, receipt: { agentId: agent.id, provider: "fixture", model: "fixture", costCents: "1.0000001", idempotencyKey: randomUUID(), occurredAt: new Date() } };
  }
  it("deduplicates a retried receipt", async () => {
    const f = await fixture(), service = costService(db);
    const first = await service.createEvent(f.company.id, f.receipt);
    const second = await service.createEvent(f.company.id, f.receipt);
    expect(second.id, "ACCOUNTING_ASSERTION deduplication").toBe(first.id);
    expect((await service.summary(f.company.id)).eventCount).toBe(1);
  });
  it("isolates company reporting", async () => {
    const f = await fixture(), other = await fixture(), service = costService(db);
    await service.createEvent(f.company.id, f.receipt);
    await service.createEvent(other.company.id, { ...other.receipt, costCents: 1000 });
    expect((await service.summary(f.company.id)).spendCentsExact, "ACCOUNTING_ASSERTION company").toBe("1.0000001");
  });
  it("conserves agent projections", async () => {
    const f = await fixture();
    await costService(db).createEvent(f.company.id, f.receipt);
    await costService(db).createEvent(f.company.id, { ...f.receipt, idempotencyKey: "second" });
    expect((await accountingIntegrityService(db).inspect(f.company.id)).findings, "ACCOUNTING_ASSERTION projection").toEqual([]);
  });
  it("stops at the exact budget boundary", async () => {
    const f = await fixture();
    const budgets = budgetService(db);
    await budgets.upsertPolicy(f.company.id, { scopeType: "agent", scopeId: f.agent.id, amount: 1 }, "board");
    await costService(db).createEvent(f.company.id, { ...f.receipt, costCents: 1 });
    expect(await budgets.getInvocationBlock(f.company.id, f.agent.id), "ACCOUNTING_ASSERTION threshold").not.toBeNull();
  });
});
