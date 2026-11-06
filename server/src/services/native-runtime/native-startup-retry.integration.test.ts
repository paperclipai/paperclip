import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
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
  nativeRunnerCheckpoints,
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
import { DurablePrpControlPlane } from "../../vendor/paperclip-runner/index.js";
import { createNativeRunnerExecutionDriver } from "./native-runner-execution-driver.js";
import { currentNativeControllerIdentity } from "./native-restart-recovery.js";
import { loadNativeRunnerCheckpoint } from "./native-runner-checkpoint.js";
import { environmentRunnerIngressErrorData, JsonRpcCallError, PluginEnvironmentRunnerIngressError } from "@paperclipai/plugin-sdk";
import { accountRunCost } from "../run-cost-accounting.js";
import { settleUnrecoverableExecutions } from "../execution-recovery-resolution.js";
import { agentProviderLimitCooldown } from "./native-startup-retry.js";
import { resolveLocalRuntimeApiUrl, runtimeApiInternals } from "../../runtime-api.js";

type SessionOpenStatus = "failed" | "rejected" | "indeterminate";

/** Mirrors the runner's failed-command error: provider detail stays off the message. */
function sessionOpenFailure(options: {
  status?: SessionOpenStatus;
  providerFailure?: Record<string, unknown>;
  classification?: string;
} = {}) {
  const status = options.status ?? "failed";
  const result = {
    result: {
      code: "command_execution_failed",
      message: options.providerFailure
        ? "Provider request failed"
        : `failed to start ACPX provider: ACPX sidecar command session.open was rejected (retryable=false, classification=${options.classification ?? "session_ensure_failed"})`,
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

  it.each([
    { name: "transient 502", status: 502, retry: true },
    { name: "credential 401", status: 401, retry: false },
    { name: "permission 403", status: 403, retry: false },
    { name: "invalid request 400", status: 400, retry: false },
    { name: "untyped HTML 502", status: 502, retry: false, raw: true },
    { name: "previously issued credential", status: 502, retry: false, checkpoint: "issued" },
    { name: "legacy checkpoint", status: 502, retry: false, checkpoint: "legacy" },
    { name: "truncated checkpoint", status: 502, retry: false, checkpoint: "truncated" },
    { name: "provider progress", status: 502, retry: false, checkpoint: "progress" },
    { name: "checkpoint change during settlement", status: 502, retry: false, race: "checkpoint" },
    { name: "Stop during settlement", status: 502, retry: false, race: "stop" },
    { name: "new controller claim during settlement", status: 502, retry: false, race: "claim" },
    { name: "exhausted transient 502", status: 502, retry: false, finalAttempt: true },
  ])("settles ingress failure safely: $name", async options => {
    const seeded = await seedRun(await createAgent());
    if (options.finalAttempt) await db.update(nativeRunFinalizations).set({ attempt: 2 }).where(eq(nativeRunFinalizations.runId, seeded.runId));
    const root = mkdtempSync(join(tmpdir(), "native-ingress-bootstrap-"));
    const server = createServer((_request, response) => {
      response.writeHead(options.status, { "content-type": "text/html" });
      response.end(`<html><title>${options.status} Bad Gateway</title></html>`);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server missing address");
    const identity = {
      runnerInstanceId: seeded.runnerInstanceId,
      environmentLeaseId: seeded.execution.binding.executionWorkspaceId,
      runId: seeded.runId,
      normalizedSessionId: seeded.execution.session.normalizedSessionId!,
      turnId: `turn-${seeded.runId}`,
      itemId: `item-${seeded.runId}`,
    };
    const core = new DurablePrpControlPlane({ stateDirectory: root, identity,
      expectedRunnerVersion: "0.3.0", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
    const prepare = { observeCredentials: true, authorizedTools: {}, provider: { provider: "codex" } };
    core.persistRunAttachTemplate(prepare);
    core.queueCommand("run.prepare", prepare);
    core.queueCommand("session.open", { reuse: "same_session" });
    if (options.checkpoint === "issued") {
      core.issueBootstrapTicket();
      core.store.state.tickets = {};
    }
    if (options.checkpoint === "legacy") {
      core.store.state.schema = "paperclip.runner.durable.control-plane-state.v1";
      delete core.store.state.bootstrapHistory;
    }
    const launch = vi.fn();
    let settlementArmed = false;
    let settlementTransactions = 0;
    const transaction = db.transaction.bind(db);
    const settlementRace = options.race ? vi.spyOn(db, "transaction").mockImplementation(async (...args) => {
      if (settlementArmed && ++settlementTransactions === 2) {
        settlementArmed = false;
        if (options.race === "checkpoint") { core.issueBootstrapTicket(); await core.flushCheckpoint(); }
        if (options.race === "stop") await db.update(heartbeatRuns).set({ resultJson: {
          nativeCancellation: { schema: "paperclip.native-cancellation.v1", companyId, issueId: seeded.issueId,
            runId: seeded.runId, scope: "run", intentAuditId: randomUUID(), dispatchState: "pending" },
        } }).where(eq(heartbeatRuns.id, seeded.runId));
        if (options.race === "claim") await db.update(nativeRunFinalizations).set({
          controllerGeneration: sql`${nativeRunFinalizations.controllerGeneration} + 1`, leaseOwner: "successor-controller",
        }).where(eq(nativeRunFinalizations.runId, seeded.runId));
      }
      return transaction(...args);
    }) : undefined;
    const getRunnerIngressEndpoint = vi.fn(async () => {
      const response = await fetch(`http://127.0.0.1:${address.port}/private-preview`);
      if (options.checkpoint === "truncated") await db.delete(nativeRunnerCheckpoints).where(and(
        eq(nativeRunnerCheckpoints.companyId, companyId), eq(nativeRunnerCheckpoints.runId, seeded.runId),
        eq(nativeRunnerCheckpoints.part, "command:2")));
      if (options.checkpoint === "progress") await db.insert(heartbeatRunEvents).values({
        companyId, runId: seeded.runId, agentId: seeded.agentId, seq: 900, eventType: "turn.started", stream: "system", level: "info",
        message: "Provider activity exists", payload: {},
      });
      if (!response.ok) {
        const cause = new Error(await response.text());
        if (options.raw) throw cause;
        const error = new PluginEnvironmentRunnerIngressError({ phase: "private_preview", httpStatus: response.status });
        settlementArmed = true;
        throw new JsonRpcCallError({ code: -32000, message: error.message, data: environmentRunnerIngressErrorData(error) });
      }
      throw new Error("expected the controlled ingress rejection");
    });
    provider.execute.mockReset().mockImplementation(async () => {
      const controller = await currentNativeControllerIdentity();
      const driver = createNativeRunnerExecutionDriver({
        target: { kind: "remote", transport: "sandbox", remoteCwd: "/workspace", leaseId: randomUUID(),
          effectiveCapabilities: { runnerWebSocketIngress: true }, getRunnerIngressEndpoint } as never,
        binding: seeded.execution.binding, runnerIngressAuthorized: true, prepareRemote: async () => {},
        controllerPersistence: { db, bootId: controller.bootId },
        processStarted: new Promise<void>(() => {}), process: { runnerProcessLauncher: launch },
      });
      await driver.controlPlaneRegistration!(core);
      throw new Error("ingress failure must precede process launch");
    });
    try {
      await expect(executePaperclipNativeSession({ db, execution: seeded.execution,
        runnerInstanceId: seeded.runnerInstanceId, useRunnerd: true,
        runnerExecutionTarget: { kind: "remote", transport: "sandbox", remoteCwd: "/workspace", runner: {} } as never,
        backend: { descriptor: async () => { throw new Error("unexpected descriptor"); },
          openSession: async () => { throw new Error("unexpected provider session"); } },
      })).rejects.toThrow(options.race === "claim" ? "native_session_lease_lost" : options.race
        ? "native_runner_bootstrap_evidence_changed" : options.raw ? "502 Bad Gateway" : `HTTP ${options.status}`);
      expect(getRunnerIngressEndpoint).toHaveBeenCalledOnce();
      expect(launch).not.toHaveBeenCalled();
      if (options.checkpoint !== "truncated") {
        const saved = await loadNativeRunnerCheckpoint(db, seeded.execution.binding);
        expect(saved?.recoveryEvidence.authenticatedConnectionCount).toBe(0);
        expect(saved?.records.size).toBe(4);
      }
      const state = await read(seeded);
      if (options.race) {
        expect(state.coordinator.phase).not.toBe("retryable_failure");
        expect(state.coordinator.phase).not.toBe("terminal_failure");
        expect(state.coordinator.leaseOwner).not.toBeNull();
        expect(state.issue.executionRunId).toBe(seeded.runId);
        expect(state.run.status).toBe("running");
        expect(state.run.costAccountedAt).toBeNull();
        expect(state.run.usageJson?.accountingProviderWorkStarted).not.toBe(false);
        return;
      }
      expect(state.coordinator).toMatchObject({ phase: options.retry ? "retryable_failure" : "terminal_failure", attempt: options.finalAttempt ? 3 : 1,
        failureDetail: { recoveryMode: options.retry || options.finalAttempt ? "bootstrap_retry" : "ambiguous_state",
          providerSessionEstablished: options.checkpoint === "progress", providerEventsExist: options.checkpoint === "progress", checkpointExists: false } });
      if (options.retry) expect(state.coordinator.nextAttemptAt).toBeInstanceOf(Date);
      else expect(state.coordinator.nextAttemptAt).toBeNull();
      expect(state.issue.status).toBe(options.retry ? "in_progress" : "blocked");
      expect(state.run.costAccountedAt).toBeNull();
      expect(state.coordinator.resultId).toBeNull();
      if (options.retry || options.checkpoint) {
        expect(state.run.usageJson?.accountingProviderWorkStarted).not.toBe(false);
      } else {
        expect(state.run.usageJson?.accountingProviderWorkStarted).toBe(false);
        expect(await accountRunCost(db, seeded.runId)).toBe(true);
        expect((await read(seeded)).run.costAccountedAt).toBeInstanceOf(Date);
      }
    } finally {
      settlementRace?.mockRestore();
      await core.stop();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });

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

  it("retries startup that a draining server interrupted before any provider session", async () => {
    const seeded = await seedRun(await createAgent());
    // A graceful shutdown closes the HTTP listener first; startup that reaches
    // the runtime API lookup afterwards fails before a runner or provider exists.
    runtimeApiInternals.resetForTests();
    provider.execute.mockReset().mockImplementation(async () => {
      resolveLocalRuntimeApiUrl();
      throw new Error("expected the closed listener to stop startup");
    });
    const failedAt = new Date();
    await expect(executePaperclipNativeSession({
      db,
      execution: seeded.execution,
      runnerInstanceId: seeded.runnerInstanceId,
      backend: {
        descriptor: async () => { throw new Error("Unexpected provider descriptor call"); },
        openSession: async () => { throw new Error("Unexpected provider session call"); },
      },
    })).rejects.toThrow("local_runtime_api_listener_unavailable");

    const state = await read(seeded);
    expect(state.coordinator).toMatchObject({
      phase: "retryable_failure",
      recoveryState: "resuming_session",
      attempt: 1,
      leaseOwner: null,
      failureDetail: expect.objectContaining({
        originalFailureCode: "local_runtime_api_listener_unavailable",
        recoveryMode: "bootstrap_retry",
        providerSessionEstablished: false,
        providerEventsExist: false,
        checkpointExists: false,
      }),
    });
    const [low, high] = backoffWindow(failedAt, 1);
    expect(state.coordinator.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(low);
    expect(state.coordinator.nextAttemptAt!.getTime()).toBeLessThanOrEqual(high + 5_000);
    expect(state.issue.status).toBe("in_progress");
    expect(state.action).toMatchObject({
      ownerType: "agent",
      ownerAgentId: seeded.agentId,
      wakePolicy: { kind: "resume_native_run", runId: seeded.runId },
    });
    // The next server process claims the same run; no replacement run is created.
    await claimRetry(seeded);
  });

  it("keeps a closed-listener failure operator-owned once provider work is durable", async () => {
    const seeded = await seedRun(await createAgent());
    runtimeApiInternals.resetForTests();
    provider.execute.mockReset().mockImplementation(async () => {
      await db.insert(heartbeatRunEvents).values({
        companyId, runId: seeded.runId, agentId: seeded.agentId, seq: 900,
        eventType: "turn.started", stream: "system",
      });
      resolveLocalRuntimeApiUrl();
    });
    await expect(executePaperclipNativeSession({
      db,
      execution: seeded.execution,
      runnerInstanceId: seeded.runnerInstanceId,
      backend: {
        descriptor: async () => { throw new Error("Unexpected provider descriptor call"); },
        openSession: async () => { throw new Error("Unexpected provider session call"); },
      },
    })).rejects.toThrow("local_runtime_api_listener_unavailable");

    const state = await read(seeded);
    expect(state.coordinator).toMatchObject({
      phase: "terminal_failure",
      nextAttemptAt: null,
      failureDetail: expect.objectContaining({ recoveryMode: "ambiguous_state", providerSessionEstablished: true }),
    });
    expect(state.issue.status).toBe("blocked");
  });

  it.each(["grok_model_mismatch", "requested_model_unsupported"])(
    "stops at a session.open %s rejection with a choose-model action instead of a doomed retry",
    async (classification) => {
      const seeded = await seedRun(await createAgent());
      await failStartup(seeded, sessionOpenFailure({ classification }));

      const state = await read(seeded);
      // No automatic same-run bootstrap retry: the selected model cannot start.
      expect(state.coordinator).toMatchObject({
        phase: "terminal_failure",
        recoveryState: "blocked",
        failureCode: "native_provider_model_rejected",
        attempt: 1,
        nextAttemptAt: null,
        failureDetail: expect.objectContaining({
          originalFailureCode: "native_provider_model_rejected",
          providerSessionEstablished: false,
          providerEventsExist: false,
          checkpointExists: false,
        }),
      });
      expect(String(state.coordinator.failureDetail?.nextAction)).toContain("Choose a supported model");
      expect(state.run).toMatchObject({ status: "failed", errorCode: "native_provider_model_rejected" });
      expect(state.issue.status).toBe("blocked");
      expect(state.issue.executionRunId).toBeNull();
      // A named, durable board action owns the next step.
      expect(state.action).toMatchObject({
        status: "active",
        ownerType: "board",
        cause: "native_provider_model_rejected",
        returnOwnerAgentId: seeded.agentId,
        wakePolicy: null,
      });
      expect(state.action!.nextAction).toContain("Choose a supported model");
      // The no-replay settler must not fold this owned action into a silent hold.
      await settleUnrecoverableExecutions(db);
      expect((await read(seeded)).action).toMatchObject({ id: state.action!.id, status: "active" });
      expect(await claimNativeSessionResumptions({
        db,
        runnerInstanceId: "startup-retry-test",
        runIds: [seeded.runId],
        now: new Date(Date.now() + 60 * 60_000),
        deferIneligible: false,
      })).toEqual([]);
    },
  );

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

  it("reads the reset clock from an ACP terminal limit failure's provider wording", async () => {
    const agentId = await createAgent();
    const limitedAt = new Date(Date.now() - 5 * 60_000);
    const resetHour = new Date(Date.now() + 3 * 60 * 60_000).getUTCHours();
    await recordPriorRun(agentId, {
      status: "failed",
      startedAt: new Date(limitedAt.getTime() - 60_000),
      finishedAt: limitedAt,
      errorCode: "native_provider_usage_limit",
      resultJson: {
        providerFailure: limitFailure({
          category: "quota_exhausted",
          message: `ACP agent reported a terminal limit failure.\nYou've hit your session limit · resets ${resetHour}:00 (UTC)`,
        }),
      },
    });
    const expected = new Date(limitedAt);
    expected.setUTCHours(resetHour, 0, 0, 0);
    if (expected <= limitedAt) expected.setUTCDate(expected.getUTCDate() + 1);

    const seeded = await seedRun(agentId);
    await failStartup(seeded, sessionOpenFailure());
    const state = await read(seeded);
    expect(state.coordinator.failureDetail).toMatchObject({ providerCooldownAt: expected.toISOString() });
    expect(await agentProviderLimitCooldown(db, { companyId, agentId, now: new Date() }))
      .toMatchObject({ resetAt: expected, resetReported: true });
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
