import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agentMemories,
  agentMemoryConsolidationRuns,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import { agentMemoryConsolidationService } from "../services/agent-memory-consolidation.ts";
import { agentMemoryService } from "../services/agent-memories.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

async function seedCompanyAndAgent(db: ReturnType<typeof createDb>) {
  const companyId = randomUUID();
  const agentId = randomUUID();
  await db.insert(companies).values({
    id: companyId,
    name: "Atelier",
    issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
  });
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: "Sarah",
    role: "cto",
    status: "active",
    adapterType: "claude_local",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  });
  return { companyId, agentId };
}

async function seedRun(db: ReturnType<typeof createDb>, companyId: string, agentId: string, summary: string) {
  const id = randomUUID();
  await db.insert(heartbeatRuns).values({
    id,
    companyId,
    agentId,
    status: "succeeded",
    startedAt: new Date(Date.now() - 60_000),
    finishedAt: new Date(),
    resultJson: { summary },
  });
  return id;
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("agentMemoryConsolidationService (dreaming)", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof agentMemoryConsolidationService>;
  let memories!: ReturnType<typeof agentMemoryService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("atelier-memory-dreaming-");
    db = createDb(tempDb.connectionString);
    svc = agentMemoryConsolidationService(db);
    memories = agentMemoryService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agentMemoryConsolidationRuns);
    await db.delete(agentMemories);
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("ingests run summaries, dedupes, promotes recurring themes, leaves one-offs staged", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent(db);
    // A and C share "deploy/pipeline/migration" (recurring). B duplicates A (deduped).
    // D is a unique one-off (stays staged).
    await seedRun(db, companyId, agentId, "Deploy pipeline failed due to a missing database migration");
    await seedRun(db, companyId, agentId, "Deploy pipeline failed due to a missing database migration");
    await seedRun(db, companyId, agentId, "Deploy pipeline succeeded after adding the database migration");
    await seedRun(db, companyId, agentId, "Reviewed the quarterly budget spreadsheet thoroughly");

    const result = await svc.consolidateAgentMemories(companyId, agentId);

    expect(result.status).toBe("completed");
    expect(result.ingested).toBe(4); // four candidate runs
    expect(result.staged).toBe(3); // B deduped against A
    expect(result.promoted).toBe(2); // A and C share recurring terms

    const active = await memories.recall(companyId, agentId, { limit: 50 });
    expect(active).toHaveLength(2);
    expect(active.every((m) => m.type === "episodic")).toBe(true);

    const stillStaged = await db
      .select()
      .from(agentMemories)
      .where(and(eq(agentMemories.agentId, agentId), eq(agentMemories.status, "staged")));
    expect(stillStaged).toHaveLength(1); // the one-off D
    expect(stillStaged[0].body).toContain("budget spreadsheet");

    const runs = await db.select().from(agentMemoryConsolidationRuns).where(eq(agentMemoryConsolidationRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("completed");
    expect(runs[0].promoted).toBe(2);
  });

  it("forgets stale staged candidates that never recur", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent(db);
    // A staged memory created 20 days ago with unique terms, never promoted.
    await db.insert(agentMemories).values({
      companyId,
      agentId,
      type: "episodic",
      title: "Old unique note",
      body: "An obsolete one-off observation about zzz widget xyzzy",
      status: "staged",
      createdAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
      updatedAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
    });

    const result = await svc.consolidateAgentMemories(companyId, agentId);
    expect(result.forgotten).toBe(1);

    const remaining = await db
      .select()
      .from(agentMemories)
      .where(and(eq(agentMemories.agentId, agentId), eq(agentMemories.status, "staged")));
    expect(remaining).toHaveLength(0);
  });

  it("ingests only activity since the previous consolidation, not the whole lookback window", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent(db);
    const now = new Date();
    // A previous consolidation finished 1 hour ago.
    await db.insert(agentMemoryConsolidationRuns).values({
      companyId,
      agentId,
      status: "completed",
      startedAt: new Date(now.getTime() - 60 * 60 * 1000),
      finishedAt: new Date(now.getTime() - 60 * 60 * 1000),
    });
    // One run AFTER the last consolidation (should ingest) and one BEFORE it (should not).
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      status: "succeeded",
      startedAt: new Date(now.getTime() - 31 * 60 * 1000),
      finishedAt: new Date(now.getTime() - 30 * 60 * 1000),
      resultJson: { summary: "Recent deploy pipeline event after last consolidation" },
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      status: "succeeded",
      startedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
      finishedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000 + 1000),
      resultJson: { summary: "Stale event from before the last consolidation" },
    });

    const result = await svc.consolidateAgentMemories(companyId, agentId, now);
    expect(result.ingested).toBe(1); // only the run after the previous consolidation
  });

  it("ignores soft-deleted agent comments during ingestion", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent(db);
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Issue", status: "in_progress" });
    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorAgentId: agentId,
      body: "Kept comment about the alpha widget rollout",
    });
    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorAgentId: agentId,
      body: "Deleted comment about the beta secret that must not resurface",
      deletedAt: new Date(),
    });

    await svc.consolidateAgentMemories(companyId, agentId);

    const all = await db.select().from(agentMemories).where(eq(agentMemories.agentId, agentId));
    expect(all.some((m) => m.body.includes("alpha widget"))).toBe(true);
    expect(all.some((m) => m.body.includes("beta secret"))).toBe(false);
  });

  it("tick picks up due active agents and records a consolidation run", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent(db);
    await seedRun(db, companyId, agentId, "Shipped the onboarding flow and shipped the onboarding emails");

    const out = await svc.tickMemoryConsolidation(new Date());
    expect(out.processed).toBe(1);

    const runs = await db.select().from(agentMemoryConsolidationRuns).where(eq(agentMemoryConsolidationRuns.agentId, agentId));
    expect(runs).toHaveLength(1);

    // Running the tick again immediately should skip (cadence not elapsed).
    const out2 = await svc.tickMemoryConsolidation(new Date());
    expect(out2.processed).toBe(0);
  });
});
