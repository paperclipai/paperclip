import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentManagerEvaluations,
  agents,
  agentWakeupRequests,
  companies,
  companyAgentManagerSettings,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
  issueSupervisionState,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { agentManagerService } from "./service.js";
import type { JudgeInvoker } from "./types.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent manager integration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent manager integration", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  const wakeups: Array<{ agentId: string; reason?: string | null; contextSnapshot?: Record<string, unknown> }> = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-manager-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    wakeups.length = 0;
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 30_000);

  async function seedScenario() {
    const companyId = randomUUID();
    const supervisorId = randomUUID();
    const coderId = randomUUID();
    const cosId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const prefix = `AM${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Agent Manager Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: cosId,
        companyId,
        name: "Chief of Staff",
        role: "ceo",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: supervisorId,
        companyId,
        name: "Agent Manager",
        role: "manager",
        status: "idle",
        reportsTo: cosId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: coderId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "idle",
        reportsTo: supervisorId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Implement feature",
      description: "Deliver API + tests",
      status: "in_progress",
      priority: "high",
      workMode: "standard",
      assigneeAgentId: coderId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      status: "succeeded",
      contextSnapshot: { issueId },
      resultJson: { summary: "Implemented partial API without tests" },
    });
    await db.insert(companyAgentManagerSettings).values({
      companyId,
      enabled: true,
      supervisorAgentId: supervisorId,
      escalationAgentId: cosId,
      scoreThreshold: 70,
      maxReflectionAttempts: 3,
    });

    return { companyId, supervisorId, coderId, cosId, issueId, runId, prefix };
  }

  function createService(invokeJudge: JudgeInvoker) {
    return agentManagerService(db, {
      enqueueWakeup: async (agentId, opts) => {
        wakeups.push({
          agentId,
          reason: opts?.reason ?? null,
          contextSnapshot: opts?.contextSnapshot,
        });
        await db.insert(agentWakeupRequests).values({
          companyId: (await db.select({ companyId: agents.companyId }).from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]?.companyId))!,
          agentId,
          source: opts?.source ?? "automation",
          status: "queued",
          reason: opts?.reason ?? null,
          payload: opts?.payload ?? opts?.contextSnapshot ?? {},
          idempotencyKey: opts?.idempotencyKey ?? randomUUID(),
        });
        return null;
      },
      invokeJudge,
    });
  }

  it("happy path: passing score logs evaluate activity only", async () => {
    const seeded = await seedScenario();
    const svc = createService(async () => ({
      result: {
        score: 85,
        rationale: "Meets acceptance criteria",
        criteriaResults: [],
        corrections: [],
        hardFailure: false,
      },
      judgeModel: "cheap",
      latencyMs: 12,
    }));

    await svc.onRunTerminalForEvaluation({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      runId: seeded.runId,
      agentId: seeded.coderId,
      runStatus: "succeeded",
      livenessState: null,
      trigger: "run_succeeded",
    });

    const evaluations = await db.select().from(agentManagerEvaluations).where(eq(agentManagerEvaluations.runId, seeded.runId));
    expect(evaluations).toHaveLength(1);
    expect(evaluations[0]?.outcome).toBe("pass");

    const activities = await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, seeded.companyId),
      eq(activityLog.action, "agent_manager.evaluate"),
    ));
    expect(activities).toHaveLength(1);
    expect(wakeups).toHaveLength(0);
  });

  it("reflect path posts comment and wakes assignee", async () => {
    const seeded = await seedScenario();
    const svc = createService(async () => ({
      result: {
        score: 55,
        rationale: "Missing tests",
        criteriaResults: [{ id: "AC-1", met: false, note: "no tests" }],
        corrections: [{ priority: "must", instruction: "Add tests" }],
        hardFailure: false,
      },
      judgeModel: "cheap",
      latencyMs: 10,
    }));

    await svc.onRunTerminalForEvaluation({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      runId: seeded.runId,
      agentId: seeded.coderId,
      runStatus: "succeeded",
      livenessState: null,
      trigger: "run_succeeded",
    });

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId));
    expect(comments.some((row) => row.body.includes("Agent Manager reflection"))).toBe(true);
    expect(wakeups.some((row) => row.agentId === seeded.coderId && row.reason === "agent_manager_reflection")).toBe(true);

    const supervision = await db.select().from(issueSupervisionState).where(eq(issueSupervisionState.issueId, seeded.issueId));
    expect(supervision[0]?.reflectionAttemptCount).toBe(1);
  });

  it("exhaustion escalates to chief of staff", async () => {
    const seeded = await seedScenario();
    await db.insert(issueSupervisionState).values({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      reflectionAttemptCount: 3,
    });

    const svc = createService(async () => ({
      result: {
        score: 40,
        rationale: "Still off spec",
        criteriaResults: [],
        corrections: [{ priority: "must", instruction: "Rewrite module" }],
        hardFailure: false,
      },
      judgeModel: "cheap",
      latencyMs: 8,
    }));

    await svc.onRunTerminalForEvaluation({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      runId: seeded.runId,
      agentId: seeded.coderId,
      runStatus: "succeeded",
      livenessState: null,
      trigger: "run_succeeded",
    });

    const issue = await db.select().from(issues).where(eq(issues.id, seeded.issueId)).then((rows) => rows[0]);
    expect(issue?.status).toBe("blocked");
    expect(wakeups.some((row) => row.agentId === seeded.cosId && row.reason === "agent_manager_escalation")).toBe(true);
  });

  it("skips when active recovery owns the issue", async () => {
    const seeded = await seedScenario();
    await db.insert(issueRecoveryActions).values({
      companyId: seeded.companyId,
      sourceIssueId: seeded.issueId,
      kind: "stale_active_run",
      status: "active",
      cause: "output_silence",
      fingerprint: "recovery:test",
      nextAction: "wait",
      evidence: {},
    });

    const invokeJudge = vi.fn();
    const svc = createService(invokeJudge);
    await svc.onRunTerminalForEvaluation({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      runId: seeded.runId,
      agentId: seeded.coderId,
      runStatus: "succeeded",
      livenessState: null,
      trigger: "run_succeeded",
    });

    expect(invokeJudge).not.toHaveBeenCalled();
  });

  it("is idempotent per run", async () => {
    const seeded = await seedScenario();
    const svc = createService(async () => ({
      result: {
        score: 85,
        rationale: "ok",
        criteriaResults: [],
        corrections: [],
        hardFailure: false,
      },
      judgeModel: "cheap",
      latencyMs: 5,
    }));

    const event = {
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      runId: seeded.runId,
      agentId: seeded.coderId,
      runStatus: "succeeded" as const,
      livenessState: null,
      trigger: "run_succeeded" as const,
    };

    await svc.onRunTerminalForEvaluation(event);
    await svc.onRunTerminalForEvaluation(event);

    const evaluations = await db.select().from(agentManagerEvaluations).where(eq(agentManagerEvaluations.runId, seeded.runId));
    expect(evaluations).toHaveLength(1);
  });
});
