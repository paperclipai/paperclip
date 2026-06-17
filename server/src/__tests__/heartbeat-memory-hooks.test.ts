import { randomUUID } from "node:crypto";
import { eq, inArray, or } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  costEvents,
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
  issueRecoveryActions,
  issueRelations,
  issueThreadInteractions,
  issues,
  projectWorkspaces,
  projects,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentFirstHeartbeat = vi.hoisted(() => vi.fn());
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Completed the memory hook regression run.",
    provider: "test",
    model: "test-model",
  })),
);
const mockHydrateForRun = vi.hoisted(() => vi.fn(async () => null as string | null));
const mockCaptureRunCompletion = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: mockTrackAgentFirstHeartbeat,
  };
});

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

vi.mock("../services/memory/index.ts", () => ({
  memoryService: vi.fn(() => ({
    hydrateForRun: mockHydrateForRun,
    captureRunCompletion: mockCaptureRunCompletion,
  })),
}));

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat memory hook tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type AdapterExecuteInput = { runId: string; context: Record<string, unknown> };
type CaptureInput = {
  run: { id: string; companyId: string };
  agent: { id: string; name: string };
  issueRef: { id: string } | null;
  outcome: string;
  status: string;
  resultJson: Record<string, unknown> | null;
};
type HydrateInput = {
  companyId: string;
  agentId: string;
  runId: string;
  issue: { id?: string | null; identifier?: string | null; title?: string | null } | null;
  wakeReason: string | null;
  wakeCommentBody: string | null;
};

function findAdapterExecuteInput(runId: string): AdapterExecuteInput | null {
  return (
    (mockAdapterExecute.mock.calls as unknown as [AdapterExecuteInput][])
      .map((call) => call[0])
      .find((input) => input.runId === runId) ?? null
  );
}

function findHydrateInput(runId: string): HydrateInput | null {
  return (
    (mockHydrateForRun.mock.calls as unknown as [HydrateInput][])
      .map((call) => call[0])
      .find((input) => input.runId === runId) ?? null
  );
}

function findCaptureInputs(runId: string): CaptureInput[] {
  return (mockCaptureRunCompletion.mock.calls as unknown as [CaptureInput][])
    .map((call) => call[0])
    .filter((input) => input.run.id === runId);
}

async function waitForRunToSettle(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (!run || (run.status !== "queued" && run.status !== "running")) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return heartbeat.getRun(runId);
}

async function waitForCondition(read: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (read()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return read();
}

async function cancelActiveRunsForCleanup(
  db: ReturnType<typeof createDb>,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const activeRuns = await db
      .select({
        id: heartbeatRuns.id,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
      })
      .from(heartbeatRuns)
      .where(
        or(
          eq(heartbeatRuns.status, "queued"),
          eq(heartbeatRuns.status, "running"),
          eq(heartbeatRuns.status, "scheduled_retry"),
        ),
      );
    const pendingWakeups = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(
        inArray(agentWakeupRequests.status, ["queued", "claimed", "deferred_issue_execution"]),
      );

    if (activeRuns.length === 0 && pendingWakeups.length === 0) return;

    const now = new Date();
    if (activeRuns.length > 0) {
      await db
        .update(heartbeatRuns)
        .set({
          status: "cancelled",
          finishedAt: now,
          updatedAt: now,
          errorCode: "test_cleanup",
          error: "Cancelled by heartbeat-memory-hooks test cleanup",
        })
        .where(inArray(heartbeatRuns.id, activeRuns.map((run) => run.id)));
    }
    const wakeupRequestIds = [
      ...activeRuns
        .map((run) => run.wakeupRequestId)
        .filter((value): value is string => typeof value === "string" && value.length > 0),
      ...pendingWakeups.map((wakeup) => wakeup.id),
    ];
    if (wakeupRequestIds.length > 0) {
      await db
        .update(agentWakeupRequests)
        .set({
          status: "cancelled",
          finishedAt: now,
          error: "Cancelled by heartbeat-memory-hooks test cleanup",
        })
        .where(inArray(agentWakeupRequests.id, wakeupRequestIds));
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describeEmbeddedPostgres("heartbeat memory hooks", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-memory-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await cancelActiveRunsForCleanup(db, 5_000);
    await new Promise((resolve) => setTimeout(resolve, 100));

    vi.clearAllMocks();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Completed the memory hook regression run.",
      provider: "test",
      model: "test-model",
    }));
    mockHydrateForRun.mockImplementation(async () => null);
    mockCaptureRunCompletion.mockImplementation(async () => {});

    await db.delete(activityLog);
    await db.delete(costEvents);
    await db.delete(workspaceOperations);
    await db.delete(environmentLeases);
    await db.delete(environments);
    await db.delete(issueThreadInteractions);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueRelations);
    await db.delete(issueRecoveryActions);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(issueComments);
      await db.delete(issueDocuments);
      try {
        await db.delete(issues);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(activityLog);
      await db.delete(heartbeatRunEvents);
      try {
        await db.delete(heartbeatRuns);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    await db.delete(agentWakeupRequests);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(agentRuntimeState);
      try {
        await db.delete(agents);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(workspaceOperations);
      await db.delete(executionWorkspaces);
      await db.delete(projectWorkspaces);
      await db.delete(projects);
      await db.delete(issueDocuments);
      await db.delete(documentRevisions);
      await db.delete(documents);
      await db.delete(companySkills);
      try {
        await db.delete(companies);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedQueuedIssueRunFixture(input?: {
    contextSnapshot?: Record<string, unknown>;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2026-03-19T00:00:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "queued",
      runId,
      requestedAt: now,
      updatedAt: now,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_assigned",
        ...(input?.contextSnapshot ?? {}),
      },
      updatedAt: now,
      createdAt: now,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Exercise the heartbeat memory hooks",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      startedAt: now,
    });

    return { companyId, agentId, runId, wakeupRequestId, issueId, issuePrefix };
  }

  it("sets paperclipMemoryMarkdown on the adapter context and captures the succeeded outcome", async () => {
    const memoryMarkdown =
      "## Remembered context (advisory)\n- [paperclip/test/runs/prior] (0.91) — prior run insight";
    mockHydrateForRun.mockResolvedValue(memoryMarkdown);

    const { companyId, agentId, runId, issueId, issuePrefix } = await seedQueuedIssueRunFixture();
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();
    const run = await waitForRunToSettle(heartbeat, runId);
    expect(run?.status).toBe("succeeded");

    const hydrateInput = findHydrateInput(runId);
    expect(hydrateInput).not.toBeNull();
    expect(hydrateInput).toMatchObject({
      companyId,
      agentId,
      runId,
      wakeReason: "issue_assigned",
      wakeCommentBody: null,
      issue: {
        id: issueId,
        identifier: `${issuePrefix}-1`,
        title: "Exercise the heartbeat memory hooks",
      },
    });

    const executeInput = findAdapterExecuteInput(runId);
    expect(executeInput).not.toBeNull();
    expect(executeInput?.context.paperclipMemoryMarkdown).toBe(memoryMarkdown);

    await waitForCondition(() => findCaptureInputs(runId).length > 0);
    const captureInputs = findCaptureInputs(runId);
    expect(captureInputs).toHaveLength(1);
    const captureInput = captureInputs[0]!;
    expect(captureInput.run.companyId).toBe(companyId);
    expect(captureInput.agent).toEqual({ id: agentId, name: "CodexCoder" });
    expect(captureInput.issueRef?.id).toBe(issueId);
    expect(captureInput.outcome).toBe("succeeded");
    expect(captureInput.status).toBe("succeeded");
    expect(captureInput.resultJson).toMatchObject({
      summary: "Completed the memory hook regression run.",
    });
  });

  it("deletes stale paperclipMemoryMarkdown from the context when hydrate returns nothing", async () => {
    mockHydrateForRun.mockResolvedValue(null);

    const { runId } = await seedQueuedIssueRunFixture({
      contextSnapshot: {
        paperclipMemoryMarkdown: "## Remembered context (advisory)\n- stale snapshot leftover",
      },
    });
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();
    const run = await waitForRunToSettle(heartbeat, runId);
    expect(run?.status).toBe("succeeded");

    expect(findHydrateInput(runId)).not.toBeNull();
    const executeInput = findAdapterExecuteInput(runId);
    expect(executeInput).not.toBeNull();
    expect(executeInput?.context).not.toHaveProperty("paperclipMemoryMarkdown");
  });

  it("captures failed terminal outcomes and finalizes the run even when memory hooks reject", async () => {
    mockHydrateForRun.mockRejectedValue(new Error("hydrate exploded"));
    mockCaptureRunCompletion.mockRejectedValue(new Error("capture exploded"));
    mockAdapterExecute.mockResolvedValueOnce({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "adapter run failed",
      summary: null,
      provider: "test",
      model: "test-model",
    } as never);

    const { runId } = await seedQueuedIssueRunFixture();
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();
    const run = await waitForRunToSettle(heartbeat, runId);
    expect(run?.status).toBe("failed");

    const executeInput = findAdapterExecuteInput(runId);
    expect(executeInput).not.toBeNull();
    expect(executeInput?.context).not.toHaveProperty("paperclipMemoryMarkdown");

    await waitForCondition(() => findCaptureInputs(runId).length > 0);
    const captureInputs = findCaptureInputs(runId);
    expect(captureInputs).toHaveLength(1);
    expect(captureInputs[0]!.outcome).toBe("failed");
    expect(captureInputs[0]!.status).toBe("failed");

    const persisted = await heartbeat.getRun(runId);
    expect(persisted?.status).toBe("failed");
    expect(persisted?.finishedAt).not.toBeNull();
  });
});
