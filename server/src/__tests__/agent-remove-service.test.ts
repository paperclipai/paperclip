import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  costEvents,
  createDb,
  financeEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent removal tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agentService.remove", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof agentService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-remove-");
    db = createDb(tempDb.connectionString);
    svc = agentService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(financeEvents);
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("removes finance and cost rows before deleting heartbeat runs", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Motion Video Engineer",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "manual",
      status: "succeeded",
      startedAt: new Date("2026-03-28T10:00:00.000Z"),
      finishedAt: new Date("2026-03-28T10:01:00.000Z"),
    });

    const [costEvent] = await db
      .insert(costEvents)
      .values({
        companyId,
        agentId,
        heartbeatRunId: runId,
        provider: "openai",
        biller: "openai",
        billingType: "metered",
        model: "gpt-5.4",
        inputTokens: 10,
        outputTokens: 20,
        cachedInputTokens: 0,
        costCents: 42,
        occurredAt: new Date("2026-03-28T10:01:00.000Z"),
      })
      .returning();

    await db.insert(financeEvents).values({
      companyId,
      agentId,
      heartbeatRunId: runId,
      costEventId: costEvent!.id,
      eventKind: "usage_charge",
      direction: "debit",
      biller: "openai",
      provider: "openai",
      model: "gpt-5.4",
      amountCents: 42,
      occurredAt: new Date("2026-03-28T10:01:00.000Z"),
    });

    const removed = await svc.remove(agentId);

    expect(removed?.id).toBe(agentId);
    await expect(db.select().from(agents).where(eq(agents.id, agentId))).resolves.toHaveLength(0);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId))).resolves.toHaveLength(0);
    await expect(db.select().from(costEvents).where(eq(costEvents.agentId, agentId))).resolves.toHaveLength(0);
    await expect(db.select().from(financeEvents).where(eq(financeEvents.agentId, agentId))).resolves.toHaveLength(0);
  });
});
