import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  activityLog,
  budgetPolicies,
  companies,
  companySkills,
  createDb,
  dispatchGateState,
  environmentLeases,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRelations,
  issues,
  projects,
  type Db,
} from "@paperclipai/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// This suite proves that three DISTINCT real production orchestration entry
// points — a normal on-demand heartbeat dispatch, a stranded-issue
// "continuation" requeue, and a stranded-issue "assignment recovery" requeue
// — all reach the *real, unmodified* registered claude_local adapter wrapper
// (registry.ts's claudeExecuteWithGate) and are blocked by it before the
// underlying Claude launch callback ever runs. Only the innermost package
// export that would actually spawn the `claude` CLI is replaced with a spy;
// registry.ts's gate-wrapping, and every layer of heartbeat/recovery
// orchestration above it, is exercised unmodified.
const mockClaudeExecute = vi.hoisted(() => vi.fn());
vi.mock("@paperclipai/adapter-claude-local/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-claude-local/server")>();
  return { ...actual, execute: mockClaudeExecute };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping dispatch gate orchestration proof tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForRunToSettle(
  heartbeat: { getRun: (id: string) => Promise<{ status: string } & Record<string, unknown> | null> },
  runId: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && run.status !== "queued" && run.status !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return heartbeat.getRun(runId);
}

describeEmbeddedPostgres("dispatch gate blocks real orchestration entry points", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let heartbeatService: typeof import("../services/heartbeat.js").heartbeatService;
  let acquireDispatchGate: typeof import("../services/dispatch-gate.js").acquireDispatchGate;
  let releaseDispatchGate: typeof import("../services/dispatch-gate.js").releaseDispatchGate;
  let CLAUDE_LOCAL_DEFAULT_SCOPE: typeof import("../services/dispatch-gate.js").CLAUDE_LOCAL_DEFAULT_SCOPE;
  let setDispatchGateDb: typeof import("../services/dispatch-gate.js").setDispatchGateDb;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dispatch-gate-orchestration-");
    db = createDb(tempDb.connectionString);
    ({ heartbeatService } = await import("../services/heartbeat.js"));
    ({ acquireDispatchGate, releaseDispatchGate, CLAUDE_LOCAL_DEFAULT_SCOPE, setDispatchGateDb } = await import(
      "../services/dispatch-gate.js"
    ));
    setDispatchGateDb(db);
  }, 90_000);

  afterEach(async () => {
    mockClaudeExecute.mockReset();
    await db.delete(dispatchGateState);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(environmentLeases);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    // Re-delete: executeRun's fire-and-forget post-processing (activity log,
    // run events, continuation-summary bookkeeping) can still be landing
    // rows for a moment after the test's own assertions resolve.
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(budgetPolicies);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndClaudeAgent(input: { companyId: string; agentId: string; status?: string }) {
    await db.insert(companies).values({
      id: input.companyId,
      name: "Paperclip",
      issuePrefix: `T${input.companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: input.agentId,
      companyId: input.companyId,
      name: "ClaudeCoder",
      role: "engineer",
      status: input.status ?? "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
  }

  /** Mirrors heartbeat-process-recovery.test.ts's seedStrandedIssueFixture, narrowed to what these two scenarios need. */
  async function seedStrandedIssueFixture(input: {
    companyId: string;
    agentId: string;
    status: "todo" | "in_progress";
  }) {
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2026-03-19T00:00:00.000Z");
    const issuePrefix = `T${input.companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId: input.companyId,
      agentId: input.agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "failed",
      runId,
      claimedAt: now,
      finishedAt: new Date("2026-03-19T00:05:00.000Z"),
      error: "run failed before issue advanced",
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      wakeupRequestId,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      startedAt: now,
      finishedAt: new Date("2026-03-19T00:05:00.000Z"),
      updatedAt: new Date("2026-03-19T00:05:00.000Z"),
      errorCode: "process_lost",
      error: "run failed before issue advanced",
    });

    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: "Recover stranded assigned work",
      status: input.status,
      priority: "medium",
      assigneeAgentId: input.agentId,
      checkoutRunId: input.status === "in_progress" ? runId : null,
      executionRunId: null,
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      startedAt: input.status === "in_progress" ? now : null,
    });

    return { runId, issueId };
  }

  it("blocks a normal on-demand heartbeat dispatch: adapter.execute is never invoked while the gate is held", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await seedCompanyAndClaudeAgent({ companyId, agentId });

    const otherOwner = { kind: "other_surface", id: randomUUID() };
    const acquired = await acquireDispatchGate(CLAUDE_LOCAL_DEFAULT_SCOPE, otherOwner);
    expect(acquired.ok).toBe(true);

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();

    const settled = await waitForRunToSettle(heartbeat, run!.id);
    expect(settled?.status).toBe("failed");
    expect((settled as { errorCode?: string })?.errorCode).toBe("dispatch_gate_ownership_active");
    expect(mockClaudeExecute).not.toHaveBeenCalled();

    await releaseDispatchGate(CLAUDE_LOCAL_DEFAULT_SCOPE, otherOwner);
  });

  it("blocks a stranded-issue continuation requeue (retry): adapter.execute is never invoked while the gate is held", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await seedCompanyAndClaudeAgent({ companyId, agentId });
    const { runId } = await seedStrandedIssueFixture({ companyId, agentId, status: "in_progress" });

    const otherOwner = { kind: "other_surface", id: randomUUID() };
    const acquired = await acquireDispatchGate(CLAUDE_LOCAL_DEFAULT_SCOPE, otherOwner);
    expect(acquired.ok).toBe(true);

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.continuationRequeued).toBe(1);

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    const retryRun = runs.find((row) => row.id !== runId);
    expect(retryRun).toBeTruthy();
    const settled = await waitForRunToSettle(heartbeat, retryRun!.id);
    expect(settled?.status).toBe("failed");
    expect((settled as { errorCode?: string })?.errorCode).toBe("dispatch_gate_ownership_active");
    expect(mockClaudeExecute).not.toHaveBeenCalled();

    await releaseDispatchGate(CLAUDE_LOCAL_DEFAULT_SCOPE, otherOwner);
  });

  it("blocks a stranded-issue assignment recovery requeue: adapter.execute is never invoked while the gate is held", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await seedCompanyAndClaudeAgent({ companyId, agentId });
    const { runId } = await seedStrandedIssueFixture({ companyId, agentId, status: "todo" });

    const otherOwner = { kind: "other_surface", id: randomUUID() };
    const acquired = await acquireDispatchGate(CLAUDE_LOCAL_DEFAULT_SCOPE, otherOwner);
    expect(acquired.ok).toBe(true);

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(1);

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    const retryRun = runs.find((row) => row.id !== runId);
    expect(retryRun).toBeTruthy();
    const settled = await waitForRunToSettle(heartbeat, retryRun!.id);
    expect(settled?.status).toBe("failed");
    expect((settled as { errorCode?: string })?.errorCode).toBe("dispatch_gate_ownership_active");
    expect(mockClaudeExecute).not.toHaveBeenCalled();

    await releaseDispatchGate(CLAUDE_LOCAL_DEFAULT_SCOPE, otherOwner);
  });
});
