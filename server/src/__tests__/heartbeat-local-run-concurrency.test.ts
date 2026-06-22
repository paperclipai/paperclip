import { randomUUID } from "node:crypto";
import { and, eq, getTableName, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companySkills,
  companies,
  createDb,
  documentRevisions,
  documents,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueRelations,
  issueTreeHolds,
  issues,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";
import type { LocalRunCaps } from "../services/local-run-concurrency.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Local-run concurrency test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres local-run concurrency tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const LOCAL_MODEL_PROVIDERS = ["dev"];

// Every table the suite seeds or that a run touches. TRUNCATE ... CASCADE in
// afterEach clears them all without caring about FK order.
const TEARDOWN_TABLES = [
  environmentLeases,
  activityLog,
  companySkills,
  issueComments,
  issueDocuments,
  documentRevisions,
  documents,
  issueRelations,
  issueTreeHolds,
  issues,
  heartbeatRunEvents,
  heartbeatRuns,
  agentWakeupRequests,
  agentRuntimeState,
  agents,
  environments,
  workspaceOperations,
  executionWorkspaces,
  companies,
];

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return fn();
}

describeEmbeddedPostgres("heartbeat global local-run concurrency cap", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  function useHeartbeat(caps: Partial<LocalRunCaps>): ReturnType<typeof heartbeatService> {
    const localRunCaps: LocalRunCaps = {
      maxConcurrentRuns: caps.maxConcurrentRuns ?? 2,
      maxDistinctModels: caps.maxDistinctModels ?? 2,
      localModelProviders: caps.localModelProviders ?? LOCAL_MODEL_PROVIDERS,
    };
    heartbeat = heartbeatService(db, { localRunCaps });
    return heartbeat;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-local-run-cap-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Local-run concurrency test run.",
      provider: "test",
      model: "test-model",
    }));
    // A successful mock run makes no "concrete progress" on its issue, so the
    // heartbeat keeps enqueuing continuation wakes -> an endless run loop that
    // never lets the suite go idle. Terminating every agent makes them
    // non-invokable: pending continuation wakes are cancelled instead of
    // executed, so the loop drains and teardown can complete.
    await db.update(agents).set({ status: "terminated" });
    runningProcesses.clear();
    let idlePolls = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      const hasActiveRun = runs.some((run) => run.status === "queued" || run.status === "running");
      if (!hasActiveRun) {
        idlePolls += 1;
        if (idlePolls >= 3) break;
      } else {
        idlePolls = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // Let late, fire-and-forget run post-processing (issue comments, company
    // skills sync, activity log writes) drain before teardown.
    await new Promise((resolve) => setTimeout(resolve, 100));
    // TRUNCATE ... CASCADE wipes every seeded table in one statement regardless
    // of FK ordering, which is immune to a stray late write racing an
    // ordered-delete pass. Any write that lands after this references a removed
    // parent and fails harmlessly in its swallowed catch; the next test seeds a
    // fresh company and only queries its own ids, so leftovers cannot leak in.
    const tableList = TEARDOWN_TABLES.map((table) => `"${getTableName(table)}"`).join(", ");
    await db.execute(sql.raw(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 60_000);

  async function seedCompany(): Promise<string> {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedLocalAgent(
    companyId: string,
    options: { model: string; name: string; adapterType?: string },
  ): Promise<string> {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: options.name,
      role: "engineer",
      status: "active",
      adapterType: options.adapterType ?? "opencode_local",
      adapterConfig: { model: options.model },
      // Per-agent budget is generous so the GLOBAL cap is the binding limit.
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 5 } },
      permissions: {},
    });
    return agentId;
  }

  async function wakeAgentOnIssue(companyId: string, agentId: string, title: string) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title,
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });
    const run = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });
    expect(run).not.toBeNull();
    return run!;
  }

  async function runStatus(runId: string): Promise<string | null> {
    const row = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    return row?.status ?? null;
  }

  async function runningLocalModels(companyId: string): Promise<string[]> {
    const rows = await db
      .select({ adapterConfig: agents.adapterConfig })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .where(and(eq(agents.companyId, companyId), eq(heartbeatRuns.status, "running")));
    return rows
      .map((row) => (row.adapterConfig as Record<string, unknown> | null)?.model)
      .filter((model): model is string => typeof model === "string");
  }

  // Mark the executing run's OWN issue done so the completed run is classified
  // as "completed" (see run-liveness.ts) instead of "empty_response". A mock run
  // produces no real output, so without this the heartbeat keeps enqueuing
  // continuation wakes forever and the suite never goes idle. Scoping to the
  // run's own issue (via the execute context) avoids marking a not-yet-started
  // agent's issue done, which would block its checkout.
  async function completeRunIssue(executeArgs: unknown): Promise<void> {
    const context = (executeArgs as { context?: { issueId?: unknown } } | undefined)?.context;
    const issueId = typeof context?.issueId === "string" ? context.issueId : null;
    if (issueId) {
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
    }
  }

  it("caps concurrent local chats at the global limit and queues the rest", async () => {
    // Concurrency cap = 2, model ceiling high so only concurrency can bind.
    useHeartbeat({ maxConcurrentRuns: 2, maxDistinctModels: 5 });
    const companyId = await seedCompany();
    // Same model -> isolate the concurrency cap from the model ceiling.
    const model = "dev/shared-model:7b";
    const agentA = await seedLocalAgent(companyId, { model, name: "Local A" });
    const agentB = await seedLocalAgent(companyId, { model, name: "Local B" });
    const agentC = await seedLocalAgent(companyId, { model, name: "Local C" });

    let releaseRuns!: () => void;
    const runsCanFinish = new Promise<void>((resolve) => {
      releaseRuns = resolve;
    });
    mockAdapterExecute.mockImplementation(async (executeArgs: unknown) => {
      await runsCanFinish;
      await completeRunIssue(executeArgs);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Local chat finished.",
        provider: "test",
        model,
      };
    });

    try {
      const runA = await wakeAgentOnIssue(companyId, agentA, "A");
      expect(await waitForCondition(async () => (await runStatus(runA.id)) === "running")).toBe(true);
      const runB = await wakeAgentOnIssue(companyId, agentB, "B");
      expect(await waitForCondition(async () => (await runStatus(runB.id)) === "running")).toBe(true);

      // Third local chat must stay queued: the global concurrency cap is 2.
      const runC = await wakeAgentOnIssue(companyId, agentC, "C");
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await runStatus(runC.id)).toBe("queued");

      const runningRows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(heartbeatRuns)
        .where(and(inArray(heartbeatRuns.agentId, [agentA, agentB, agentC]), eq(heartbeatRuns.status, "running")))
        .then((rows) => rows[0]?.count ?? 0);
      expect(runningRows).toBe(2);

      // Releasing the running chats frees slots; the queued chat then runs.
      releaseRuns();
      expect(await waitForCondition(async () => (await runStatus(runC.id)) === "succeeded", 10_000)).toBe(true);
    } finally {
      releaseRuns();
    }
  }, 40_000);

  it("caps distinct loaded local models at the ceiling", async () => {
    // Model ceiling = 2, concurrency cap high so only the model ceiling can bind
    // (a third distinct model stays queued even though a run slot is free).
    useHeartbeat({ maxConcurrentRuns: 5, maxDistinctModels: 2 });
    const companyId = await seedCompany();
    const agentA = await seedLocalAgent(companyId, { model: "dev/model-a:7b", name: "Model A" });
    const agentB = await seedLocalAgent(companyId, { model: "dev/model-b:7b", name: "Model B" });
    const agentC = await seedLocalAgent(companyId, { model: "dev/model-c:7b", name: "Model C" });

    let releaseRuns!: () => void;
    const runsCanFinish = new Promise<void>((resolve) => {
      releaseRuns = resolve;
    });
    mockAdapterExecute.mockImplementation(async (executeArgs: unknown) => {
      await runsCanFinish;
      await completeRunIssue(executeArgs);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Local chat finished.",
        provider: "test",
        model: "dev/model",
      };
    });

    try {
      const runA = await wakeAgentOnIssue(companyId, agentA, "A");
      expect(await waitForCondition(async () => (await runStatus(runA.id)) === "running")).toBe(true);
      const runB = await wakeAgentOnIssue(companyId, agentB, "B");
      expect(await waitForCondition(async () => (await runStatus(runB.id)) === "running")).toBe(true);

      // A third DISTINCT model would exceed the ceiling of 2 -> stays queued,
      // even though a concurrency slot is free (cap is 5). This isolates the
      // distinct-model ceiling from the concurrency cap.
      const runC = await wakeAgentOnIssue(companyId, agentC, "C");
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await runStatus(runC.id)).toBe("queued");

      const models = await runningLocalModels(companyId);
      const distinct = new Set(models);
      expect(distinct.size).toBeLessThanOrEqual(2);
      expect(distinct.has("dev/model-a:7b")).toBe(true);
      expect(distinct.has("dev/model-b:7b")).toBe(true);

      releaseRuns();
      expect(await waitForCondition(async () => (await runStatus(runC.id)) === "succeeded", 10_000)).toBe(true);
    } finally {
      releaseRuns();
    }
  }, 40_000);

  it("exempts cloud-backed opencode_local agents from the local cap", async () => {
    // Local cap fully saturated by a single local run; the cloud-backed
    // opencode_local agent must still run because it is exempt.
    useHeartbeat({ maxConcurrentRuns: 1, maxDistinctModels: 2 });
    const companyId = await seedCompany();
    const localAgent = await seedLocalAgent(companyId, { model: "dev/model-a:7b", name: "Local" });
    const cloudAgent = await seedLocalAgent(companyId, {
      model: "github-copilot/claude-opus-4.8-fast",
      name: "Cloud",
    });

    let releaseRuns!: () => void;
    const runsCanFinish = new Promise<void>((resolve) => {
      releaseRuns = resolve;
    });
    mockAdapterExecute.mockImplementation(async (executeArgs: unknown) => {
      await runsCanFinish;
      await completeRunIssue(executeArgs);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Chat finished.",
        provider: "test",
        model: "test-model",
      };
    });

    try {
      // Saturate the local cap entirely (maxConcurrentRuns is 1): the single
      // local run takes the only local slot. The cloud-backed agent must not be
      // counted against that budget, so it can still start.
      const runLocal = await wakeAgentOnIssue(companyId, localAgent, "Local work");
      expect(await waitForCondition(async () => (await runStatus(runLocal.id)) === "running")).toBe(true);

      const runCloud = await wakeAgentOnIssue(companyId, cloudAgent, "Cloud work");
      // The cloud-backed opencode_local agent is exempt and runs immediately.
      expect(await waitForCondition(async () => (await runStatus(runCloud.id)) === "running")).toBe(true);

      releaseRuns();
      expect(await waitForCondition(async () => (await runStatus(runLocal.id)) === "succeeded", 10_000)).toBe(true);
      expect(await waitForCondition(async () => (await runStatus(runCloud.id)) === "succeeded", 10_000)).toBe(true);
    } finally {
      releaseRuns();
    }
  }, 40_000);
});
