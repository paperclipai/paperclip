import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  completionContracts,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
  nativeRunFinalizations,
} from "@paperclipai/db";
import type { NativeExecutionInputV1 } from "@paperclipai/paperclip-runner";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";

const provider = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../vendor/paperclip-runner/index.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../vendor/paperclip-runner/index.js")
  >()),
  executeNativeSession: provider.execute,
}));

import { executePaperclipNativeSession } from "./native-session-executor.js";
import { buildNativeCompletionContract } from "./completion-contracts.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";
import { claimNativeSessionResumptions } from "./native-finalization-reconciler.js";

type SessionOpenStatus = "failed" | "rejected" | "indeterminate";

/** Mirrors the runner's failed-command error: provider detail stays off the message. */
function sessionOpenFailure(options: {
  status?: SessionOpenStatus;
  providerFailure?: Record<string, unknown>;
} = {}) {
  const status = options.status ?? "failed";
  const result = {
    result: {
      code: "command_execution_failed",
      message: options.providerFailure
        ? "Provider request failed"
        : "failed to start ACPX provider: ACPX sidecar command session.open was rejected (retryable=false, classification=session_ensure_failed)",
      ...(options.providerFailure ? { providerFailure: options.providerFailure } : {}),
    },
    status,
  };
  const error = new Error(
    `PRP command session.open ${status}: ${JSON.stringify(result, (key, value) =>
      key === "providerFailure" ? undefined : value)}`,
  );
  Object.defineProperty(error, "runnerCommandResult", {
    value: structuredClone(result),
    enumerable: false,
  });
  return error;
}

function limitFailure(overrides: Record<string, unknown> = {}) {
  return {
    schema: "paperclip.provider-failure.v1",
    provider: "anthropic",
    phase: "turn",
    category: "rate_limit",
    message: "Usage limit reached for this account.",
    retryability: "unknown",
    ...overrides,
  };
}

const backoffWindow = (from: Date, attempt: number) => {
  const base = 30_000 * 2 ** (attempt - 1);
  return [from.getTime() + base * 0.8, from.getTime() + base * 1.2] as const;
};

describe("native provider startup retry", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-startup-retry-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({
      id: companyId,
      name: "Native startup retry",
      issuePrefix: "NSR",
    });
  });

  afterAll(async () => {
    await temporary?.cleanup();
  });

  async function createAgent() {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Startup agent ${agentId.slice(0, 8)}`,
      status: "active",
      adapterType: "paperclip_runner",
      adapterConfig: { provider: "acpx", agent: "claude" },
    });
    return agentId;
  }

  async function seedRun(agentId: string) {
    const issueId = randomUUID();
    const runId = randomUUID();
    const [issue] = await db
      .insert(issues)
      .values({
        id: issueId,
        companyId,
        title: "Start work after a provider startup failure",
        status: "in_progress",
        workMode: "standard",
        assigneeAgentId: agentId,
      })
      .returning();
    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        id: runId,
        companyId,
        agentId,
        status: "running",
        runtimeMode: "native",
        nativeIssueId: issueId,
        invocationSource: "assignment",
        triggerDetail: "system",
        startedAt: new Date(),
        contextSnapshot: { issueId },
      })
      .returning();
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const native = await prepareNativeHeartbeatRun({
      db,
      run,
      issue,
      environmentLeaseId: randomUUID(),
    });
    const [contract] = await db
      .select()
      .from(completionContracts)
      .where(eq(completionContracts.issueId, issueId));
    const execution: NativeExecutionInputV1 = {
      schema: "paperclip.native-execution-input.v1",
      binding: { companyId, runId, issueId, agentId, executionWorkspaceId: runId },
      provider: { kind: "codex", model: "gpt-5.6-luna" },
      task: {
        identifier: issueId,
        title: issue.title,
        description: null,
        prompt: "Continue the task.",
        workMode: "standard",
      },
      workspace: { cwd: "/tmp", repoUrl: null, repoRef: null, branchName: null },
      session: {
        normalizedSessionId: native.normalizedSessionId,
        driverKind: "codex_app_server",
        protocolVersion: 1,
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
      },
      completionContract: {
        id: contract.id,
        sha256: contract.canonicalSha256,
        schemaVersion: "paperclip.completion-contract.v1",
        contract: buildNativeCompletionContract(issue, { revision: contract.revision }),
      },
      interactionResponses: [],
      credentialBindings: [],
    };
    // Dispatch persists this envelope before execution; same-run recovery needs it.
    await db
      .update(heartbeatRuns)
      .set({
        runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb)
          || ${JSON.stringify({ nativeExecutionInput: execution })}::jsonb`,
      })
      .where(eq(heartbeatRuns.id, runId));
    await db.insert(nativeRunFinalizations).values({
      runId,
      companyId,
      issueId,
      phase: "observed",
    });
    return { agentId, issueId, runId, execution, runnerInstanceId: native.runnerInstanceId };
  }

  type Seeded = Awaited<ReturnType<typeof seedRun>>;

  async function failStartup(
    seeded: Seeded,
    failure: Error,
    options: { leaseOwner?: string; beforeFailure?: () => Promise<void> } = {},
  ) {
    provider.execute.mockReset().mockImplementation(async () => {
      await options.beforeFailure?.();
      throw failure;
    });
    const startedAt = new Date();
    await expect(
      executePaperclipNativeSession({
        db,
        execution: seeded.execution,
        runnerInstanceId: seeded.runnerInstanceId,
        ...(options.leaseOwner ? { leaseOwner: options.leaseOwner } : {}),
        backend: {
          descriptor: async () => {
            throw new Error("Unexpected provider descriptor call");
          },
          openSession: async () => {
            throw new Error("Unexpected provider session call");
          },
        },
      }),
    ).rejects.toThrow("PRP command session.open");
    expect(provider.execute).toHaveBeenCalledTimes(1);
    return startedAt;
  }

  async function read(seeded: Seeded) {
    const [coordinator] = await db
      .select()
      .from(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.runId, seeded.runId));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId));
    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, seeded.issueId));
    const action = actions.find((entry) => ["active", "escalated"].includes(entry.status)) ?? null;
    return { coordinator: coordinator!, run: run!, issue: issue!, action };
  }

  /** Claims the scheduled retry through the same path the recovery scheduler uses. */
  async function claimRetry(seeded: Seeded) {
    const { coordinator } = await read(seeded);
    expect(coordinator.nextAttemptAt).toBeInstanceOf(Date);
    const early = await claimNativeSessionResumptions({
      db,
      runnerInstanceId: "startup-retry-test",
      runIds: [seeded.runId],
      now: new Date(coordinator.nextAttemptAt!.getTime() - 1),
      deferIneligible: false,
    });
    expect(early).toEqual([]);
    const claims = await claimNativeSessionResumptions({
      db,
      runnerInstanceId: "startup-retry-test",
      runIds: [seeded.runId],
      now: new Date(coordinator.nextAttemptAt!.getTime() + 1),
      deferIneligible: false,
    });
    expect(claims).toHaveLength(1);
    return claims[0]!.leaseOwner;
  }

  async function recordPriorRun(agentId: string, values: Partial<typeof heartbeatRuns.$inferInsert>) {
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      runtimeMode: "native",
      invocationSource: "assignment",
      triggerDetail: "system",
      ...values,
    });
  }

  it("retries a rejected session.open with growing backoff instead of blocking the task", async () => {
    const seeded = await seedRun(await createAgent());

    const firstFailedAt = await failStartup(seeded, sessionOpenFailure());
    let state = await read(seeded);
    expect(state.coordinator).toMatchObject({
      phase: "retryable_failure",
      recoveryState: "resuming_session",
      attempt: 1,
      leaseOwner: null,
      failureDetail: expect.objectContaining({
        originalFailureCode: "provider_session_open_rejected",
        recoveryMode: "bootstrap_retry",
        providerSessionEstablished: false,
        providerEventsExist: false,
        checkpointExists: false,
      }),
    });
    const [firstLow, firstHigh] = backoffWindow(firstFailedAt, 1);
    expect(state.coordinator.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(firstLow);
    expect(state.coordinator.nextAttemptAt!.getTime()).toBeLessThanOrEqual(firstHigh + 5_000);
    expect(state.coordinator.failureDetail).not.toHaveProperty("providerCooldownAt");
    expect(state.issue.status).toBe("in_progress");
    expect(state.run).toMatchObject({
      status: "failed",
      nativePhase: "retryable_failure",
      errorCode: "provider_session_open_rejected",
    });
    expect(state.action).toMatchObject({
      ownerType: "agent",
      ownerAgentId: seeded.agentId,
      wakePolicy: {
        kind: "resume_native_run",
        runId: seeded.runId,
        notBefore: state.coordinator.nextAttemptAt!.toISOString(),
      },
    });

    const secondFailedAt = await failStartup(seeded, sessionOpenFailure(), {
      leaseOwner: await claimRetry(seeded),
    });
    state = await read(seeded);
    expect(state.coordinator).toMatchObject({ phase: "retryable_failure", attempt: 2 });
    const [secondLow, secondHigh] = backoffWindow(secondFailedAt, 2);
    expect(state.coordinator.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(secondLow);
    expect(state.coordinator.nextAttemptAt!.getTime()).toBeLessThanOrEqual(secondHigh + 5_000);
    expect(state.issue.status).toBe("in_progress");
  });

  it("blocks with a clear reason once the bounded startup budget is exhausted", async () => {
    const seeded = await seedRun(await createAgent());
    await failStartup(seeded, sessionOpenFailure());
    await failStartup(seeded, sessionOpenFailure(), { leaseOwner: await claimRetry(seeded) });
    await failStartup(seeded, sessionOpenFailure(), { leaseOwner: await claimRetry(seeded) });

    const state = await read(seeded);
    expect(state.coordinator).toMatchObject({
      phase: "terminal_failure",
      recoveryState: "blocked",
      failureCode: "native_session_retry_exhausted",
      attempt: 3,
      nextAttemptAt: null,
      failureDetail: expect.objectContaining({
        originalFailureCode: "provider_session_open_rejected",
        recoveryMode: "bootstrap_retry",
        providerSessionEstablished: false,
      }),
    });
    expect(state.issue.status).toBe("blocked");
    expect(state.issue.executionRunId).toBeNull();
    expect(state.action).toMatchObject({
      ownerType: "board",
      cause: "native_session_retry_exhausted",
      wakePolicy: null,
    });
    expect(state.action!.nextAction).toContain("3 attempts");
    expect(state.action!.nextAction).toContain("before any provider work began");
    expect(String(state.coordinator.failureDetail?.nextAction)).toContain("before any provider work began");
    // The task cannot be claimed for another automatic attempt.
    expect(await claimNativeSessionResumptions({
      db,
      runnerInstanceId: "startup-retry-test",
      runIds: [seeded.runId],
      now: new Date(Date.now() + 60 * 60_000),
      deferIneligible: false,
    })).toEqual([]);
  });

  it("waits for the cooldown of a recent provider usage limit before retrying", async () => {
    const agentId = await createAgent();
    const limitedAt = new Date(Date.now() - 5 * 60_000);
    await recordPriorRun(agentId, {
      status: "failed",
      startedAt: new Date(limitedAt.getTime() - 60_000),
      finishedAt: limitedAt,
      errorCode: "native_provider_terminal_failed",
      resultJson: { providerFailure: limitFailure() },
    });
    const seeded = await seedRun(agentId);

    const failedAt = await failStartup(seeded, sessionOpenFailure());
    const state = await read(seeded);
    const cooldownAt = new Date(limitedAt.getTime() + 60 * 60_000);
    expect(state.coordinator).toMatchObject({
      phase: "retryable_failure",
      failureDetail: expect.objectContaining({
        recoveryMode: "bootstrap_retry",
        providerCooldownAt: cooldownAt.toISOString(),
      }),
    });
    const [low, high] = backoffWindow(cooldownAt, 1);
    expect(state.coordinator.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(low);
    expect(state.coordinator.nextAttemptAt!.getTime()).toBeLessThanOrEqual(high);
    expect(state.coordinator.nextAttemptAt!.getTime()).toBeGreaterThan(failedAt.getTime() + 50 * 60_000);
    expect(String(state.coordinator.failureDetail?.nextAction)).toContain(cooldownAt.toISOString());
    expect(state.issue.status).toBe("in_progress");
    expect(state.action).toMatchObject({
      ownerType: "agent",
      evidence: expect.objectContaining({ providerCooldownAt: cooldownAt.toISOString() }),
      wakePolicy: expect.objectContaining({
        kind: "resume_native_run",
        notBefore: state.coordinator.nextAttemptAt!.toISOString(),
      }),
    });
    expect(await claimNativeSessionResumptions({
      db,
      runnerInstanceId: "startup-retry-test",
      runIds: [seeded.runId],
      now: new Date(cooldownAt.getTime() - 1),
      deferIneligible: false,
    })).toEqual([]);
  });

  it("uses a provider-reported reset time from earlier runs or from the startup failure itself", async () => {
    const recordedAgent = await createAgent();
    const recordedResetAt = new Date(Date.now() + 3 * 60 * 60_000);
    await recordPriorRun(recordedAgent, {
      status: "failed",
      startedAt: new Date(Date.now() - 20 * 60_000),
      finishedAt: new Date(Date.now() - 10 * 60_000),
      errorCode: "native_provider_terminal_failed",
      resultJson: {
        providerFailure: limitFailure({
          category: "quota_exhausted",
          retryAt: recordedResetAt.toISOString(),
          retryability: "requires_action",
        }),
      },
    });
    const recorded = await seedRun(recordedAgent);
    await failStartup(recorded, sessionOpenFailure());
    let state = await read(recorded);
    expect(state.coordinator.failureDetail).toMatchObject({
      providerCooldownAt: recordedResetAt.toISOString(),
    });
    expect(state.coordinator.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(
      backoffWindow(recordedResetAt, 1)[0],
    );

    // A runner that classifies the startup rejection itself supplies the evidence.
    const startupResetAt = new Date(Date.now() + 2 * 60 * 60_000);
    const classified = await seedRun(await createAgent());
    await failStartup(classified, sessionOpenFailure({
      providerFailure: limitFailure({
        phase: "startup",
        retryAt: startupResetAt.toISOString(),
        retryability: "transient",
      }),
    }));
    state = await read(classified);
    expect(state.coordinator).toMatchObject({
      phase: "retryable_failure",
      failureDetail: expect.objectContaining({
        recoveryMode: "bootstrap_retry",
        providerCooldownAt: startupResetAt.toISOString(),
      }),
    });
    expect(state.coordinator.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(
      backoffWindow(startupResetAt, 1)[0],
    );
    expect(state.issue.status).toBe("in_progress");
  });

  it("holds a startup retry for at most one day before trying again", async () => {
    const seeded = await seedRun(await createAgent());
    const failedAt = await failStartup(seeded, sessionOpenFailure({
      providerFailure: limitFailure({
        phase: "startup",
        category: "quota_exhausted",
        retryAt: new Date(Date.now() + 3 * 24 * 60 * 60_000).toISOString(),
        retryability: "requires_action",
      }),
    }));
    const state = await read(seeded);
    const cooldownAt = Date.parse(String(state.coordinator.failureDetail?.providerCooldownAt));
    expect(cooldownAt).toBeGreaterThanOrEqual(failedAt.getTime() + 24 * 60 * 60_000);
    expect(cooldownAt).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60_000);
    expect(state.coordinator.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(backoffWindow(new Date(cooldownAt), 1)[0]);
  });

  it("ignores limit evidence that a later success, another agent, or time has cleared", async () => {
    const agentId = await createAgent();
    const otherAgentId = await createAgent();
    await recordPriorRun(agentId, {
      status: "failed",
      startedAt: new Date(Date.now() - 30 * 60_000),
      finishedAt: new Date(Date.now() - 25 * 60_000),
      errorCode: "native_provider_terminal_failed",
      resultJson: { providerFailure: limitFailure() },
    });
    await recordPriorRun(agentId, {
      status: "succeeded",
      startedAt: new Date(Date.now() - 20 * 60_000),
      finishedAt: new Date(Date.now() - 15 * 60_000),
    });
    await recordPriorRun(agentId, {
      status: "failed",
      startedAt: new Date(Date.now() - 3 * 60 * 60_000),
      finishedAt: new Date(Date.now() - 2 * 60 * 60_000),
      errorCode: "native_provider_usage_limit",
    });
    await recordPriorRun(otherAgentId, {
      status: "failed",
      startedAt: new Date(Date.now() - 2 * 60_000),
      finishedAt: new Date(Date.now() - 60_000),
      errorCode: "native_provider_terminal_failed",
      resultJson: { providerFailure: limitFailure() },
    });
    const seeded = await seedRun(agentId);

    const failedAt = await failStartup(seeded, sessionOpenFailure());
    const state = await read(seeded);
    expect(state.coordinator.phase).toBe("retryable_failure");
    expect(state.coordinator.failureDetail).not.toHaveProperty("providerCooldownAt");
    expect(state.coordinator.nextAttemptAt!.getTime()).toBeLessThanOrEqual(
      backoffWindow(failedAt, 1)[1] + 5_000,
    );
  });

  it.each([
    { name: "a durable provider event exists", status: "failed" as const, providerEvent: true },
    { name: "the session.open outcome is indeterminate", status: "indeterminate" as const, providerEvent: false },
  ])("never retries automatically when $name", async ({ status, providerEvent }) => {
    const seeded = await seedRun(await createAgent());
    await failStartup(seeded, sessionOpenFailure({ status }), {
      beforeFailure: providerEvent
        ? async () => {
          await db.insert(heartbeatRunEvents).values({
            companyId,
            runId: seeded.runId,
            agentId: seeded.agentId,
            seq: 900,
            eventType: "turn.started",
            stream: "system",
          });
        }
        : undefined,
    });

    const state = await read(seeded);
    expect(state.coordinator).toMatchObject({
      phase: "terminal_failure",
      recoveryState: "blocked",
      nextAttemptAt: null,
      failureDetail: expect.objectContaining({
        recoveryMode: "ambiguous_state",
        providerSessionEstablished: providerEvent,
      }),
    });
    expect(state.issue.status).toBe("blocked");
    expect(state.action).toMatchObject({ ownerType: "board", wakePolicy: null });
    expect(await claimNativeSessionResumptions({
      db,
      runnerInstanceId: "startup-retry-test",
      runIds: [seeded.runId],
      now: new Date(Date.now() + 60 * 60_000),
      deferIneligible: false,
    })).toEqual([]);
  });
});
