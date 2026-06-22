/**
 * Unit-level integration tests for diagnosePlanHealth (plan-supervision.ts).
 *
 * Seeds company, agents, plan root issue + plan_details, subtree issues, and
 * heartbeat_runs in varied states. Asserts the health classification for each
 * agent matches the expected AgentHealth value.
 *
 * Uses the embedded Postgres harness so queries run against real SQL and real
 * FK constraints.
 */

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  planDetails,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS,
  ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS,
} from "../services/recovery/service.js";
import { diagnosePlanHealth } from "../services/plan-supervision.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plan-supervision tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("diagnosePlanHealth", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plan-supervision-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(planDetails);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Test Company ${companyId.slice(0, 6)}`,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, status = "idle") {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Agent ${agentId.slice(0, 6)}`,
      role: "engineer",
      status,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true } },
      permissions: {},
    });
    return agentId;
  }

  async function seedPlanRoot(companyId: string, opts: { estimatedCompletionAt?: Date } = {}) {
    const rootId = randomUUID();
    await db.insert(issues).values({
      id: rootId,
      companyId,
      title: "Test Plan",
      workMode: "planning",
      status: "in_progress",
    });
    await db.insert(planDetails).values({
      issueId: rootId,
      companyId,
      state: "active",
      ...(opts.estimatedCompletionAt ? { estimatedCompletionAt: opts.estimatedCompletionAt } : {}),
    });
    return rootId;
  }

  async function seedSubtreeIssue(companyId: string, rootId: string, agentId: string, status = "in_progress") {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Subtask",
      planRootIssueId: rootId,
      assigneeAgentId: agentId,
      status,
    });
    return issueId;
  }

  async function seedRun(
    companyId: string,
    agentId: string,
    opts: {
      status?: string;
      lastOutputAt?: Date | null;
      livenessState?: string | null;
      startedAt?: Date;
    } = {},
  ) {
    const runId = randomUUID();
    const now = new Date();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      startedAt: opts.startedAt ?? new Date(now.getTime() - 5 * 60 * 1000),
      status: opts.status ?? "running",
      lastOutputAt: opts.lastOutputAt !== undefined ? opts.lastOutputAt : new Date(now.getTime() - 5 * 60 * 1000),
      livenessState: opts.livenessState ?? null,
    });
    return runId;
  }

  it("classifies a running agent with recent output as 'working'", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "running");
    const rootId = await seedPlanRoot(companyId);
    await seedSubtreeIssue(companyId, rootId, agentId);
    await seedRun(companyId, agentId, {
      status: "running",
      lastOutputAt: new Date(Date.now() - 5 * 60 * 1000), // 5 min ago
    });

    const result = await diagnosePlanHealth(rootId, db);
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].health).toBe("working");
    expect(result.agents[0].severity).toBe("info");
  });

  it("classifies a running agent with output >60min ago as 'stuck'", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "running");
    const rootId = await seedPlanRoot(companyId);
    await seedSubtreeIssue(companyId, rootId, agentId);
    const silentSince = new Date(Date.now() - ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS - 5 * 60 * 1000);
    await seedRun(companyId, agentId, {
      status: "running",
      lastOutputAt: silentSince,
    });

    const result = await diagnosePlanHealth(rootId, db);
    expect(result.agents[0].health).toBe("stuck");
    expect(result.agents[0].severity).toBe("warning");
  });

  it("classifies a running agent with output >4hr ago as 'stuck_critical'", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "running");
    const rootId = await seedPlanRoot(companyId);
    await seedSubtreeIssue(companyId, rootId, agentId);
    const silentSince = new Date(Date.now() - ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS - 5 * 60 * 1000);
    await seedRun(companyId, agentId, {
      status: "running",
      lastOutputAt: silentSince,
    });

    const result = await diagnosePlanHealth(rootId, db);
    expect(result.agents[0].health).toBe("stuck_critical");
    expect(result.agents[0].severity).toBe("critical");
  });

  it("classifies a run with livenessState='execution_loop_likely' as 'looping'", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "running");
    const rootId = await seedPlanRoot(companyId);
    await seedSubtreeIssue(companyId, rootId, agentId);
    await seedRun(companyId, agentId, {
      status: "running",
      lastOutputAt: new Date(Date.now() - 5 * 60 * 1000),
      livenessState: "execution_loop_likely",
    });

    const result = await diagnosePlanHealth(rootId, db);
    expect(result.agents[0].health).toBe("looping");
    expect(result.agents[0].severity).toBe("critical");
  });

  it("classifies an active issue with a failed run as 'needs_rewake'", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "idle");
    const rootId = await seedPlanRoot(companyId);
    await seedSubtreeIssue(companyId, rootId, agentId);
    await seedRun(companyId, agentId, { status: "failed" });

    const result = await diagnosePlanHealth(rootId, db);
    expect(result.agents[0].health).toBe("needs_rewake");
    expect(result.agents[0].severity).toBe("warning");
  });

  it("classifies an active issue with a succeeded run as 'needs_rewake'", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "idle");
    const rootId = await seedPlanRoot(companyId);
    await seedSubtreeIssue(companyId, rootId, agentId);
    await seedRun(companyId, agentId, { status: "succeeded" });

    const result = await diagnosePlanHealth(rootId, db);
    expect(result.agents[0].health).toBe("needs_rewake");
  });

  it("classifies an active issue with no run at all as 'needs_rewake'", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "idle");
    const rootId = await seedPlanRoot(companyId);
    await seedSubtreeIssue(companyId, rootId, agentId);
    // No heartbeat run inserted.

    const result = await diagnosePlanHealth(rootId, db);
    expect(result.agents[0].health).toBe("needs_rewake");
  });

  it("classifies a paused agent as 'paused'", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "paused");
    const rootId = await seedPlanRoot(companyId);
    await seedSubtreeIssue(companyId, rootId, agentId);
    await seedRun(companyId, agentId, { status: "running" });

    const result = await diagnosePlanHealth(rootId, db);
    expect(result.agents[0].health).toBe("paused");
  });

  it("classifies a terminated agent as 'paused'", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "terminated");
    const rootId = await seedPlanRoot(companyId);
    await seedSubtreeIssue(companyId, rootId, agentId);

    const result = await diagnosePlanHealth(rootId, db);
    expect(result.agents[0].health).toBe("paused");
  });

  it("excludes issues with no assignee from results", async () => {
    const companyId = await seedCompany();
    const rootId = await seedPlanRoot(companyId);
    // Subtree issue with no assignee.
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "Unassigned",
      planRootIssueId: rootId,
      status: "in_progress",
    });

    const result = await diagnosePlanHealth(rootId, db);
    expect(result.agents).toHaveLength(0);
  });

  it("returns empty agents list when all subtree issues are terminal (done/cancelled)", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "idle");
    const rootId = await seedPlanRoot(companyId);
    await seedSubtreeIssue(companyId, rootId, agentId, "done");

    const result = await diagnosePlanHealth(rootId, db);
    expect(result.agents).toHaveLength(0);
  });

  it("returns empty agents list when there are no subtree issues", async () => {
    const companyId = await seedCompany();
    const rootId = await seedPlanRoot(companyId);

    const result = await diagnosePlanHealth(rootId, db);
    expect(result.agents).toHaveLength(0);
    expect(result.overdue).toBe(false);
  });

  it("returns { planIssueId, overdue: false, agents: [] } when plan row not found", async () => {
    const companyId = await seedCompany();
    const fakeId = randomUUID();

    const result = await diagnosePlanHealth(fakeId, db);
    expect(result).toEqual({ planIssueId: fakeId, overdue: false, agents: [] });
  });

  it("sets overdue=true when estimatedCompletionAt is in the past", async () => {
    const companyId = await seedCompany();
    const pastDate = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
    const rootId = await seedPlanRoot(companyId, { estimatedCompletionAt: pastDate });

    const result = await diagnosePlanHealth(rootId, db);
    expect(result.overdue).toBe(true);
  });

  it("sets overdue=false when estimatedCompletionAt is in the future", async () => {
    const companyId = await seedCompany();
    const futureDate = new Date(Date.now() + 60 * 60 * 1000); // 1 hour ahead
    const rootId = await seedPlanRoot(companyId, { estimatedCompletionAt: futureDate });

    const result = await diagnosePlanHealth(rootId, db);
    expect(result.overdue).toBe(false);
  });

  it("sets overdue=false when no estimatedCompletionAt", async () => {
    const companyId = await seedCompany();
    const rootId = await seedPlanRoot(companyId);

    const result = await diagnosePlanHealth(rootId, db);
    expect(result.overdue).toBe(false);
  });

  it("deduplicates agents — only one entry per agent even if they have multiple active issues", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "running");
    const rootId = await seedPlanRoot(companyId);
    // Two issues assigned to the same agent.
    await seedSubtreeIssue(companyId, rootId, agentId);
    await seedSubtreeIssue(companyId, rootId, agentId);
    await seedRun(companyId, agentId, { status: "running" });

    const result = await diagnosePlanHealth(rootId, db);
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].agentId).toBe(agentId);
  });

  it("classifies queued runs as 'working' (run will start soon)", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "idle");
    const rootId = await seedPlanRoot(companyId);
    await seedSubtreeIssue(companyId, rootId, agentId);
    await seedRun(companyId, agentId, { status: "queued", lastOutputAt: null });

    const result = await diagnosePlanHealth(rootId, db);
    expect(result.agents[0].health).toBe("working");
  });
});
