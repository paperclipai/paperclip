import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns, type Db, type EmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { canAdmitExecutionResources, readExecutionResourceRequest } from "../services/execution-resource-admission.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Resource admission PostgreSQL unavailable: ${support.reason}`);
const databaseDescribe = support.supported ? describe : describe.skip;

databaseDescribe("atomic execution resource admission", () => {
  let db: Db;
  let database: EmbeddedPostgresTestDatabase;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-resource-admission-");
    db = createDb(database.connectionString);
  }, 20_000);
  afterAll(async () => { await database?.cleanup(); });

  async function fixture(capacity: { cpu: number; memoryMb: number; providers: Record<string, number> }) {
    const pool = randomUUID();
    const env = { PAPERCLIP_EXECUTION_RESOURCE_POOLS: JSON.stringify({ [pool]: capacity }) };
    const company = (await db.insert(companies).values({ name: pool, issuePrefix: `R${pool.slice(0, 7)}` }).returning())[0]!;
    async function worker(provider: string, cpu = 2, memoryMb = 4096, companyId = company.id) {
      return (await db.insert(agents).values({ companyId, name: randomUUID(), role: "engineer", status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: { executionResources: { pool, cpu, memoryMb, provider } } }).returning())[0]!;
    }
    async function claim(agent: typeof agents.$inferSelect) {
      return db.transaction(async (tx) => {
        if (!await canAdmitExecutionResources(tx as unknown as Db, agent, env)) return null;
        return (await tx.insert(heartbeatRuns).values({ companyId: agent.companyId, agentId: agent.id, invocationSource: "on_demand", triggerDetail: "manual", status: "running", contextSnapshot: { executionResourceReservation: readExecutionResourceRequest(agent.runtimeConfig) } }).returning())[0]!;
      });
    }
    return { pool, env, company, worker, claim };
  }

  it("serializes competing claims across companies sharing one physical host and frees terminal reservations", async () => {
    const f = await fixture({ cpu: 4, memoryMb: 8192, providers: { deepseek: 20 } });
    const secondCompany = (await db.insert(companies).values({ name: randomUUID(), issuePrefix: "OTHERRES" }).returning())[0]!;
    const workers = await Promise.all([f.worker("deepseek"), f.worker("deepseek", 2, 4096, secondCompany.id), f.worker("deepseek"), f.worker("deepseek")]);
    const results = await Promise.all(workers.map(f.claim));
    const admitted = results.filter((run) => run !== null);
    expect(admitted).toHaveLength(2);
    const waiting = workers[results.findIndex((run) => run === null)]!;
    expect(await f.claim(waiting)).toBeNull();
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, admitted[0]!.id));
    expect((await f.claim(waiting))?.agentId).toBe(waiting.id);
  });

  it("enforces provider and memory limits independently of available CPU", async () => {
    const f = await fixture({ cpu: 20, memoryMb: 8192, providers: { deepseek: 1, "openai-codex": 10 } });
    const first = await f.worker("deepseek", 1);
    const second = await f.worker("deepseek", 1);
    const astra = await f.worker("openai-codex", 1);
    expect((await f.claim(first))?.agentId).toBe(first.id);
    expect(await f.claim(second)).toBeNull();
    expect((await f.claim(astra))?.agentId).toBe(astra.id);
    expect(await f.claim(await f.worker("openai-codex", 1))).toBeNull();
  });

  it("retains active reservations after an agent configuration change and fails closed without operator capacity", async () => {
    const f = await fixture({ cpu: 2, memoryMb: 4096, providers: { deepseek: 20 } });
    const active = await f.worker("deepseek");
    await f.claim(active);
    await db.update(agents).set({ runtimeConfig: {} }).where(eq(agents.id, active.id));
    const waiting = await f.worker("deepseek");
    expect(await f.claim(waiting)).toBeNull();
    await expect(db.transaction((tx) => canAdmitExecutionResources(tx as unknown as Db, waiting, {}))).rejects.toThrow("operator capacity");
  });
});
