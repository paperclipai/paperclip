import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  costEvents,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { costService } from "../services/costs.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres execution-segments tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("segmented execution cost events", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-segments-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Segments Co",
      mission: "test",
      status: "active",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Routing Agent",
      role: "engineer",
      adapterType: "codex_local",
      status: "idle",
      systemPrompt: "",
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupId,
      agentId,
      companyId,
      type: "heartbeat",
      source: "scheduler",
      status: "pending",
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      agentId,
      companyId,
      wakeupRequestId: wakeupId,
      status: "running",
      contextSnapshot: {},
    });

    return { companyId, agentId, runId };
  }

  it("allows multiple cost events per run for segmented execution", async () => {
    const { companyId, agentId, runId } = await seedFixture();
    const costs = costService(db);

    // Simulate cheap preflight segment
    await costs.createEvent(companyId, {
      heartbeatRunId: runId,
      agentId,
      provider: "anthropic",
      biller: "anthropic",
      billingType: "metered_api",
      model: "claude-haiku-4",
      inputTokens: 1200,
      cachedInputTokens: 0,
      outputTokens: 300,
      costCents: 1,
      occurredAt: new Date(),
    });

    // Simulate primary execution segment
    await costs.createEvent(companyId, {
      heartbeatRunId: runId,
      agentId,
      provider: "anthropic",
      biller: "anthropic",
      billingType: "metered_api",
      model: "claude-sonnet-4",
      inputTokens: 45000,
      cachedInputTokens: 12000,
      outputTokens: 8000,
      costCents: 42,
      occurredAt: new Date(),
    });

    const events = await db
      .select()
      .from(costEvents)
      .where(eq(costEvents.heartbeatRunId, runId));

    expect(events).toHaveLength(2);

    const preflight = events.find((e) => e.model === "claude-haiku-4");
    const primary = events.find((e) => e.model === "claude-sonnet-4");

    expect(preflight).toBeDefined();
    expect(primary).toBeDefined();

    expect(preflight!.inputTokens).toBe(1200);
    expect(preflight!.outputTokens).toBe(300);
    expect(preflight!.costCents).toBe(1);

    expect(primary!.inputTokens).toBe(45000);
    expect(primary!.cachedInputTokens).toBe(12000);
    expect(primary!.outputTokens).toBe(8000);
    expect(primary!.costCents).toBe(42);
  });

  it("preserves per-segment provider and biller attribution", async () => {
    const { companyId, agentId, runId } = await seedFixture();
    const costs = costService(db);

    await costs.createEvent(companyId, {
      heartbeatRunId: runId,
      agentId,
      provider: "openai",
      biller: "openai",
      billingType: "metered_api",
      model: "gpt-5-mini",
      inputTokens: 800,
      outputTokens: 200,
      costCents: 0,
      occurredAt: new Date(),
    });

    await costs.createEvent(companyId, {
      heartbeatRunId: runId,
      agentId,
      provider: "anthropic",
      biller: "anthropic",
      billingType: "metered_api",
      model: "claude-sonnet-4",
      inputTokens: 30000,
      outputTokens: 5000,
      costCents: 28,
      occurredAt: new Date(),
    });

    const events = await db
      .select()
      .from(costEvents)
      .where(eq(costEvents.heartbeatRunId, runId));

    expect(events).toHaveLength(2);
    const providers = events.map((e) => e.provider).sort();
    expect(providers).toEqual(["anthropic", "openai"]);

    const models = events.map((e) => e.model).sort();
    expect(models).toEqual(["claude-sonnet-4", "gpt-5-mini"]);
  });
});