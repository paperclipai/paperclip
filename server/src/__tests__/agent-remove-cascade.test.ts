// Regression: deleting a tenant agent that has ACTUALLY RUN must succeed.
//
// Live decommission 500 (2026-07): DELETE /api/agents/:id failed with
//   "delete on table heartbeat_runs violates foreign key constraint
//    cost_events_heartbeat_run_id_heartbeat_runs_id_fk"
// The agent-remove path deleted heartbeat_runs but never cleaned the
// cost_events / finance_events that reference those runs (and the agent) —
// tables added after the base delete handler was written. A bare-agent delete
// test would NOT have caught this: the failure only appears once the agent has
// a heartbeat_run with a linked cost_event, which every real conversation
// produces. (The original hypothesis — instructions-bundle / env-binding rows —
// was not the cause: those aren't agents.id foreign keys.)

import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  costEvents,
  createDb,
  financeEvents,
  heartbeatRuns,
} from "@paperclipai/db";

import { agentService } from "../services/agents.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();

describe("agentService.remove — tenant decommission cascade", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-remove-");
    db = createDb(tempDb.connectionString);
  });

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

  async function seedCompany(): Promise<string> {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Smoke Septic Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function insertAgent(companyId: string, name: string): Promise<string> {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "general",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  // The exact shape the live 500 hit: an agent with a heartbeat_run whose
  // cost_event and finance_event reference both the run and the agent.
  async function seedAgentWithUsage(companyId: string, name: string) {
    const agentId = await insertAgent(companyId, name);
    const runId = randomUUID();
    const costId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "completed",
      startedAt: new Date("2026-07-06T00:00:00.000Z"),
      finishedAt: new Date("2026-07-06T00:01:00.000Z"),
    });
    await db.insert(costEvents).values({
      id: costId,
      companyId,
      agentId,
      heartbeatRunId: runId, // cost_events_heartbeat_run_id_... FK — the blocker
      provider: "openai",
      model: "gpt-4o-mini",
      costCents: 3,
      occurredAt: new Date("2026-07-06T00:01:00.000Z"),
    });
    await db.insert(financeEvents).values({
      companyId,
      agentId,
      heartbeatRunId: runId,
      costEventId: costId, // finance → cost (RESTRICT): finance must delete first
      eventKind: "model_usage",
      biller: "openai",
      amountCents: 3,
      occurredAt: new Date("2026-07-06T00:01:00.000Z"),
    });
    return { agentId, runId, costId };
  }

  it("deletes an agent that has heartbeat_runs + cost_events + finance_events", async () => {
    const companyId = await seedCompany();
    const { agentId } = await seedAgentWithUsage(companyId, "intake-smoke-septic");

    const svc = agentService(db);
    const removed = await svc.remove(agentId);

    expect(removed?.id).toBe(agentId);
    expect(await svc.getById(agentId)).toBeNull();
    // usage telemetry for this agent is cleaned, unblocking the runs + agent delete
    expect(await db.select().from(financeEvents)).toHaveLength(0);
    expect(await db.select().from(costEvents)).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
  });

  it("does not touch another agent's usage rows in the same company", async () => {
    const companyId = await seedCompany();
    const { agentId: doomed } = await seedAgentWithUsage(companyId, "coordinator-smoke-septic");
    const { agentId: keeper } = await seedAgentWithUsage(companyId, "keeper-agent");

    await agentService(db).remove(doomed);

    // the keeper's telemetry survives (one run/cost/finance row each)
    expect(await agentService(db).getById(keeper)).not.toBeNull();
    expect(await db.select().from(costEvents)).toHaveLength(1);
    expect(await db.select().from(financeEvents)).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(1);
  });

  it("is idempotent — a second remove returns null (route maps this to 404)", async () => {
    const companyId = await seedCompany();
    const { agentId } = await seedAgentWithUsage(companyId, "intake-smoke-septic");

    const svc = agentService(db);
    expect((await svc.remove(agentId))?.id).toBe(agentId);
    expect(await svc.remove(agentId)).toBeNull();
  });

  it("still deletes a bare agent that never ran", async () => {
    const companyId = await seedCompany();
    const agentId = await insertAgent(companyId, "never-ran");
    expect((await agentService(db).remove(agentId))?.id).toBe(agentId);
  });
});
