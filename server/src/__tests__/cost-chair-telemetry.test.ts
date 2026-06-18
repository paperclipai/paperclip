import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agents, companies, costEvents, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { costService } from "../services/costs.ts";

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping chair-telemetry tests: ${support.reason ?? "embedded pg unsupported"}`);
}

d("cost_events chair telemetry (per-seat dimension)", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof costService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-chair-");
    db = createDb(tempDb.connectionString);
    svc = costService(db);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });

  afterAll(async () => {
    try { await (tempDb as { stop?: () => Promise<void> } | null)?.stop?.(); } catch { /* noop */ }
  });

  async function seedCompany() {
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "C",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 7).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
  }

  async function seedAgent(env: Record<string, unknown> | null): Promise<string> {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name: `a-${id.slice(0, 4)}`,
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: env ? { env } : {},
      runtimeConfig: {},
      permissions: {},
    });
    return id;
  }

  async function makeEvent(agentId: string) {
    await svc.createEvent(companyId, {
      agentId,
      provider: "anthropic",
      model: "claude-haiku-4-5",
      costCents: 0,
      occurredAt: new Date(),
      inputTokens: 10,
      outputTokens: 5,
    });
    const [row] = await db.select().from(costEvents).where(eq(costEvents.agentId, agentId));
    return row;
  }

  it("T10 — plain CLAUDE_CONFIG_DIR -> chairId populated", async () => {
    await seedCompany();
    const a = await seedAgent({ CLAUDE_CONFIG_DIR: "/chairs/hq-haiku-1" });
    const row = await makeEvent(a);
    expect(row.chairId).toBe("/chairs/hq-haiku-1");
  });

  it("T10b — wrapped {type,value} CLAUDE_CONFIG_DIR -> chairId from value", async () => {
    await seedCompany();
    const a = await seedAgent({ CLAUDE_CONFIG_DIR: { type: "plain", value: "/chairs/info-roc" } });
    const row = await makeEvent(a);
    expect(row.chairId).toBe("/chairs/info-roc");
  });

  it("T11 — API-key agent (no CLAUDE_CONFIG_DIR) -> chairId null", async () => {
    await seedCompany();
    const a = await seedAgent({ ANTHROPIC_API_KEY: "sk-test" });
    const row = await makeEvent(a);
    expect(row.chairId).toBeNull();
  });
});
