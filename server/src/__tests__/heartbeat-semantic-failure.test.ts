import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  agents,
  agentWakeupRequests,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
  issueThreadInteractions,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn<() => Promise<AdapterExecutionResult>>(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Heartbeat semantic-failure integration test.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: vi.fn(),
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

import { runningProcesses } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function waitForTerminalRun(db: ReturnType<typeof createDb>, runId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    if (run && run.status !== "queued" && run.status !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return db
    .select()
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId))
    .then((rows) => rows[0] ?? null);
}

describeEmbeddedPostgres("heartbeat semantic failure service boundary", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-semantic-failure-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 30_000);

  beforeEach(() => {
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Follow-up adapter execution.",
      provider: "test",
      model: "test-model",
    });
  });

  afterEach(async () => {
    await heartbeat.drainActiveRunExecutions();
    runningProcesses.clear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 60_000);

  async function seedAssignedIssue(input?: {
    runtimeConfig?: Record<string, unknown>;
    status?: "todo" | "in_progress";
  }) {
    const companyId = randomUUID();
    const ownerUserId = `owner-${randomUUID()}`;
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      defaultResponsibleUserId: ownerUserId,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: ownerUserId,
      membershipRole: "owner",
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: { model: "primary-model" },
      runtimeConfig: input?.runtimeConfig ?? {
        heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 },
      },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Assigned semantic failure",
      status: input?.status ?? "todo",
      priority: "critical",
      assigneeAgentId: agentId,
      responsibleUserId: ownerUserId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentId, issueId };
  }

  it("persists the canonical semantic failure and creates no recovery, wake, or interaction", async () => {
    const { companyId, agentId, issueId } = await seedAssignedIssue();
    mockAdapterExecute.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      errorCode: "provider_quota",
      errorFamily: "provider_quota",
      retryNotBefore: new Date(Date.now() + 60_000).toISOString(),
      resultJson: {
        status: " ERROR ",
        message: "The adapter returned a semantic error.",
      },
      summary: "Semantic error payload.",
      provider: "test",
      model: "test-model",
    });

    const sourceRun = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      requestedByActorType: "system",
      requestedByActorId: "assignment",
      payload: { issueId },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
    });
    expect(sourceRun).not.toBeNull();

    const completed = await waitForTerminalRun(db, sourceRun!.id);
    await heartbeat.drainActiveRunExecutions();

    expect(completed).toMatchObject({
      status: "failed",
      errorCode: "adapter_result_error",
    });
    expect(completed?.resultJson).not.toHaveProperty("errorFamily");
    expect(completed?.resultJson).not.toHaveProperty("retryNotBefore");
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);

    const [runs, wakeups, comments, recoveryActions, interactions, assignedIssue] = await Promise.all([
      db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)),
      db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId)),
      db.select().from(issueComments).where(eq(issueComments.companyId, companyId)),
      db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, companyId)),
      db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.companyId, companyId)),
      db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null),
    ]);

    expect(runs).toHaveLength(1);
    expect(wakeups).toHaveLength(1);
    expect(comments).toHaveLength(0);
    expect(recoveryActions).toHaveLength(0);
    expect(interactions).toHaveLength(0);
    expect(assignedIssue).toMatchObject({
      status: "in_progress",
      executionRunId: null,
    });
  });

  it("fails a disabled requested profile before invoking the primary adapter", async () => {
    const { agentId, issueId } = await seedAssignedIssue({
      status: "in_progress",
      runtimeConfig: {
        heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 },
        modelProfiles: {
          cheap: {
            enabled: false,
            adapterConfig: { model: "disabled-cheap-model" },
          },
        },
      },
    });

    const sourceRun = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_continuation_needed",
      requestedByActorType: "system",
      requestedByActorId: "heartbeat",
      payload: { issueId, modelProfile: "cheap" },
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_continuation_needed",
        recoveryIntent: "status_only",
        modelProfile: "cheap",
        allowDeliverableWork: false,
      },
    });
    expect(sourceRun).not.toBeNull();

    const completed = await waitForTerminalRun(db, sourceRun!.id);
    await heartbeat.drainActiveRunExecutions();

    expect(completed).toMatchObject({
      status: "failed",
      errorCode: "configuration_incomplete",
      resultJson: expect.objectContaining({
        configurationIncomplete: expect.objectContaining({
          reason: "requested_model_profile_unavailable",
          requestedModelProfile: "cheap",
          fallbackReason: "agent_runtime_profile_disabled",
        }),
      }),
    });
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });
});
