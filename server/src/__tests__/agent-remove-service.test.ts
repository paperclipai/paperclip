import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  createDb,
  companies,
  agents,
  goals,
  projects,
  routines,
  costEvents,
  heartbeatRuns,
  agentConfigRevisions,
} from "@paperclipai/db";
import { agentService } from "../services/agents.ts";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.ts";

describe("agentService.remove with accumulated history", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof agentService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-remove-");
    db = createDb(tempDb.connectionString);
    svc = agentService(db);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("hard-deletes an agent that owns goals, leads a project, is a routine assignee, and has runs/costs/config revisions", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const goalId = randomUUID();
    const projectId = randomUUID();
    const routineId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Doomed Agent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    // References that previously aborted the delete (restrict FKs):
    await db.insert(goals).values({ id: goalId, companyId, title: "Owned goal", ownerAgentId: agentId });
    await db.insert(projects).values({ id: projectId, companyId, name: "Led project", status: "active", leadAgentId: agentId });
    await db.insert(routines).values({ id: routineId, companyId, title: "Assigned routine", assigneeAgentId: agentId });
    // References the original remove() already cleaned up:
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "automation",
      status: "succeeded",
    });
    // cost_events references the agent AND the heartbeat run (heartbeat_run_id) —
    // guards the delete-ordering: cost_events must be removed before heartbeat_runs.
    await db.insert(costEvents).values({
      companyId,
      agentId,
      projectId,
      heartbeatRunId: runId,
      provider: "openai",
      biller: "openai",
      billingType: "metered_api",
      model: "gpt-5",
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 50,
      costCents: 10,
      occurredAt: new Date("2026-04-10T00:00:00.000Z"),
    });
    await db.insert(agentConfigRevisions).values({
      companyId,
      agentId,
      source: "manual",
      patch: {},
      changedKeys: [],
      beforeConfig: {},
      afterConfig: {},
    });

    // Previously this threw → 500. Now it must succeed and return the deleted agent.
    const deleted = await svc.remove(agentId);
    expect(deleted?.id).toBe(agentId);

    // Agent row gone.
    expect((await db.select().from(agents).where(eq(agents.id, agentId))).length).toBe(0);

    // Nullable references preserved-but-detached.
    expect((await db.select().from(goals).where(eq(goals.id, goalId)))[0]?.ownerAgentId).toBeNull();
    expect((await db.select().from(projects).where(eq(projects.id, projectId)))[0]?.leadAgentId).toBeNull();
    expect((await db.select().from(routines).where(eq(routines.id, routineId)))[0]?.assigneeAgentId).toBeNull();

    // NOT NULL references deleted with the agent.
    expect((await db.select().from(costEvents).where(eq(costEvents.agentId, agentId))).length).toBe(0);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId))).length).toBe(0);
    expect((await db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, agentId))).length).toBe(0);
  }, 30_000);
});
