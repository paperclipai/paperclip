import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, costEvents, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { createRunUsageRecorder } from "../services/usage-receipts.js";
import { accountRunCost } from "../services/run-cost-accounting.js";
import { resolveOpenCodeAccounting } from "../../../packages/adapters/opencode-local/src/server/billing.js";

describe("managed OpenCode durable cost receipts", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const directories: string[] = [];
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("managed-opencode-cost-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => {
    for (const directory of directories) await fs.rm(directory, { force: true, recursive: true });
    await database?.cleanup();
  }, 30_000);
  it.each([true, false])("persists the route and honest cost status through the ledger (direct=%s)", async direct => {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Accounting fixture", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Fixture", role: "engineer", status: "idle", adapterType: "opencode_local" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", status: "running" });
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "managed-opencode-receipts-")); directories.push(directory);
    const recorder = await createRunUsageRecorder(db, { companyId, runId, adapterType: "opencode_local" }, directory);
    await recorder.capture({
      ...resolveOpenCodeAccounting({ kind: "gateway", auth: "bearer", baseUrl: direct ? "https://api.openai.com/v1" : "https://proxy.example/v1" }, {}, "paperclip/gpt-6-sol", 0),
      usage: { inputTokens: 118647, cachedInputTokens: 1407315, outputTokens: 5296 }, usageBasis: "per_run", complete: true,
    });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run.usageJson).toMatchObject({ provider: "openai", biller: direct ? "openai" : "unknown", billingType: "metered_api", model: "gpt-6-sol", costUsd: null,
      costStatus: direct ? "estimated" : "unpriced", costUsdExact: direct ? "0.571717000" : null });
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    expect(await accountRunCost(db, runId)).toBe(true);
    expect(await accountRunCost(db, runId)).toBe(false);
    const events = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, runId));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ companyId, agentId, provider: "openai", biller: direct ? "openai" : "unknown", billingType: "metered_api", model: "gpt-6-sol",
      costStatus: direct ? "estimated" : "unpriced", costCents: direct ? 57.1717 : 0 });
  }, 15_000);
});
