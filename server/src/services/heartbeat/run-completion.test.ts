import { promises as fs } from "node:fs";
import { createDurableRunLogStore } from "../run-log-store.js";
import { createServer } from "node:http";
import { registerLocalRuntimeApiServer } from "../../runtime-api.js";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executePaperclipNativeSession, closeIdleWarmNativeSessionsForRestart, nativeSessionFailureSourceCode } from "../native-runtime/native-session-executor.js";
import { createHeartbeatRunOutput } from "./run-output.js";
import { createHeartbeatRunControl } from "./run-control.js";
import { callbacks as controlCallbacks } from "./__tests__/run-control-fixtures.js";
import { objectLogFixture } from "./__tests__/object-log-fixture.js";
import { createNativeUsageDelivery } from "../native-runtime/native-usage-delivery.js";
import type { PrpEvent } from "../../vendor/paperclip-runner/index.js";
import { createHash, randomUUID } from "node:crypto";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { createNativeRunLogCoverageVerifier, formatNativeRunLogEvent } from "../native-runtime/native-run-log-export.js";
import type { Db } from "@paperclipai/db";
import { activityLog, agents, agentWakeupRequests, aiConnectionPools, aiConnectionTaskPins, aiConnectionQuotaCooldowns, toolApplications, toolConnections, budgetReservations, caseHandoffs, cases, companies, completionContracts, costEvents, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns, heartbeatRunEvents, issueRecoveryActions, issues, nativeRunFinalizations, issueComments, issueQuestionResponseDeliveries } from "@paperclipai/db";
import { eq, sql, and } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import * as usageReceipts from "../usage-receipts.js";
import { createAgentIdentityRedactor } from "../agent-identity-redaction.js";
import { UnresolvedWorkspaceBaseRefError } from "../workspace-runtime.js";
import { LegacyControllerLeaseLostError } from "../legacy-controller-lease.js";
import { requestedRunCancellation } from "../run-cancellation.js";
import { ProjectAccessDeniedError } from "../project-access-denial.js";
import { RemoteWorkspaceOperationError, RemoteWorkspaceOperationTimeoutError, RemoteWorkspacePreparationTimeoutError, RemoteWorkspaceRestoreError } from "../remote-workspace-transport.js";
import { EnvironmentRunError, environmentRunOrchestrator } from "../environment-run-orchestrator.js";
import { ReusableSandboxResumeError } from "../reusable-sandbox-resume-error.js";
import { PluginWorkerUnavailableError } from "../plugin-worker-unavailable-error.js";
import { ReviewedChatBindingDeniedError, ReviewedChatBindingNotReadyError } from "../reviewed-chat-binding-diagnostics.js";
import { environmentTaskErrorCodeData, JsonRpcCallError, PluginEnvironmentTaskError, PluginWorkspaceOperationError, workspaceOperationErrorData } from "@paperclipai/plugin-sdk";
import { RUNNER_REVISION_MISMATCH_RETRY } from "../runner-revision-mismatch.js";
import { workspaceProviderCallFailure } from "../workspace-provider-failure.js";
import { logger } from "../../middleware/logger.js";
import { unprocessable } from "../../errors.js";
import { createHeartbeatLifecycle, type HeartbeatLifecycleDependencies } from "./run-lifecycle.js";
import { createHeartbeatRunPreparation, ConfigurationIncompleteFailure, classifyManagedProjectAuthFailure } from "./run-preparation.js";
import { createHeartbeatRunState, getAdapterSessionCodec } from "./run-state.js";
import { buildEffectiveRunSessionConfigMetadata } from "./workspaces.js";
import { createHeartbeatRunCompletion, isConfirmedProviderQuotaFailure, recordVerifiedRouterQuotaCooldown, type CompleteHeartbeatRunInput, type FailHeartbeatRunInput, type HeartbeatRunCompletionDependencies } from "./run-completion.js";
import { createHeartbeatAgentStatus } from "./agent-status.js";
import { prepareNativeHeartbeatRun } from "../native-runtime/prepare-native-run.js";
import { buildNativeCompletionContract } from "../native-runtime/completion-contracts.js";
import { readPendingNativeRunStop } from "../native-runtime/native-cancellation-request.js";
import { reserveRunBudget } from "../budget-reservations.js";
import { hasAcknowledgedNativeReassignmentStopIntent } from "../acknowledged-native-stop.js";
import { PROVIDER_LIMIT_DEFAULT_COOLDOWN_MS } from "../system-recovery-state.js";
import { planNativeStartupRetry } from "../native-runtime/native-startup-retry.js";
import { questionResponseDeliveryService } from "../question-response-delivery.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";
import { heartbeatService } from "../heartbeat.js";

vi.mock("../live-events.js", () => ({ publishLiveEvent: vi.fn() }));

const diagnosticNativeFixture = vi.hoisted(() => ({
  enabled: false,
  retireWarm: false,
  beforeWarmClose: undefined as (() => Promise<void>) | undefined,
  backendOptions: undefined as Parameters<typeof import("../../vendor/paperclip-runner/index.js").createNativeSessionBackend>[1],
}));
vi.mock("../native-runtime/native-codex-runner.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../native-runtime/native-codex-runner.js")>();
  return { ...actual, resolvePaperclipRunnerBinary: () => diagnosticNativeFixture.enabled ? process.execPath : actual.resolvePaperclipRunnerBinary() };
});
vi.mock("../../vendor/paperclip-runner/index.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../vendor/paperclip-runner/index.js")>();
  return { ...actual,
    createNativeSessionBackend: (...args: Parameters<typeof actual.createNativeSessionBackend>) => {
      if (!diagnosticNativeFixture.enabled) return actual.createNativeSessionBackend(...args);
      diagnosticNativeFixture.backendOptions = args[1];
      return { descriptor: () => ({ kind: "test" }) };
    },
    executeNativeSession: async (options: Parameters<typeof actual.executeNativeSession>[0]) => {
      if (!diagnosticNativeFixture.enabled) return actual.executeNativeSession(options);
      const transport = diagnosticNativeFixture.backendOptions!.codexTransportFactory!();
      const session = { close: async ({ reason }: { reason: string }) => { await transport.close(reason); } };
      await options.onSession?.(session as never);
      await diagnosticNativeFixture.beforeWarmClose?.();
      if (diagnosticNativeFixture.retireWarm) await closeIdleWarmNativeSessionsForRestart();
      return { result: { summary: "accepted result" }, terminal: { runTerminalState: "succeeded" }, turnId: "test-turn",
        normalizedSessionId: options.input.session.normalizedSessionId, providerSessionId: "synthetic-provider",
        driverKind: "test", driverVersion: "1", nativeEventCount: 1, highestContiguousSourceSeq: 1, usage: null };
    },
  };
});


type Dependencies = HeartbeatRunCompletionDependencies;
function callbacks(db: Db) {
  const state = createHeartbeatRunState(db);
  const lifecycleDeps = {
    ...state, ...createHeartbeatRunPreparation(db),
    issuesSvc: { addComment: vi.fn(), listReviewAttention: vi.fn() },
    recovery: { escalateStrandedAssignedIssue: vi.fn() },
    companySkills: { completeTestRunForIssue: vi.fn() },
    budgets: { getInvocationBlock: vi.fn(async () => null) },
    treeControlSvc: { getActivePauseHoldGate: vi.fn(async () => null) },
    enqueueWakeup: vi.fn(),
    getCurrentUserRedactionOptions: vi.fn(async () => ({ enabled: false })),
    getAgentInvokability: vi.fn<HeartbeatLifecycleDependencies["getAgentInvokability"]>(async () => ({ invokable: true })),
    emitTerminalAgentTaskRun: vi.fn(), budgetHooks: {},
  } satisfies HeartbeatLifecycleDependencies;
  const lifecycle = createHeartbeatLifecycle(db, lifecycleDeps);
  return {
    ...state, ...lifecycle,
    setRunStatusIfRunning: vi.fn(lifecycle.setRunStatusIfRunning),
    setWakeupStatus: vi.fn(lifecycle.setWakeupStatus),
    upsertTaskSession: vi.fn(state.upsertTaskSession),
    clearTaskSessions: vi.fn(state.clearTaskSessions),
    classifyAndPersistRunLiveness: vi.fn<Dependencies["classifyAndPersistRunLiveness"]>(async run => run),
    completeSkillTestRunForHeartbeatOutcome: vi.fn<Dependencies["completeSkillTestRunForHeartbeatOutcome"]>(async () => null),
    refreshContinuationSummaryForRun: vi.fn<Dependencies["refreshContinuationSummaryForRun"]>(async () => null),
    findRunIssueComment: vi.fn<Dependencies["findRunIssueComment"]>(async () => null),
    findLatestCompletedFinalAgentMessage: vi.fn<Dependencies["findLatestCompletedFinalAgentMessage"]>(async () => null),
    finalizeIssueCommentPolicy: vi.fn<Dependencies["finalizeIssueCommentPolicy"]>(async () => ({ outcome: "not_applicable", queuedRun: null })),
    handleIssueReviewPathDisposition: vi.fn<Dependencies["handleIssueReviewPathDisposition"]>(async () => undefined),
    handleRunLivenessContinuation: vi.fn<Dependencies["handleRunLivenessContinuation"]>(),
    handleSuccessfulRunHandoff: vi.fn<Dependencies["handleSuccessfulRunHandoff"]>(),
    updateRuntimeState: vi.fn<Dependencies["updateRuntimeState"]>(),
    scheduleBoundedRetryForRun: vi.fn<Dependencies["scheduleBoundedRetryForRun"]>(),
    scheduleInteractionContinuationInfrastructureRetryIfEligible: vi.fn<Dependencies["scheduleInteractionContinuationInfrastructureRetryIfEligible"]>(async () => null),
    timerClaimWasFirstHeartbeat: vi.fn<Dependencies["timerClaimWasFirstHeartbeat"]>(() => undefined),
    releaseIssueExecutionAndPromote: vi.fn<Dependencies["releaseIssueExecutionAndPromote"]>(async () => undefined),
    finalizeAgentStatus: vi.fn<Dependencies["finalizeAgentStatus"]>(async () => undefined),
    enqueueWakeup: vi.fn<Dependencies["enqueueWakeup"]>(),
    issuesSvc: { addComment: vi.fn<Dependencies["issuesSvc"]["addComment"]>() },
    recovery: { reconcileLegacyContinuation: vi.fn<Dependencies["recovery"]["reconcileLegacyContinuation"]>(), reconcileResolvedDependencyWakeBackstop: vi.fn<Dependencies["recovery"]["reconcileResolvedDependencyWakeBackstop"]>() },
    getCurrentUserRedactionOptions: lifecycleDeps.getCurrentUserRedactionOptions,
    budgetHooks: {},
    runLogStore: { finalize: vi.fn<Dependencies["runLogStore"]["finalize"]>(async () => ({ bytes: 123, sha256: "log-hash", compressed: true })) },
    traceStore: { finalize: vi.fn<Dependencies["traceStore"]["finalize"]>() },
    processRunCancellationSettlements: new Map<string, { settled: Promise<void>; failed: boolean }>(),
    failedProcessRunCancellations: new Map<string, { settled: Promise<void>; failed: boolean }>(),
  } satisfies Dependencies;
}

it("constructs completion handlers without querying or starting work", () => {
  const access = vi.fn(() => { throw new Error("Unexpected database access"); });
  const db = new Proxy({}, { get: access }) as Db;
  const deps = callbacks(db);
  createHeartbeatRunCompletion(db, deps);
  expect(access).not.toHaveBeenCalled();
  for (const callback of Object.values(deps)) if (vi.isMockFunction(callback)) expect(callback).not.toHaveBeenCalled();
});

it("distinguishes Claude allowance exhaustion from ordinary rate limiting", () => {
  const failure = { schema: "paperclip.provider-failure.v1", provider: "anthropic", phase: "turn", category: "rate_limit", retryability: "unknown" };
  expect(isConfirmedProviderQuotaFailure({ ...failure, message: "You've hit your weekly limit" })).toBe(true);
  expect(isConfirmedProviderQuotaFailure({ ...failure, message: "This request would exceed your account's rate limit." })).toBe(false);
  expect(isConfirmedProviderQuotaFailure({ ...failure, provider: "other", message: "You've hit your weekly limit" })).toBe(false);
});

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported && !process.env.PAPERCLIP_TEST_DATABASE_URL)("heartbeat run completion boundary", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  beforeAll(async () => {
    // Keep the accounting transaction real without reading provider receipt files.
    vi.spyOn(usageReceipts, "indexPendingUsageReceipts").mockResolvedValue(new Map());
    vi.spyOn(usageReceipts, "recoverPendingRunUsageReceipts").mockResolvedValue([]);
    const external = process.env.PAPERCLIP_TEST_DATABASE_URL;
    if (external) db = createDb(external);
    else {
      database = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-completion");
      db = createDb(database.connectionString);
    }
    await db.execute(sql`set client_min_messages = warning`);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); vi.restoreAllMocks(); });
  beforeEach(async () => { await db.execute(sql`truncate table companies restart identity cascade`); });

  async function fixture(patch: Partial<typeof heartbeatRuns.$inferInsert> = {}, issuePrefix = "CMP") {
    const [company] = await db.insert(companies).values({ name: "Completion", issuePrefix }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Completing agent", adapterType: "process" }).returning();
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: company.id, agentId: agent.id, source: "on_demand", status: "claimed" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, wakeupRequestId: wake.id, status: "running", runtimeMode: "legacy", ...patch }).returning();
    const deps = callbacks(db);
    const controller = new AbortController();
    const input: CompleteHeartbeatRunInput = {
      run, agent, issueId: null, issueRef: null, signal: controller.signal,
      output: { handle: { store: "local_file", logRef: "test-log" }, outputProgressState: { pending: { bytes: 7 } }, flushOutputProgress: vi.fn(async () => {}), stdoutExcerpt: "answer", stderrExcerpt: "diagnostic" },
      session: { runtimeForAdapter: { sessionId: null, sessionDisplayId: null }, previousSessionParams: null, taskKey: "completion-task", configuredModel: "test-model",
        sessionConfigMetadata: await buildEffectiveRunSessionConfigMetadata({ adapterType: agent.adapterType, effectiveAdapterConfig: {}, agentRuntimeConfig: {}, issueOverrides: null, workspaceConfig: null, environment: null, environmentEnv: null, projectEnv: null, routineEnv: null, runtimeSkills: [] }),
      },
      readFailureReportSecrets: () => [],
      adapterResult: { exitCode: 0, signal: null, timedOut: false, sessionId: "provider-session", sessionParams: { sessionId: "provider-session" }, usage: { inputTokens: 20, cachedInputTokens: 5, outputTokens: 8 }, usageBasis: "per_run", costUsd: 0.01, provider: "test", model: "test-model", resultJson: { finalResponse: "Completed the work." } },
      sessionCodec: getAdapterSessionCodec(agent.adapterType), taskSessionForRun: null, sessionCompaction: { rotate: false, reason: null }, configFreshnessResultMetadata: { version: 1 }, runLedgerScope: {}, currentUserRedactionOptions: { enabled: false }, providerTraceCapture: true, onProviderTraceFinalized: vi.fn(), issueContext: null, onLog: vi.fn(async () => {}),
    };
    const completion = createHeartbeatRunCompletion(db, deps);
    const failure = (err: unknown): FailHeartbeatRunInput => ({ ...input, runId: run.id, err, identityRedactor: createAgentIdentityRedactor("private-identity-material"), requiredWorkspaceRestoreEvidence: { workspaceRestoreFailure: { reason: "missing_base" } }, legacyAdapterEntered: true, goalCheckpointSession: { current: null }, previousSessionDisplayId: "previous-session", taskSession: null });
    const setup = (outerErr: unknown, providerDispatchStarted = false) => ({ run, runId: run.id, outerErr, signal: controller.signal, providerDispatchStarted, identityRedactor: createAgentIdentityRedactor(), readFailureReportSecrets: () => [] });
    return { run, agent, wake, deps, controller, input, completion, failure, setup };
  }
  const read = (id: string) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)).then(rows => rows[0]!);

  it("records quota only for the host credential and exact durable pool pin", async () => {
    const f = await fixture();
    const [app] = await db.insert(toolApplications).values({ companyId: f.run.companyId, name: "Quota", type: "rest_api" }).returning();
    const [pool, account] = await db.insert(toolConnections).values(["pool", "account"].map(name => ({
      companyId: f.run.companyId, applicationId: app.id, name, uid: name, transport: "rest_api" as const,
    }))).returning();
    const grantId = randomUUID();
    const member = { id: randomUUID(), binding: { mode: "delegated" as const, provider: "openai" as const,
      method: "api_key" as const, connectionId: account.id, grantId }, profile: { provider: "codex" as const, model: "gpt-5" } };
    const selection = { poolId: pool.id, memberId: member.id, binding: member.binding, runtimeConfig: { provider: "codex", model: "gpt-5" }, notes: [] };
    await db.insert(aiConnectionPools).values({ id: pool.id, companyId: f.run.companyId, pluginKey: "test",
      config: { name: "pool", enabled: true, mode: "failover", thresholdPercent: 90, members: [member] } });
    await db.insert(aiConnectionTaskPins).values({ companyId: f.run.companyId, agentId: f.run.agentId, poolId: pool.id,
      taskKey: f.run.id, member, selection });
    await db.update(agents).set({ runtimeConfig: { aiConnection: { mode: "router", connectionId: pool.id } } }).where(eq(agents.id, f.agent.id));
    await db.update(heartbeatRuns).set({ contextSnapshot: { aiRouterTaskKey: f.run.id, aiRouterSelection: selection } }).where(eq(heartbeatRuns.id, f.run.id));
    f.input.session.sessionConfigMetadata.aiCredentialIdentity = `${grantId}:shared:no-auth`;
    const deadline = new Date(Date.now() + 120_000);
    f.input.adapterResult = { exitCode: 1, signal: null, timedOut: false, errorCode: "native_provider_usage_limit",
      resultJson: { providerFailure: { schema: "paperclip.provider-failure.v1", provider: "openai", phase: "turn",
        category: "quota_exhausted", message: "quota", retryability: "unknown", retryAt: deadline.toISOString() } }, errorMessage: "quota" };
    await f.completion.completeRun(f.input);
    expect(await db.select().from(aiConnectionQuotaCooldowns)).toMatchObject([{ companyId: f.run.companyId, credentialIdentity: `grant:${grantId}:no-auth`, retryAt: deadline }]);
    const receiptId = `ai-connection-quota-attributed:${f.run.id}`;
    const receipts = () => db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.sourceEventId, receiptId));
    expect(await receipts()).toMatchObject([{ companyId: f.run.companyId, runId: f.run.id, agentId: f.agent.id,
      eventType: "ai_connection.quota_attributed", payload: { runId: f.run.id, poolId: pool.id, taskKey: f.run.id,
        memberId: member.id, connectionId: account.id, grantId, selection, retryAt: deadline.toISOString() } }]);
    await db.delete(aiConnectionQuotaCooldowns);
    const call = { runId: f.run.id, companyId: f.run.companyId, agentId: f.run.agentId, retryNotBefore: deadline.toISOString() };
    expect(await recordVerifiedRouterQuotaCooldown(db, { ...call, credentialIdentity: `${grantId}:shared:no-auth` })).toBe(true);
    expect(await receipts()).toHaveLength(1);
    expect(await recordVerifiedRouterQuotaCooldown(db, { ...call, retryNotBefore: new Date(deadline.getTime() + 1_000).toISOString(), credentialIdentity: `${grantId}:shared:no-auth` })).toBe(false);
    await db.delete(aiConnectionQuotaCooldowns);
    expect(await recordVerifiedRouterQuotaCooldown(db, { ...call, credentialIdentity: `${randomUUID()}:shared:no-auth` })).toBe(false);
    expect(await recordVerifiedRouterQuotaCooldown(db, { ...call, companyId: randomUUID(), credentialIdentity: `${grantId}:shared:no-auth` })).toBe(false);
    await db.update(heartbeatRuns).set({ contextSnapshot: { aiRouterTaskKey: f.run.id,
      aiRouterSelection: { ...selection, memberId: randomUUID() } } }).where(eq(heartbeatRuns.id, f.run.id));
    expect(await recordVerifiedRouterQuotaCooldown(db, { ...call, credentialIdentity: `${grantId}:shared:no-auth` })).toBe(false);
    await db.update(heartbeatRuns).set({ contextSnapshot: { aiRouterTaskKey: f.run.id, aiRouterSelection: selection } }).where(eq(heartbeatRuns.id, f.run.id));
    await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.sourceEventId, receiptId));
    const now = new Date();
    await expect(db.transaction(async tx => {
      expect(await recordVerifiedRouterQuotaCooldown(tx as unknown as Db, { ...call, retryNotBefore: null, now, credentialIdentity: `${grantId}:shared:no-auth` })).toBe(true);
      throw new Error("rollback attribution");
    })).rejects.toThrow("rollback attribution");
    expect(await receipts()).toEqual([]);
    expect(await db.select().from(aiConnectionQuotaCooldowns)).toEqual([]);
    expect(await recordVerifiedRouterQuotaCooldown(db, { ...call, retryNotBefore: null, now, credentialIdentity: `${grantId}:shared:no-auth` })).toBe(true);
    expect((await db.select().from(aiConnectionQuotaCooldowns))[0]!.retryAt).toEqual(new Date(now.getTime() + 2 * 60 * 60_000));
    const distant = new Date(now.getTime() + 30 * 24 * 60 * 60_000);
    await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.sourceEventId, receiptId));
    expect(await recordVerifiedRouterQuotaCooldown(db, { ...call, retryNotBefore: distant.toISOString(), now, credentialIdentity: `${grantId}:shared:no-auth` })).toBe(true);
    expect((await db.select().from(aiConnectionQuotaCooldowns))[0]!.retryAt).toEqual(distant);
    const oldLimit = new Date(now.getTime() + 2 * 60 * 60_000);
    await db.insert(heartbeatRuns).values({ companyId: f.run.companyId, agentId: f.run.agentId, status: "failed",
      startedAt: now, finishedAt: now, errorCode: "provider_quota", resultJson: { retryNotBefore: oldLimit.toISOString() } });
    const startup = { db, binding: { runId: f.run.id, companyId: f.run.companyId, agentId: f.run.agentId },
      attempt: 1, retryable: true, failure: null, now };
    expect((await planNativeStartupRetry({ ...startup, managedAiAccountIdentity: `${grantId}:shared:no-auth` })).providerCooldownAt).toEqual(distant);
    await db.delete(aiConnectionQuotaCooldowns);
    expect((await planNativeStartupRetry({ ...startup, managedAiAccountIdentity: `${grantId}:shared:no-auth` })).providerCooldownAt).toBeNull();
    expect((await planNativeStartupRetry({ ...startup, managedAiAccountIdentity: `${randomUUID()}:shared:no-auth` })).providerCooldownAt).toEqual(oldLimit);
    await db.update(aiConnectionTaskPins).set({ taskKey: "other" }).where(eq(aiConnectionTaskPins.id, (await db.select().from(aiConnectionTaskPins))[0]!.id));
    expect(await recordVerifiedRouterQuotaCooldown(db, { ...call, credentialIdentity: `${grantId}:shared:no-auth` })).toBe(false);
    expect(await db.select().from(aiConnectionQuotaCooldowns)).toEqual([]);
    await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.sourceEventId, receiptId));
    const [issue] = await db.insert(issues).values({ companyId: f.run.companyId, title: "Quota task", identifier: "CMP-42" }).returning();
    await db.update(heartbeatRuns).set({ scopeKind: "issue", issueId: issue.id,
      contextSnapshot: { aiRouterTaskKey: issue.identifier, aiRouterSelection: selection } }).where(eq(heartbeatRuns.id, f.run.id));
    await db.update(aiConnectionTaskPins).set({ taskKey: issue.identifier! }).where(eq(aiConnectionTaskPins.agentId, f.agent.id));
    expect(await recordVerifiedRouterQuotaCooldown(db, { ...call, credentialIdentity: `${grantId}:shared:no-auth` }), "issue identifier").toBe(true);
    await db.delete(aiConnectionQuotaCooldowns);
    const [timerRun] = await db.insert(heartbeatRuns).values({ companyId: f.run.companyId, agentId: f.agent.id,
      status: "failed", errorCode: "provider_quota", invocationSource: "timer",
      contextSnapshot: { aiRouterTaskKey: "__heartbeat__", aiRouterSelection: selection, wakeSource: "timer" } }).returning();
    await db.update(aiConnectionTaskPins).set({ taskKey: "__heartbeat__" }).where(eq(aiConnectionTaskPins.agentId, f.agent.id));
    expect(await recordVerifiedRouterQuotaCooldown(db, { ...call, runId: timerRun.id, credentialIdentity: `${grantId}:shared:no-auth` }), "timer task").toBe(true);
    await db.delete(aiConnectionQuotaCooldowns);
    await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, timerRun.id));
    const nativeFailure = { schema: "paperclip.provider-failure.v1", provider: "openai", phase: "turn",
      category: "rate_limit", message: "limit", retryability: "unknown", httpStatus: 429 };
    await db.update(heartbeatRuns).set({ errorCode: "native_provider_usage_limit", resultJson: { providerFailure: nativeFailure } }).where(eq(heartbeatRuns.id, timerRun.id));
    expect(await recordVerifiedRouterQuotaCooldown(db, { ...call, runId: timerRun.id, credentialIdentity: `${grantId}:shared:no-auth` })).toBe(false);
    await db.update(heartbeatRuns).set({ resultJson: { providerFailure: { ...nativeFailure, category: "quota_exhausted" } } }).where(eq(heartbeatRuns.id, timerRun.id));
    expect(await recordVerifiedRouterQuotaCooldown(db, { ...call, runId: timerRun.id, credentialIdentity: `${grantId}:shared:no-auth` })).toBe(true);
  });

  it("replays saved user intent through normal Retry after a first-attempt retained runner failure", async () => {
    for (const mode of ["unattached", "archive_failed", "provider_started", "system_wake", "stopped", "stopped_failed", "promoted"] as const) {
      const f = await fixture({ runtimeMode: mode === "promoted" ? "legacy" : "native" }, `CMP${randomUUID().slice(0, 6)}`);
      const failureMessage = mode === "archive_failed"
        ? "runner_continuity_break_archive_failed: exit=1 timedOut=false mv: cannot remove 'runner': Directory not empty"
        : "runner_remote_process_identity_unavailable";
      const retryExpected = mode === "unattached" || mode === "archive_failed" || mode === "promoted";
      const [issue] = await db.insert(issues).values({ companyId: f.run.companyId, title: "Continue saved work",
        assigneeAgentId: f.agent.id, status: "in_progress" }).returning();
      const [comment] = await db.insert(issueComments).values({ companyId: f.run.companyId, issueId: issue.id,
        authorType: "user", authorUserId: "local-board", body: "Please finish the saved change." }).returning();
      await db.update(agentWakeupRequests).set({ runId: f.run.id, reason: "issue_reopened_via_comment",
        requestedByActorType: mode === "system_wake" ? "system" : "user", requestedByActorId: "local-board",
        payload: { issueId: issue.id, commentId: comment.id } }).where(eq(agentWakeupRequests.id, f.wake.id));
      const [run] = await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issue.id, responsibleUserId: "local-board",
        contextSnapshot: { issueId: issue.id, wakeReason: "issue_reopened_via_comment", wakeCommentId: comment.id } })
        .where(eq(heartbeatRuns.id, f.run.id)).returning();
      await db.insert(nativeRunFinalizations).values({ companyId: run.companyId, issueId: issue.id, runId: run.id,
        phase: "terminal_failure", failureCode: nativeSessionFailureSourceCode(new Error(failureMessage)) });
      if (mode === "provider_started") await appendHeartbeatRunEvent(db, { companyId: run.companyId, runId: run.id,
        agentId: run.agentId, eventType: "turn.started", stream: "system", level: "info", message: "Provider started" });
      if (mode === "stopped_failed") await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(),
        error: failureMessage, errorCode: nativeSessionFailureSourceCode(new Error(failureMessage)) }).where(eq(heartbeatRuns.id, run.id));
      if (mode === "stopped" || mode === "stopped_failed") f.controller.abort();
      const observedRun = mode === "promoted" ? { ...run, runtimeMode: f.run.runtimeMode } : run;
      await f.completion.failRun({ ...f.failure(new Error(failureMessage)), run: observedRun,
        issueId: issue.id, requiredWorkspaceRestoreEvidence: {}, legacyAdapterEntered: false });
      const requests = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, run.companyId),
        eq(agentWakeupRequests.reason, "task_retry")));
      expect.soft(requests, mode).toHaveLength(retryExpected ? 1 : 0);
      if (retryExpected && requests[0]) expect(requests[0]).toMatchObject({ status: "deferred_issue_execution",
        requestedByActorType: "user", requestedByActorId: "local-board", payload: { taskRetry: { sourceRunId: run.id } } });
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it.each(["ordinary", "stalled append", "object admission"] as const)("finishes accepted output before ordinary lease teardown without writing to a retired recorder (%s)", async mode => {
    const stalledAppend = mode === "stalled append", stalledAdmission = mode === "object admission";
    const f = await fixture({ runtimeMode: "native",
      resultJson: { durable: "accepted result" } });
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "diagnostic-completion-")));
    onTestFinished(() => rm(workspace, { recursive: true, force: true }));
    let holdUploads = false, uploadEntered = false, finalizeEntered = false;
    let releaseUpload!: () => void;
    const uploadGate = new Promise<void>(resolve => { releaseUpload = resolve; });
    const store = stalledAppend ? createDurableRunLogStore({ basePath: join(workspace, "run-logs") }) : objectLogFixture(async input => {
      if (stalledAdmission && holdUploads && input.objectKey.includes("/objects/")) {
        uploadEntered = true;
        await uploadGate;
      }
    });
    let latestOutputSeq = 0, admittedBytes = 0;
    const diagnosticAdmissions: Array<{ chunk: string; admitted?: boolean; error?: string }> = [];
    if (store.enqueue) {
      const originalEnqueue = store.enqueue.bind(store);
      vi.spyOn(store, "enqueue").mockImplementation(async (handle, event) => {
        latestOutputSeq = event.seq ?? latestOutputSeq;
        const observation = event.chunk.includes("runnerd diagnostic") ? { chunk: event.chunk } as typeof diagnosticAdmissions[number] : undefined;
        if (observation) diagnosticAdmissions.push(observation);
        let receipt;
        try { receipt = await originalEnqueue(handle, event); if (observation) observation.admitted = true; }
        catch (error) { if (observation) observation.error = error instanceof Error ? error.message : String(error); throw error; }
        if (holdUploads) admittedBytes += Buffer.byteLength(JSON.stringify({ ts: event.ts,
          attemptId: handle.attemptId, stream: event.stream, chunk: event.chunk, seq: event.seq }) + "\n");
        return receipt;
      });
    }
    const originalFinalize = store.finalize.bind(store);
    vi.spyOn(store, "finalize").mockImplementation((...args) => {
      finalizeEntered = true;
      return originalFinalize(...args);
    });
    const readLog = async () => {
      let content = "", offset = 0;
      do {
        const page = await store.read(output.handle!, { offset, limitBytes: 4 * 1024 * 1024 });
        content += page.content;
        if (page.nextOffset === undefined) break;
        offset = page.nextOffset;
      } while (true);
      return { content };
    };
    let releaseAppend!: () => void, observeAppend!: () => void;
    const appendGate = new Promise<void>(resolve => { releaseAppend = resolve; });
    const appendStarted = new Promise<void>(resolve => { observeAppend = resolve; });
    const originalAppend = fs.appendFile.bind(fs);
    const append = vi.spyOn(fs, "appendFile").mockImplementation(async (...args) => {
      if (stalledAppend && String(args[1]).includes("runnerd diagnostic")) { observeAppend(); await appendGate; }
      return originalAppend(...args);
    });
    const warning = vi.spyOn(console, "warn");
    onTestFinished(() => { releaseAppend(); append.mockRestore(); warning.mockRestore(); });
    const output = createHeartbeatRunOutput(db, { run: f.run, runId: f.run.id, issueId: null, runLogStore: store,
      identityRedactor: { chunk: (_stream, chunk) => chunk, redact: value => value }, secretKeys: new Set(),
      appendRunEvent: f.deps.appendRunEvent, getCurrentUserRedactionOptions: async () => ({ enabled: false }) });
    const handlers = await output.begin(f.run);
    await handlers.onLog("stdout", "accepted output for this exact run\n");
    const { execution, issue } = await admitNativeExecution(f);
    await db.update(issues).set({ assigneeAgentId: f.run.agentId, executionRunId: f.run.id, status: "in_progress" }).where(eq(issues.id, issue.id));
    vi.stubEnv("PAPERCLIP_HOME", join(workspace, "synthetic-controller-home"));
    onTestFinished(() => { vi.unstubAllEnvs(); });
    execution.workspace.cwd = workspace;
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: execution } }).where(eq(heartbeatRuns.id, f.run.id));
    Object.assign(execution.session, { lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60000 } });
    await db.insert(nativeRunFinalizations).values({ runId: f.run.id, companyId: f.run.companyId, issueId: issue.id, phase: "observed" });
    const api = createServer((_req, response) => { response.writeHead(404).end(); });
    registerLocalRuntimeApiServer(api);
    await new Promise<void>((resolve, reject) => { api.once("error", reject); api.listen(0, "127.0.0.1", resolve); });
    onTestFinished(() => new Promise<void>(resolve => api.close(() => resolve())));
    diagnosticNativeFixture.enabled = true;
    diagnosticNativeFixture.retireWarm = stalledAppend || stalledAdmission;
    if (stalledAdmission) diagnosticNativeFixture.beforeWarmClose = async () => {
      await store.flush!(output.handle!);
      holdUploads = true;
      const target = 8 * 1024 * 1024 - 1;
      while (admittedBytes < target) {
        const overhead = Buffer.byteLength(JSON.stringify({ ts: new Date().toISOString(),
          attemptId: output.handle!.attemptId, stream: "stdout", chunk: "", seq: latestOutputSeq + 1 }) + "\n");
        const chunk = "x".repeat(Math.min(64 * 1024, target - admittedBytes - overhead));
        await handlers.onLog("stdout", chunk);
      }
      expect(admittedBytes).toBe(target);
      expect(uploadEntered).toBe(true);
    };
    let completed = false;
    const diagnosticWrites: Promise<void>[] = [];
    const finishing = (async () => {
      const event: PrpEvent = { schema: "paperclip.prp.event.v1", schemaVersion: 1,
        sourceInstanceId: randomUUID(), sourceEventId: randomUUID(), sourceSeq: 1, sourceKind: "runner",
        runId: f.run.id, normalizedSessionId: execution.session.normalizedSessionId,
        eventType: "item.delta", priority: 2, emittedAt: new Date().toISOString(), payload: { text: "canonical accepted output 再開" } };
      const persisted = await appendHeartbeatRunEvent(db, { companyId: f.run.companyId, runId: f.run.id,
        agentId: f.run.agentId, eventType: event.eventType, payload: { prpEvent: event },
        nativeSource: { sourceInstanceId: event.sourceInstanceId, sourceEventId: event.sourceEventId,
          sourceSeq: event.sourceSeq, protocolSchemaVersion: 1, canonicalPayload: event as unknown as Record<string, unknown> } });
      if (!stalledAppend) await handlers.onPersistedNativeLog!(persisted.row.seq, formatNativeRunLogEvent(event));
      const adapter = await executePaperclipNativeSession({ db, execution: execution as never,
        runnerInstanceId: "synthetic-controller", useRunnerd: true, onLog: (stream, chunk) => {
          const write = handlers.onLog(stream, chunk);
          if (chunk.includes("runnerd diagnostic")) diagnosticWrites.push(write);
          return write;
        },
        runnerEnvironment: { HOME: workspace, CODEX_HOME: join(workspace, "synthetic-codex-home") } });
      await db.update(heartbeatRuns).set({ status: "succeeded", nativePhase: "committed", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.run.id));
      Object.assign(f.run, await read(f.run.id));
      f.agent.adapterType = "paperclip_runner";
      f.input.sessionCodec = getAdapterSessionCodec(f.agent.adapterType);
      f.input.adapterResult = adapter;
      const completionDeps: Dependencies = { ...f.deps, runLogStore: store };
      f.input.output = output;
      f.input.onLog = handlers.onLog;
      await createHeartbeatRunCompletion(db, completionDeps).completeRun(f.input);
      completed = true;
      return { persisted, event };
    })();
    void finishing.catch(() => undefined);
    try {
      if (stalledAdmission) {
        await vi.waitFor(() => expect(finalizeEntered).toBe(true), { timeout: 10_000 });
        expect(diagnosticWrites.length).toBeGreaterThan(0);
        releaseUpload();
      }
      if (stalledAppend) {
        await appendStarted;
        await vi.waitFor(() => expect(completed).toBe(true), { timeout: 10_000 });
      }
      const { persisted, event } = await finishing;
      const before = await readLog();
      expect(before.content).toContain("accepted output for this exact run");
      const settled = await read(f.run.id);
      expect(settled).toMatchObject({ companyId: f.run.companyId, status: "succeeded", resultJson: { durable: "accepted result" } });
      expect(settled).toMatchObject({ costAccountingPending: true, costAccountedAt: null, usageJson: { accountingReceiptReady: false } });
      expect(f.deps.releaseIssueExecutionAndPromote).toHaveBeenCalledWith(expect.objectContaining({ id: f.run.id }), expect.any(Object));
      if (stalledAppend) {
        expect(settled).toMatchObject({ logBytes: null, logSha256: null });
        expect(warning).toHaveBeenCalledWith(expect.stringContaining("final log size and hash are unknown"));
      } else {
        const chunks = before.content.trimEnd().split("\n").map(line => JSON.parse(line).chunk);
        expect(chunks).toContain(formatNativeRunLogEvent(event));
        expect(settled).toMatchObject({ logBytes: Buffer.byteLength(before.content),
          logSha256: createHash("sha256").update(before.content).digest("hex") });
      }
      const deps = controlCallbacks(db);
      deps.options.closeWarmNativeSessionsForRun.mockImplementation(async ({ runId }) => {
        expect(runId).toBe(f.run.id);
        await closeIdleWarmNativeSessionsForRestart();
        return { closed: 1, busy: 0, failed: 0 };
      });
      await createHeartbeatRunControl(db, deps).releaseEnvironmentLeasesForRun({ runId: f.run.id, companyId: f.run.companyId,
        agentId: f.run.agentId, status: "succeeded", providerResourceDisposition: "destroy" });
      expect(deps.options.closeWarmNativeSessionsForRun).toHaveBeenCalledOnce();
      const after = await readLog();
      expect(after.content).toBe(before.content);
      if (!stalledAppend) {
        const coverage = createNativeRunLogCoverageVerifier(db, f.run.companyId, f.run.id, { redactChunks: chunk => [chunk] });
        await coverage.write(Buffer.from(after.content));
        expect(await coverage.finish()).toBe(persisted.row.seq);
      }
      if (stalledAdmission) {
        await Promise.allSettled(diagnosticWrites);
        expect(diagnosticAdmissions.length).toBeGreaterThan(0);
        const storedChunks = before.content.trimEnd().split("\n").map(line => JSON.parse(line).chunk);
        for (const admission of diagnosticAdmissions) {
          expect(admission).toMatchObject({ admitted: true });
          expect(admission.error).toBeUndefined();
          expect(storedChunks).toContain(admission.chunk);
        }
      }
      const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.run.id));
      expect(events.filter(event => (event.payload as { reason?: string } | null)?.reason === "object_log_persistence_failed")).toEqual([]);
    } finally {
      releaseAppend();
      releaseUpload();
      await Promise.allSettled(diagnosticWrites);
      await finishing;
      if (stalledAppend) expect(await read(f.run.id)).toMatchObject({ logBytes: null, logSha256: null });
      await closeIdleWarmNativeSessionsForRestart();
      diagnosticNativeFixture.enabled = false;
      diagnosticNativeFixture.retireWarm = false;
      diagnosticNativeFixture.beforeWarmClose = undefined;
    }
  });

  async function admitNativeExecution(f: Awaited<ReturnType<typeof fixture>>) {
    await db.update(agents).set({ adapterType: "paperclip_runner" }).where(eq(agents.id, f.agent.id));
    const [issue] = await db.insert(issues).values({ companyId: f.run.companyId, title: "Interrupted native task" }).returning();
    await db.update(heartbeatRuns).set({ nativeIssueId: issue.id, issueId: issue.id,
      contextSnapshot: { issueId: issue.id } }).where(eq(heartbeatRuns.id, f.run.id));
    Object.assign(f.run, await read(f.run.id));
    const native = await prepareNativeHeartbeatRun({ db, run: f.run, issue, environmentLeaseId: randomUUID() });
    const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issue.id));
    const binding = { companyId: f.run.companyId, runId: f.run.id, issueId: issue.id, agentId: f.agent.id, executionWorkspaceId: f.run.id };
    const execution = { schema: "paperclip.native-execution-input.v1", binding,
      provider: { kind: "codex", model: "test-model" },
      task: { identifier: issue.id, title: issue.title, description: null, prompt: "Complete the task.", workMode: "standard" },
      workspace: { cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: native.normalizedSessionId, driverKind: "codex_app_server", protocolVersion: 1,
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      completionContract: { id: contract.id, sha256: contract.canonicalSha256, schemaVersion: "paperclip.completion-contract.v1",
        contract: buildNativeCompletionContract(issue, { revision: contract.revision }) },
      interactionResponses: [], credentialBindings: [] };
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: execution } }).where(eq(heartbeatRuns.id, f.run.id));
    return { issue, native, binding, execution };
  }

  it.each(["completeRun", "failRun"] as const)("settles the outgoing agent after a case handoff in %s", async operation => {
    const f = await fixture();
    await db.update(agents).set({ status: "running", lifecycleState: "ready" }).where(eq(agents.id, f.agent.id));
    const [recipient] = await db.insert(agents).values({ companyId: f.agent.companyId, name: "Next phase", adapterType: "process" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: f.agent.companyId, title: "Case task", status: "in_progress", assigneeAgentId: f.agent.id }).returning();
    const [record] = await db.insert(cases).values({ companyId: f.agent.companyId, caseNumber: 1, identifier: "CASE-1", caseType: "work", title: issue.title, workIssueId: issue.id, handoffVersion: 1 }).returning();
    await db.insert(caseHandoffs).values({ companyId: f.agent.companyId, caseId: record.id, issueId: issue.id, version: 1,
      fromAgentId: f.agent.id, toAgentId: recipient.id, phase: "verification", instructions: "Verify the saved work",
      actorType: "agent", actorId: f.agent.id, sourceRunId: f.run.id, wakeupRequestId: randomUUID(), idempotencyKey: "next-phase", inputFingerprint: "next-phase", state: "awaiting_release" });
    f.input.issueId = issue.id;
    f.input.issueRef = issue;
    f.deps.finalizeAgentStatus.mockImplementation(createHeartbeatAgentStatus(db).finalizeAgentStatus);

    if (operation === "completeRun") await f.completion.completeRun(f.input);
    else await f.completion.failRun(f.failure(new Error("Provider exited after the accepted handoff")));

    const [settledAgent] = await db.select().from(agents).where(eq(agents.id, f.agent.id));
    expect(settledAgent).toMatchObject({ status: operation === "completeRun" ? "idle" : "error", lastHeartbeatAt: expect.any(Date) });
    expect(f.deps.finalizeAgentStatus).toHaveBeenCalledOnce();
    expect(f.deps.releaseIssueExecutionAndPromote).toHaveBeenCalledWith(expect.objectContaining({ id: f.run.id }), { suppressImmediateRecovery: true });
    expect(f.deps.handleSuccessfulRunHandoff).not.toHaveBeenCalled();
    expect(f.deps.scheduleBoundedRetryForRun).not.toHaveBeenCalled();
    expect((await db.select().from(issues).where(eq(issues.id, issue.id)))[0]?.status).toBe("in_progress");
  });

  it.each([false, true])("uses only host-authored execution settlement metadata (trusted=%s)", async trusted => {
    const f = await fixture({ runtimeMode: "legacy" });
    const settlement = { providerStopped: true as const, workspaceSettled: true as const, actionOutcomes: "unknown" as const };
    f.input.adapterResult = { exitCode: 1, signal: null, timedOut: false, errorCode: "provider_quota",
      resultJson: { executionSettlement: settlement, executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      ...(trusted ? { executionSettlement: settlement } : {}) };
    await f.completion.completeRun(f.input);
    const saved = await read(f.run.id);
    expect(saved?.resultJson?.executionSettlement).toEqual(trusted ? settlement : undefined);
    expect(saved?.resultJson?.executionRecovery).toBeUndefined();
  });

  it("persists usage, accounting, final logs, presentation and the next task session", async () => {
    const f = await fixture();
    await f.completion.completeRun(f.input);
    expect(await read(f.run.id)).toMatchObject({ status: "succeeded", sessionIdAfter: "provider-session", logBytes: 123, logSha256: "log-hash", logCompressed: true, stdoutExcerpt: "answer", costAccountingPending: false, costAccountedAt: expect.any(Date), usageJson: { inputTokens: 20, cachedInputTokens: 5, outputTokens: 8, usageSource: "per_run", configFreshness: { version: 1 } }, resultJson: { presentationDecision: { commentAction: "none" } } });
    expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, f.run.id))).toHaveLength(1);
    expect((await f.deps.getTaskSession(f.agent.companyId, f.agent.id, f.agent.adapterType, "completion-task"))?.sessionDisplayId).toBe("provider-session");
    expect(f.input.output.outputProgressState.pending?.bytes).toBe(123);
    expect(f.input.onProviderTraceFinalized).toHaveBeenCalledOnce();
    expect(f.deps.setWakeupStatus).toHaveBeenCalledWith(f.wake.id, "completed", expect.any(Object));
    expect(f.deps.releaseIssueExecutionAndPromote).toHaveBeenCalledOnce();
    expect(f.deps.finalizeAgentStatus).toHaveBeenCalledWith(f.agent.id, "succeeded", null, expect.any(Object));
  });

  it("settles the accepted native exact rate-card price without replacing it with zero", async () => {
    const f = await fixture({ runtimeMode: "native" });
    const runnerInstanceId = randomUUID();
    const delivery = await createNativeUsageDelivery(db, { companyId: f.run.companyId, runId: f.run.id, runnerInstanceId,
      provider: { kind: "codex", model: "gpt-6.1-sol" }, billing: { provider: "openai", biller: "openai", billingType: "metered_api" } });
    const event = (sourceSeq: number, eventType: string, payload: Record<string, unknown>): PrpEvent => ({
      sourceKind: "runner", sourceInstanceId: runnerInstanceId, runId: f.run.id, sourceSeq, sourceEventId: `rate-card-${sourceSeq}`,
      turnId: "price-turn", eventType, emittedAt: new Date().toISOString(), payload,
    } as PrpEvent);
    await delivery.capture(event(1, "usage.reported", { runDeltaBasis: "run", runDeltaAvailable: true,
      runDelta: { inputTokens: 1000, outputTokens: 100000, providerCostUsd: 0 } }));
    await delivery.capture(event(2, "turn.completed", {}));
    const accepted = await usageReceipts.readAcceptedRunUsageCheckpoint(db, { companyId: f.run.companyId, runId: f.run.id });
    expect(accepted?.costStatus).toBe("estimated");
    const exact = accepted!.costUsdExact;
    f.input.adapterResult = { exitCode: 0, signal: null, timedOut: false, ...accepted, usageComplete: accepted!.complete };
    await f.completion.completeRun(f.input);
    const saved = await read(f.run.id);
    expect(saved).toMatchObject({ status: "succeeded", costAccountingPending: false, costAccountedAt: expect.any(Date),
      usageJson: { costUsdExact: exact, costStatus: "estimated" } });
    const ledger = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, f.run.id));
    expect(ledger).toHaveLength(1);
    expect(ledger[0].costCents).toBe(100.2);
  });

  it("retains newer accepted native usage when completion consumed an older receipt", async () => {
    const f = await fixture({ runtimeMode: "native", usageJson: { sessionRotated: true, configFreshness: { version: 0 } } });
    const runnerInstanceId = randomUUID();
    const delivery = await createNativeUsageDelivery(db, { companyId: f.run.companyId, runId: f.run.id, runnerInstanceId,
      provider: { kind: "codex", model: "test-model" }, billing: { provider: "openai", biller: "openai", billingType: "metered_api" } });
    const event = (sourceSeq: number, eventType: string, inputTokens = 100): PrpEvent => ({
      sourceInstanceId: runnerInstanceId, runId: f.run.id, sourceSeq, sourceEventId: `racing-${sourceSeq}`, turnId: "turn-1",
      emittedAt: new Date().toISOString(), eventType, payload: eventType === "usage.reported"
        ? { runDeltaBasis: "run", runDeltaAvailable: true, runDelta: { inputTokens, outputTokens: 10, providerCostUsd: inputTokens / 1000 } } : {},
    } as PrpEvent);
    await delivery.capture(event(1, "usage.reported"));
    await delivery.capture(event(2, "turn.completed"));
    const acceptedA = await usageReceipts.readAcceptedRunUsageCheckpoint(db, { companyId: f.run.companyId, runId: f.run.id });
    await delivery.capture(event(3, "usage.reported", 120));
    f.input.adapterResult = { exitCode: 0, signal: null, timedOut: false, ...acceptedA, usageComplete: acceptedA!.complete };
    await f.completion.completeRun(f.input);
    expect(await read(f.run.id)).toMatchObject({ status: "succeeded", costAccountingPending: true, costAccountedAt: null,
      usageJson: { inputTokens: 120, costUsd: 0.12, accountingReceiptSequence: 3, accountingReceiptReady: false, sessionRotated: false, configFreshness: { version: 1 } } });
    expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, f.run.id))).toHaveLength(0);
    await delivery.capture(event(4, "turn.completed", 120));
    expect(await (await import("../run-cost-accounting.js")).accountRunCost(db, f.run.id)).toBe(true);
    const ledger = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, f.run.id));
    expect(ledger).toHaveLength(1);
    expect(ledger[0].costCents).toBe(12);
  });

  it.each([
    { timedOut: true, expected: "timed_out", errorCode: "timeout" },
    { signal: "SIGTERM", expected: "failed", errorCode: "adapter_failed" },
    { errorMessage: "provider quota", errorCode: "provider_quota", expected: "failed" },
  ])("keeps adapter outcome classification ($expected, $errorCode)", async ({ expected, ...result }) => {
    const f = await fixture();
    Object.assign(f.input.adapterResult, result);
    await f.completion.completeRun(f.input);
    expect(await read(f.run.id)).toMatchObject({ status: expected, errorCode: result.errorCode });
    expect(f.deps.finalizeAgentStatus).toHaveBeenCalledWith(f.agent.id, expected, expect.any(String), expect.objectContaining({ keepIdleOnFailure: result.errorCode === "provider_quota" }));
  });

  it.each(["completeRun", "failRun"] as const)("waits for an owned Stop before %s can write a competing outcome", async operation => {
    const f = await fixture();
    let settle!: () => void;
    const settled = new Promise<void>(resolve => { settle = resolve; });
    f.deps.processRunCancellationSettlements.set(f.run.id, { settled, failed: false });
    const completion = operation === "completeRun" ? f.completion.completeRun(f.input) : f.completion.failRun(f.failure(new Error("late adapter error")));
    await Promise.resolve();
    expect(f.deps.setRunStatusIfRunning).not.toHaveBeenCalled();
    await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.run.id));
    f.controller.abort();
    settle();
    await completion;
    expect((await read(f.run.id)).status).toBe("cancelled");
    if (operation === "completeRun") {
      expect((await read(f.run.id)).sessionIdAfter).toBe("provider-session");
      expect(f.deps.finalizeAgentStatus).toHaveBeenCalledWith(f.agent.id, "cancelled", expect.any(String), expect.any(Object));
    } else expect(f.deps.finalizeAgentStatus).not.toHaveBeenCalled();
  });

  it("attributes an adapter stop caused by a lost controller lease", async () => {
    const f = await fixture();
    Object.assign(f.input.adapterResult, { exitCode: null, errorCode: "cancelled", errorMessage: "Grok execution was cancelled" });
    f.controller.abort(new LegacyControllerLeaseLostError("renewal_deadline"));
    await f.completion.completeRun(f.input);
    expect(await read(f.run.id)).toMatchObject({ status: "cancelled", resultJson: { cancellation: {
      source: "controller_lease", expected: false, initiator: { type: "system" }, reason: "Legacy controller lease lost (renewal_deadline)" } } });
  });

  it("attributes a lost controller lease when the adapter throws the abort reason", async () => {
    const f = await fixture();
    f.controller.abort(new LegacyControllerLeaseLostError("renewal_rejected"));
    await f.completion.failRun(f.failure(f.controller.signal.reason));
    expect(await read(f.run.id)).toMatchObject({ status: "cancelled", resultJson: {
      workspaceRestoreFailure: { reason: "missing_base" },
      cancellation: { source: "controller_lease", expected: false, reason: "Legacy controller lease lost (renewal_rejected)" } } });
  });

  it("records the watchdog timings with a lease loss that stops the adapter", async () => {
    const f = await fixture();
    Object.assign(f.input.adapterResult, { exitCode: null, errorCode: "cancelled", errorMessage: "Grok execution was cancelled" });
    f.controller.abort(new LegacyControllerLeaseLostError("renewal_deadline",
      { sinceRenewalMs: 61_000, renewalPendingMs: 58_000, deadlineLateMs: 2, renewalCount: 41 }));
    await f.completion.completeRun(f.input);
    expect((await read(f.run.id)).resultJson).toMatchObject({ controllerLeaseLoss: {
      cause: "renewal_deadline", sinceRenewalMs: 61_000, renewalPendingMs: 58_000, deadlineLateMs: 2, renewalCount: 41 } });
  });

  it("records the lease-loss cause and timings when setup fails on the abort reason", async () => {
    const f = await fixture();
    f.controller.abort(new LegacyControllerLeaseLostError("renewal_deadline",
      { sinceRenewalMs: 60_004, renewalPendingMs: null, deadlineLateMs: 55_000, renewalCount: 3 }));
    await f.completion.failRunSetup(f.setup(f.controller.signal.reason));
    expect(await read(f.run.id)).toMatchObject({ status: "failed", errorCode: "controller_lease_lost", resultJson: {
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
      controllerLeaseLoss: { cause: "renewal_deadline", sinceRenewalMs: 60_004, renewalPendingMs: null,
        deadlineLateMs: 55_000, renewalCount: 3 } } });
  });

  it("keeps a stop requested before the lease loss when the adapter throws", async () => {
    const f = await fixture();
    const requested = requestedRunCancellation({ cancelledByActorType: "user", cancelledByUserId: "operator-1" }, "Stopped from the board");
    await db.update(heartbeatRuns).set({ resultJson: { cancellation: requested } }).where(eq(heartbeatRuns.id, f.run.id));
    f.controller.abort(new LegacyControllerLeaseLostError("renewal_error"));
    await f.completion.failRun(f.failure(f.controller.signal.reason));
    expect(await read(f.run.id)).toMatchObject({ status: "cancelled", resultJson: { cancellation: {
      source: "operator", expected: true, initiator: { type: "user", id: "operator-1" }, reason: "Stopped from the board" } } });
  });

  it("does not publish or overwrite a conflicting terminal transition that wins the compare-and-set", async () => {
    const f = await fixture();
    const write = f.deps.setRunStatusIfRunning.getMockImplementation()!;
    f.deps.setRunStatusIfRunning.mockImplementationOnce(async (...args) => {
      await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "cancelled", resultJson: { winner: "Stop" } }).where(eq(heartbeatRuns.id, f.run.id));
      return write(...args);
    });
    await f.completion.completeRun(f.input);
    expect(await read(f.run.id)).toMatchObject({ status: "cancelled", resultJson: { winner: "Stop" }, sessionIdAfter: null });
    expect(f.deps.setWakeupStatus).not.toHaveBeenCalled();
    expect(f.deps.updateRuntimeState).not.toHaveBeenCalled();
    expect(f.deps.releaseIssueExecutionAndPromote).not.toHaveBeenCalled();
    expect(f.deps.finalizeAgentStatus).not.toHaveBeenCalled();
  });

  it("retains native completion metadata when reconciliation already committed the same terminal status", async () => {
    const finishedAt = new Date("2026-10-09T12:00:00Z");
    const f = await fixture({ runtimeMode: "native", status: "succeeded", finishedAt, resultJson: { durable: "accepted" }, usageJson: { durableReceipt: "native" } });
    await db.update(agents).set({ adapterType: "paperclip_runner" }).where(eq(agents.id, f.agent.id));
    f.agent.adapterType = "paperclip_runner";
    f.input.sessionCodec = getAdapterSessionCodec(f.agent.adapterType);
    const nativeSessionId = randomUUID(), providerSessionId = randomUUID();
    f.input.adapterResult.sessionId = nativeSessionId;
    delete f.input.adapterResult.sessionParams;
    f.input.adapterResult.sessionDisplayId = providerSessionId;
    f.input.adapterResult.nativeFinalization = { schema: "paperclip.native-finalization.v1", runtimeMode: "native", runId: f.run.id, companyId: f.run.companyId, issueId: "unused", result: {}, terminal: { schema: "paperclip.prp.terminal.v1", turnTerminalState: "completed", runTerminalState: "succeeded", reportedWorkDisposition: "done" }, turnId: null, sourceInstanceId: "test", normalizedSessionId: nativeSessionId, providerSessionId, driverKind: "test", driverVersion: "1", nativeEventCount: 1, highestContiguousSourceSeq: 1, workspaceFinalizeStatus: "succeeded" };
    await f.completion.completeRun(f.input);
    expect(await read(f.run.id)).toMatchObject({ status: "succeeded", finishedAt, sessionIdAfter: providerSessionId, resultJson: { durable: "accepted" }, usageJson: { durableReceipt: "native", inputTokens: 20 } });
    expect(f.deps.updateRuntimeState).toHaveBeenCalledOnce();
  });

  it("reports trace completion before a later write throws and reads output after log finalization", async () => {
    const f = await fixture();
    let excerpt = "before finalize";
    Object.defineProperty(f.input.output, "stdoutExcerpt", { get: () => excerpt });
    f.deps.runLogStore.finalize.mockImplementationOnce(async () => { excerpt = "last provider output"; return { bytes: 99, compressed: false }; });
    const writeError = new Error("write failed");
    f.deps.setRunStatusIfRunning.mockRejectedValueOnce(writeError);
    await expect(f.completion.completeRun(f.input)).rejects.toBe(writeError);
    expect(f.input.onProviderTraceFinalized).toHaveBeenCalledOnce();
    expect(f.deps.setRunStatusIfRunning).toHaveBeenCalledWith(f.run.id, "succeeded", expect.objectContaining({ stdoutExcerpt: "last provider output", logBytes: 99 }), expect.any(Object));
  });

  it("keeps a failed trace finalization eligible for the executor's cleanup retry", async () => {
    const f = await fixture();
    f.deps.traceStore.finalize.mockRejectedValueOnce(new Error("trace store unavailable"));
    await f.completion.completeRun(f.input);
    expect((await read(f.run.id)).status).toBe("succeeded");
    expect(f.input.onProviderTraceFinalized).not.toHaveBeenCalled();
  });

  it("keeps completion and session persistence moving after a response comment fails", async () => {
    const f = await fixture();
    f.input.adapterResult.resultJson = { finalResponseDisposition: "final", finalResponse: "Completed the work." };
    const [issue] = await db.insert(issues).values({ companyId: f.run.companyId, title: "Report the result" }).returning();
    f.input.issueId = issue.id;
    f.input.issueRef = issue;
    f.input.issueContext = await createHeartbeatRunPreparation(db).getIssueExecutionContext(f.run.companyId, issue.id);
    f.deps.issuesSvc.addComment.mockRejectedValueOnce(new Error("comment unavailable"));
    await f.completion.completeRun(f.input);
    expect(f.deps.issuesSvc.addComment).toHaveBeenCalledOnce();
    expect(f.input.onLog).toHaveBeenCalledWith("stderr", expect.stringContaining("comment unavailable"));
    expect((await read(f.run.id)).status).toBe("succeeded");
    expect(f.deps.upsertTaskSession).toHaveBeenCalledOnce();
    expect(f.deps.releaseIssueExecutionAndPromote).toHaveBeenCalledOnce();
    expect(f.deps.finalizeAgentStatus).toHaveBeenCalledOnce();
  });

  it("clears only the completed task session when the adapter requests a reset", async () => {
    const f = await fixture();
    f.input.adapterResult.clearSession = true;
    await f.completion.completeRun(f.input);
    expect(f.deps.clearTaskSessions).toHaveBeenCalledWith(f.run.companyId, f.agent.id, { taskKey: "completion-task", adapterType: "process", expectedRunId: f.run.id });
    expect(f.deps.upsertTaskSession).not.toHaveBeenCalled();
  });

  it("redacts execution failures, retains restore evidence and resumes the latest checkpoint", async () => {
    const f = await fixture();
    const failure = f.failure(new Error("private-identity-material crashed"));
    failure.goalCheckpointSession.current = { params: { sessionId: "checkpoint" }, displayId: "checkpoint" };
    await f.completion.failRun(failure);
    const run = await read(f.run.id);
    expect(run).toMatchObject({ status: "failed", errorCode: "adapter_failed", logBytes: 123, resultJson: { workspaceRestoreFailure: { reason: "missing_base" } } });
    expect(run.error).not.toContain("private-identity-material");
    expect((await f.deps.getTaskSession(f.agent.companyId, f.agent.id, f.agent.adapterType, "completion-task"))?.sessionDisplayId).toBe("checkpoint");
    expect(f.deps.finalizeAgentStatus).toHaveBeenCalledOnce();
  });

  it.each(["execution", "setup"] as const)("retains a provider startup cause at the outer %s settlement boundary", async phase => {
    const f = await fixture();
    const providerFailure = { schema: "paperclip.provider-failure.v1", provider: "anthropic", phase: "startup",
      category: "rate_limit", message: "This request would exceed your account's rate limit.", httpStatus: 429, retryability: "unknown" };
    const error = Object.assign(new Error("PRP command session.open failed"), {
      runnerCommandResult: { result: { code: "command_execution_failed", providerFailure } },
    });
    f.deps.runLogStore.finalize.mockRejectedValueOnce(new Error("secondary log cleanup failure"));
    if (phase === "setup") await f.completion.failRunSetup(f.setup(error));
    else await f.completion.failRun(f.failure(error));
    expect(await read(f.run.id)).toMatchObject({ status: "failed", error: "PRP command session.open failed",
      resultJson: { providerFailure } });
  });

  it("still records failure and releases issue ownership when log finalization and progress flushing fail", async () => {
    const f = await fixture();
    f.deps.runLogStore.finalize.mockRejectedValueOnce(new Error("log unavailable"));
    f.input.output.flushOutputProgress = vi.fn(async () => { throw new Error("progress unavailable"); });
    await f.completion.failRun(f.failure(new Error("adapter failed")));
    expect((await read(f.run.id)).status).toBe("failed");
    expect(f.deps.releaseIssueExecutionAndPromote).toHaveBeenCalledOnce();
    expect(f.deps.finalizeAgentStatus).toHaveBeenCalledOnce();
  });

  it("keeps durable result-less native failure authoritative and suppresses generic replacement recovery", async () => {
    const f = await fixture({ runtimeMode: "native", status: "failed", errorCode: "native_result_missing" });
    const [issue] = await db.insert(issues).values({ companyId: f.run.companyId, title: "Native recovery" }).returning();
    await db.update(heartbeatRuns).set({ nativeIssueId: issue.id }).where(eq(heartbeatRuns.id, f.run.id));
    await db.insert(nativeRunFinalizations).values({ runId: f.run.id, companyId: f.run.companyId, issueId: issue.id, phase: "terminal_failure", failureCode: "native_result_missing" });
    await f.completion.failRun(f.failure(new Error("transport ended")));
    expect((await read(f.run.id)).errorCode).toBe("native_result_missing");
    expect(f.deps.releaseIssueExecutionAndPromote).toHaveBeenCalledWith(expect.objectContaining({ id: f.run.id }), { suppressImmediateRecovery: true });
  });

  it("persists a project denial without provider work or an automatic retry", async () => {
    const f = await fixture();
    const projectId = randomUUID();
    await f.completion.failRunSetup(f.setup(new ProjectAccessDeniedError(projectId)));
    expect(await read(f.run.id)).toMatchObject({ status: "failed", errorCode: "project_access_denied",
      resultJson: { projectAccessDenied: { projectId }, executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } });
    expect(f.deps.scheduleBoundedRetryForRun).not.toHaveBeenCalled();
    expect(f.deps.enqueueWakeup).not.toHaveBeenCalled();
    expect(f.deps.scheduleInteractionContinuationInfrastructureRetryIfEligible).not.toHaveBeenCalled();
    expect(f.deps.finalizeIssueCommentPolicy).not.toHaveBeenCalled();
  });

  it("records a setup configuration gap without inventing provider work or applying comment policy", async () => {
    const f = await fixture();
    await f.completion.failRunSetup(f.setup(new ConfigurationIncompleteFailure("missing credential", { configurationIncomplete: { reason: "missing_binding" } })));
    expect(await read(f.run.id)).toMatchObject({ status: "failed", errorCode: "configuration_incomplete", resultJson: { configurationIncomplete: { reason: "missing_binding" }, executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } });
    expect(f.deps.finalizeIssueCommentPolicy).not.toHaveBeenCalled();
    expect(f.deps.releaseIssueExecutionAndPromote).toHaveBeenCalledOnce();
    expect(f.deps.finalizeAgentStatus).toHaveBeenCalledOnce();
  });

  it.each(["current", "stale_snapshot", "stale_profile", "prior_attempt_only", "concurrent_ack", "handoff_ack"] as const)("retains an existing native Stop and receipt debt when recovery configuration fails (%s)", async mode => {
    const f = await fixture({ runtimeMode: "native", costAccountingPending: true,
      usageJson: { accountingReceiptReady: false, accountingReceiptSequence: 0 } });
    const { issue, native, binding, execution } = await admitNativeExecution(f);
    const intentAuditId = randomUUID();
    await db.insert(activityLog).values({ id: intentAuditId, companyId: f.run.companyId, actorType: "user", actorId: "test-board",
      action: "native.cancellation_intent_recorded", entityType: "heartbeat_run", entityId: f.run.id, runId: f.run.id, agentId: f.agent.id });
    const nativeCancellation = { schema: "paperclip.native-cancellation.v1", ...binding, scope: "run", reasonCode: "cancellation_run_only",
      intentId: `native-cancellation:${randomUUID()}`, intentAuditId, dispatchState: "pending", dispatched: false, effects: ["release_run_resources"] };
    await db.insert(nativeRunFinalizations).values({ runId: f.run.id, companyId: f.run.companyId, issueId: issue.id, phase: "observed", attempt: 1 });
    await reserveRunBudget(db, f.run.companyId, f.run.id, null);
    await db.update(budgetReservations).set({ providerStartedAt: new Date() }).where(eq(budgetReservations.runId, f.run.id));
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: execution,
      ...(mode === "prior_attempt_only" ? {} : { sessionCheckpoint: { identity: { ...binding, sessionId: native.normalizedSessionId }, providerSessionId: "existing-provider-session", activeTurnId: native.turnId } }) },
      resultJson: { oldNonControlField: "replace this stale projection", nativeCancellation, startupCancellation: { requestedAt: new Date().toISOString(), beforeNativeSelection: false },
        ...(mode === "handoff_ack" ? { reassignmentStopRequested: true } : {}),
        executionCancellation: { state: "requested", requestedAt: new Date().toISOString() } } }).where(eq(heartbeatRuns.id, f.run.id));
    Object.assign(f.run, await read(f.run.id));
    expect(await readPendingNativeRunStop(db, f.run)).toBe(true);
    const setup = f.setup(new ConfigurationIncompleteFailure("The AI account changed while suspended.", {
      configurationIncomplete: { reason: "ai_connection_changed" } }));
    if (mode === "stale_snapshot") setup.run = { ...setup.run, resultJson: {} };
    if (mode === "stale_profile" || mode === "prior_attempt_only") setup.run = { ...setup.run, runnerProfileJson: {} };
    let expectedCancellation: Record<string, unknown> = nativeCancellation;
    const acknowledged = mode === "concurrent_ack" || mode === "handoff_ack";
    if (acknowledged) {
      const acknowledgementAuditId = randomUUID();
      await db.insert(activityLog).values({ id: acknowledgementAuditId, companyId: f.run.companyId, actorType: "system", actorId: "native-session-cancellation",
        action: "native.cancellation_dispatch_acknowledged", entityType: "heartbeat_run", entityId: f.run.id, runId: f.run.id, agentId: f.agent.id });
      expectedCancellation = { ...nativeCancellation, dispatchState: "acknowledged", dispatched: true, acknowledgementAuditId };
      let enter!: () => void, release!: () => void, blockerPid = 0;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const released = new Promise<void>(resolve => { release = resolve; });
      const writer = db.transaction(async tx => {
        const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        blockerPid = backend.pid;
        const [current] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)).for("update");
        enter(); await released;
        const [committed] = await tx.update(heartbeatRuns).set({ resultJson: { ...current.resultJson, nativeCancellation: expectedCancellation } })
          .where(eq(heartbeatRuns.id, f.run.id)).returning();
        expect(hasAcknowledgedNativeReassignmentStopIntent(committed)).toBe(mode === "handoff_ack");
      });
      await entered;
      const failure = f.completion.failRunSetup(setup);
      try {
        await vi.waitFor(async () => {
          const waiting = await db.execute(sql`select pid from pg_stat_activity
            where ${blockerPid} = any(pg_blocking_pids(pid)) and wait_event_type = 'Lock'`);
          expect(waiting.length).toBeGreaterThan(0);
        }, { timeout: 5_000 });
      } finally { release(); await writer; await failure; }
    } else await f.completion.failRunSetup(setup);
    const failed = await read(f.run.id);
    expect(failed).toMatchObject({ status: "failed", errorCode: "configuration_incomplete" });
    expect.soft(failed.resultJson?.nativeCancellation).toEqual(expectedCancellation);
    expect.soft(await readPendingNativeRunStop(db, failed)).toBe(!acknowledged);
    expect.soft(hasAcknowledgedNativeReassignmentStopIntent(failed)).toBe(mode === "handoff_ack");
    expect(failed.resultJson).not.toHaveProperty("oldNonControlField");
    expect.soft((failed.resultJson?.executionRecovery as Record<string, unknown> | undefined)?.providerWorkStarted).not.toBe(false);
    expect.soft(await (await import("../run-cost-accounting.js")).accountRunCost(db, f.run.id)).toBe(false);
    expect.soft(await read(f.run.id)).toMatchObject({ costAccountingPending: true, costAccountedAt: null,
      usageJson: { accountingReceiptReady: false, accountingReceiptSequence: 0 } });
    const [hold] = await db.select().from(budgetReservations).where(eq(budgetReservations.runId, f.run.id));
    expect.soft(hold).toMatchObject({ state: "held", settledAt: null });
    expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, f.run.id))).toHaveLength(0);
  }, 30_000);

  it.each([
    { runtimeMode: "native", providerDispatchStarted: false },
    { runtimeMode: "legacy", providerDispatchStarted: false },
    { runtimeMode: "native", providerDispatchStarted: true },
    { runtimeMode: "legacy", providerDispatchStarted: true },
  ] as const)("settles only a genuinely pre-provider setup failure ($runtimeMode, dispatched=$providerDispatchStarted)", async ({ runtimeMode, providerDispatchStarted }) => {
    const f = await fixture({ runtimeMode, costAccountingPending: true,
      usageJson: { accountingReceiptReady: false, accountingReceiptSequence: 0 } });
    await reserveRunBudget(db, f.run.companyId, f.run.id, null);
    if (providerDispatchStarted) await db.update(budgetReservations).set({ providerStartedAt: new Date() }).where(eq(budgetReservations.runId, f.run.id));
    await f.completion.failRunSetup(f.setup(new ConfigurationIncompleteFailure("missing credential", {
      configurationIncomplete: { reason: "missing_binding" } }), providerDispatchStarted));
    expect(await (await import("../run-cost-accounting.js")).accountRunCost(db, f.run.id)).toBe(!providerDispatchStarted);
    expect(await read(f.run.id)).toMatchObject({ costAccountingPending: providerDispatchStarted,
      costAccountedAt: providerDispatchStarted ? null : expect.any(Date) });
    const [hold] = await db.select().from(budgetReservations).where(eq(budgetReservations.runId, f.run.id));
    expect(hold.state).toBe(providerDispatchStarted ? "held" : "released");
    expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, f.run.id))).toHaveLength(0);
  });

  it.each(["run", "company", "issue", "task_scope"] as const)("does not preserve a foreign or task-scoped cancellation projection (%s)", async mismatch => {
    const f = await fixture({ runtimeMode: "native" });
    const [issue] = await db.insert(issues).values({ companyId: f.run.companyId, title: "Scoped metadata" }).returning();
    const nativeCancellation = { schema: "paperclip.native-cancellation.v1", scope: mismatch === "task_scope" ? "issue" : "run",
      reasonCode: "cancellation_run_only", runId: mismatch === "run" ? randomUUID() : f.run.id,
      companyId: mismatch === "company" ? randomUUID() : f.run.companyId, issueId: mismatch === "issue" ? randomUUID() : issue.id,
      dispatchState: "pending", dispatched: false };
    await db.update(heartbeatRuns).set({ nativeIssueId: issue.id, resultJson: { nativeCancellation, oldNonControlField: true } })
      .where(eq(heartbeatRuns.id, f.run.id));
    const resultJson = { configurationIncomplete: { reason: "missing_binding" } };
    await f.deps.setRunStatusIfRunning(f.run.id, "failed", { errorCode: "configuration_incomplete", resultJson });
    expect((await read(f.run.id)).resultJson).toEqual(resultJson);
  });

  it("keeps ordinary adapter pre-provider receipts outside setup-history checks", async () => {
    const f = await fixture({ runtimeMode: "native", costAccountingPending: true,
      runnerProfileJson: { nativeExecutionInput: { schema: "paperclip.native-execution-input.v1" } } });
    await reserveRunBudget(db, f.run.companyId, f.run.id, null);
    await f.completion.completeRun({ ...f.input, adapterResult: { exitCode: 1, signal: null, timedOut: false,
      errorCode: "provider_not_started", executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } });
    expect(await read(f.run.id)).toMatchObject({ status: "failed", costAccountingPending: false,
      costAccountedAt: expect.any(Date), resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } });
    const [hold] = await db.select().from(budgetReservations).where(eq(budgetReservations.runId, f.run.id));
    expect(hold.state).toBe("released");
  });

  it.each(["stale", "loaded", "foreign_coordinator"] as const)("settles fresh input admitted by this attempt when no provider work started (%s)", async mode => {
    const f = await fixture({ runtimeMode: "native", costAccountingPending: true,
      usageJson: { accountingReceiptReady: false, accountingReceiptSequence: 0 } });
    const setup = { ...f.setup(new ConfigurationIncompleteFailure("fresh preparation failed", {
      configurationIncomplete: { reason: "missing_binding" } })), run: { ...f.run } };
    const { issue } = await admitNativeExecution(f);
    await db.insert(nativeRunFinalizations).values({ runId: f.run.id, companyId: f.run.companyId,
      issueId: issue.id, phase: "observed" });
    if (mode === "foreign_coordinator") {
      const [otherIssue] = await db.insert(issues).values({ companyId: f.run.companyId, title: "Other task" }).returning();
      const [otherRun] = await db.insert(heartbeatRuns).values({ companyId: f.run.companyId, agentId: f.agent.id,
        nativeIssueId: otherIssue.id, status: "running", runtimeMode: "native" }).returning();
      await db.insert(nativeRunFinalizations).values({ runId: otherRun.id, companyId: otherRun.companyId,
        issueId: otherIssue.id, phase: "observed", attempt: 1 });
    }
    await reserveRunBudget(db, f.run.companyId, f.run.id, null);
    if (mode !== "stale") setup.run = await read(f.run.id);
    await f.completion.failRunSetup(setup);
    expect.soft(await read(f.run.id)).toMatchObject({ status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } });
    expect.soft(await (await import("../run-cost-accounting.js")).accountRunCost(db, f.run.id)).toBe(true);
    expect.soft(await read(f.run.id)).toMatchObject({ costAccountingPending: false, costAccountedAt: expect.any(Date) });
    const [hold] = await db.select().from(budgetReservations).where(eq(budgetReservations.runId, f.run.id));
    expect.soft(hold).toMatchObject({ state: "released", providerStartedAt: expect.any(Date) });
    expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, f.run.id))).toHaveLength(0);
  });

  it("retains receipt debt when a first execution claim commits during setup failure", async () => {
    const f = await fixture({ runtimeMode: "native", costAccountingPending: true,
      usageJson: { accountingReceiptReady: false, accountingReceiptSequence: 0 } });
    const setup = f.setup(new ConfigurationIncompleteFailure("preparation failed", {
      configurationIncomplete: { reason: "missing_binding" } }));
    const { issue } = await admitNativeExecution(f);
    await db.insert(nativeRunFinalizations).values({ runId: f.run.id, companyId: f.run.companyId,
      issueId: issue.id, phase: "observed" });
    await reserveRunBudget(db, f.run.companyId, f.run.id, null);
    let enter!: () => void, release!: () => void, blockerPid = 0;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const claimant = db.transaction(async tx => {
      const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      blockerPid = backend.pid;
      await tx.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.run.id)).for("update");
      await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)).for("update");
      enter(); await released;
      await tx.update(nativeRunFinalizations).set({ attempt: 1 }).where(eq(nativeRunFinalizations.runId, f.run.id));
      await tx.update(heartbeatRuns).set({ nativePhase: "observed", updatedAt: new Date() }).where(eq(heartbeatRuns.id, f.run.id));
    });
    await entered;
    const failure = f.completion.failRunSetup(setup);
    try {
      await vi.waitFor(async () => {
        const waiting = await db.execute(sql`select pid from pg_stat_activity
          where ${blockerPid} = any(pg_blocking_pids(pid)) and wait_event_type = 'Lock'`);
        expect(waiting.length).toBeGreaterThan(0);
      }, { timeout: 5_000 });
    } finally { release(); await claimant; await failure; }
    const failed = await read(f.run.id);
    expect.soft((failed.resultJson?.executionRecovery as Record<string, unknown> | undefined)?.providerWorkStarted).not.toBe(false);
    expect.soft(await (await import("../run-cost-accounting.js")).accountRunCost(db, f.run.id)).toBe(false);
    expect.soft(await read(f.run.id)).toMatchObject({ status: "failed", costAccountingPending: true, costAccountedAt: null });
    const [hold] = await db.select().from(budgetReservations).where(eq(budgetReservations.runId, f.run.id));
    expect(hold.state).toBe("held");
  }, 30_000);

  it("lets a completed Stop advance its budget delivery metadata", async () => {
    const f = await fixture({ runtimeMode: "native" });
    const [issue] = await db.insert(issues).values({ companyId: f.run.companyId, title: "Budget Stop delivery" }).returning();
    const intentAuditId = randomUUID(), acknowledgementAuditId = randomUUID();
    await db.insert(activityLog).values([
      { id: intentAuditId, companyId: f.run.companyId, actorType: "system", actorId: "native-session-cancellation",
        action: "native.cancellation_intent_recorded", entityType: "heartbeat_run", entityId: f.run.id, runId: f.run.id, agentId: f.agent.id },
      { id: acknowledgementAuditId, companyId: f.run.companyId, actorType: "system", actorId: "native-session-cancellation",
        action: "native.cancellation_dispatch_acknowledged", entityType: "heartbeat_run", entityId: f.run.id, runId: f.run.id, agentId: f.agent.id },
    ]);
    const nativeCancellation = { schema: "paperclip.native-cancellation.v1", companyId: f.run.companyId, runId: f.run.id, issueId: issue.id,
      scope: "run", reasonCode: "cancellation_run_only", intentAuditId, acknowledgementAuditId, dispatched: true, dispatchState: "acknowledged" };
    const startupCancellation = { requestedAt: new Date().toISOString(), beforeNativeSelection: false,
      budgetEnforcement: { companyId: f.run.companyId, scopeType: "agent", scopeId: f.agent.id, policyId: randomUUID(), version: 1 } };
    await db.update(heartbeatRuns).set({ nativeIssueId: issue.id, resultJson: { nativeCancellation, startupCancellation } })
      .where(eq(heartbeatRuns.id, f.run.id));
    const deliveredAt = new Date().toISOString();
    const outcome = await f.deps.setRunStatusFromLive(f.run.id, "cancelled", ["running"], {
      finishedAt: new Date(), resultJson: { nativeCancellation, startupCancellation: {
        ...startupCancellation, budgetEnforcement: { ...startupCancellation.budgetEnforcement, deliveredAt } } },
    });
    expect(outcome.updated).toBe(true);
    expect(await read(f.run.id)).toMatchObject({ status: "cancelled", resultJson: {
      nativeCancellation, startupCancellation: { budgetEnforcement: { deliveredAt } } } });
  });

  it("retains the default branch needed to repair an unresolved workspace base ref", async () => {
    const f = await fixture();
    const error = new UnresolvedWorkspaceBaseRefError({
      requestedRef: "main", recoveryIdentityRef: "origin/main", attemptedRefs: ["origin/main"], defaultBranch: "master",
    });
    await f.completion.failRunSetup(f.setup(error));
    expect(await read(f.run.id)).toMatchObject({ status: "failed", errorCode: "configuration_incomplete", resultJson: {
      configurationIncomplete: { reason: "workspace_base_ref_unresolved", requestedRef: "main", defaultBranch: "master", attemptedRefs: ["origin/main"], fingerprint: "workspace_base_ref:origin/main" },
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
    } });
  });

  it.each(["fresh", "started", "untrusted", "retained"] as const)("routes a %s workspace preparation timeout through bootstrap recovery", async scenario => {
    const f = await fixture({ runtimeMode: scenario === "retained" ? "native" : "legacy" });
    const cause = new RemoteWorkspaceOperationTimeoutError("prepare", 300_000);
    const error = scenario === "untrusted" ? new Error(cause.message) : new RemoteWorkspacePreparationTimeoutError(cause);
    f.deps.scheduleBoundedRetryForRun.mockResolvedValueOnce({ outcome: "not_scheduled", reason: "Fixture scheduler boundary", issueId: null });
    await f.completion.failRunSetup(f.setup(error, scenario === "started"));
    const failed = await read(f.run.id);
    expect(failed).toMatchObject({ status: "failed", errorCode: scenario === "fresh" ? "remote_workspace_prepare_timeout" : "setup_failed" });
    if (scenario === "fresh") {
      expect(failed.resultJson).toMatchObject({ executionRecovery: { kind: "bootstrap", providerWorkStarted: false } });
      expect(f.deps.scheduleBoundedRetryForRun).toHaveBeenCalledWith(expect.objectContaining({ id: f.run.id }), f.agent);
    } else expect(f.deps.scheduleBoundedRetryForRun).not.toHaveBeenCalled();
  });

  it.each(["fresh", "started", "untrusted", "retained"] as const)("routes a %s preserved sandbox resume failure through bounded bootstrap recovery", async scenario => {
    const f = await fixture({ runtimeMode: scenario === "retained" ? "native" : "legacy" });
    const providerError = Object.assign(new Error("Sandbox abc is not in a valid state: stopping /home/daytona/secret"), { statusCode: 400 });
    const resume = new ReusableSandboxResumeError({ provider: "daytona", providerLeaseId: "lease-1", cause: providerError });
    // The orchestrator wraps the runtime error, exactly as staging recorded it.
    const wrapped = new EnvironmentRunError("lease_acquire_failed",
      `Failed to acquire lease for environment "Paperclip Sandbox" (sandbox): ${resume.message}`, { cause: resume });
    const error = scenario === "untrusted" ? new Error(wrapped.message) : wrapped;
    f.deps.scheduleBoundedRetryForRun.mockResolvedValueOnce({ outcome: "not_scheduled", reason: "Fixture scheduler boundary", issueId: null });
    await f.completion.failRunSetup(f.setup(error, scenario === "started"));
    const failed = await read(f.run.id);
    expect(failed).toMatchObject({ status: "failed", errorCode: scenario === "fresh" ? "reusable_sandbox_resume_failed" : "setup_failed" });
    // The closed-label cause is recorded; provider text never is.
    expect(failed.error).toContain("cause=provider_error status=400");
    expect(failed.error).not.toContain("/home/daytona");
    if (scenario === "fresh") {
      expect(failed.resultJson).toMatchObject({ executionRecovery: { kind: "bootstrap", providerWorkStarted: false } });
      expect(f.deps.scheduleBoundedRetryForRun).toHaveBeenCalledWith(expect.objectContaining({ id: f.run.id }), f.agent);
    } else expect(f.deps.scheduleBoundedRetryForRun).not.toHaveBeenCalled();
  });

  it.each(["fresh", "started", "untrusted", "retained"] as const)("routes a %s stopped plugin worker refusal through bounded bootstrap recovery", async scenario => {
    const f = await fixture({ runtimeMode: scenario === "retained" ? "native" : "legacy" });
    const refusal = new PluginWorkerUnavailableError({ pluginId: "plugin-1", workerStatus: "stopped",
      message: 'Cannot call "environmentExecute" — worker for "plugin-1" is stopped' });
    const error = scenario === "untrusted" ? new Error(refusal.message)
      : new EnvironmentRunError("workspace_realization_failed", refusal.message, { cause: refusal });
    f.deps.scheduleBoundedRetryForRun.mockResolvedValueOnce({ outcome: "not_scheduled", reason: "Fixture scheduler boundary", issueId: null });
    await f.completion.failRunSetup(f.setup(error, scenario === "started"));
    const failed = await read(f.run.id);
    expect(failed).toMatchObject({ status: "failed", errorCode: scenario === "fresh" ? "plugin_worker_unavailable" : "setup_failed" });
    if (scenario === "fresh") {
      expect(failed.resultJson).toMatchObject({ executionRecovery: { kind: "bootstrap", providerWorkStarted: false } });
      expect(f.deps.scheduleBoundedRetryForRun).toHaveBeenCalledWith(expect.objectContaining({ id: f.run.id }), f.agent);
    } else expect(f.deps.scheduleBoundedRetryForRun).not.toHaveBeenCalled();
  });

  // Daytona returned HTTP 502 on sandbox create and cleanup of the
  // provisional allocation could not be confirmed. The orchestrator wraps the
  // worker refusal exactly as staging recorded it.
  const daytonaCreate502 = (withEnvelope = true) => new JsonRpcCallError({ code: -32000,
    message: "Daytona sandbox creation failed (HTTP 502); cleanup could not be confirmed for paperclip-create-05f81d77",
    data: withEnvelope ? { schema: "paperclip/environment-creation-cleanup/v1", providerDiagnostic: { httpStatus: 502 },
      cleanup: { providerLeaseId: "paperclip-create-05f81d77", companyId: "company", environmentId: "environment",
        attemptId: "05f81d77", accountFingerprint: "a".repeat(64), labels: {} } } : undefined });
  const acquireThroughOrchestrator = async (refusal: unknown) => {
    const orchestrator = environmentRunOrchestrator(db, { environmentRuntime: {
      acquireRunLease: async () => { throw refusal; },
    } as never });
    return orchestrator.acquireLease({ companyId: randomUUID(), environment: { id: randomUUID(), name: "Paperclip Sandbox", driver: "sandbox" } as never,
      issueId: null, agentId: randomUUID(), heartbeatRunId: randomUUID(), persistedExecutionWorkspace: null,
      executionWorkspaceSettings: null, adapterType: null }).then(() => { throw new Error("expected a refusal"); }, (error: unknown) => error);
  };

  it.each(["fresh", "started", "message_only", "permanent", "retained"] as const)("routes a %s sandbox provider lease refusal through bounded bootstrap recovery", async scenario => {
    const f = await fixture({ runtimeMode: scenario === "retained" ? "native" : "legacy" });
    const refusal = scenario === "message_only" ? daytonaCreate502(false)
      : scenario === "permanent" ? new JsonRpcCallError({ code: -32000, message: "Daytona sandbox creation failed (HTTP 400)",
        data: { schema: "paperclip/environment-acquire-error/v1", providerDiagnostic: { httpStatus: 400 } } })
      : daytonaCreate502();
    const error = await acquireThroughOrchestrator(refusal);
    f.deps.scheduleBoundedRetryForRun.mockResolvedValueOnce({ outcome: "not_scheduled", reason: "Fixture scheduler boundary", issueId: null });
    await f.completion.failRunSetup(f.setup(error, scenario === "started"));
    const failed = await read(f.run.id);
    const retried = scenario === "fresh";
    expect(failed).toMatchObject({ status: "failed", errorCode: retried ? "environment_provider_unavailable" : "setup_failed" });
    // The staging message is kept verbatim for diagnostics.
    expect(failed.error).toContain("Daytona sandbox creation failed");
    if (retried) {
      expect(failed.resultJson).toMatchObject({ executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
        providerFailure: { provider: "sandbox", phase: "startup", category: "overloaded", httpStatus: 502, retryability: "transient" } });
      expect(f.deps.scheduleBoundedRetryForRun).toHaveBeenCalledWith(expect.objectContaining({ id: f.run.id }), f.agent);
    } else expect(f.deps.scheduleBoundedRetryForRun).not.toHaveBeenCalled();
  });

  it.each(["fresh", "started", "untrusted", "denied", "retained", "session", "runner"] as const)("bounds only an owned pre-dispatch chat binding wait: %s", async scenario => {
    const f = await fixture({ runtimeMode: scenario === "retained" ? "native" : "legacy",
      ...(scenario === "session" ? { nativeSessionId: randomUUID() } : {}),
      ...(scenario === "runner" ? { runnerInstanceId: randomUUID() } : {}) });
    const error = scenario === "untrusted" ? new Error("reviewed_chat_execution_binding_not_ready")
      : scenario === "denied" ? new ReviewedChatBindingDeniedError("principal_denied")
      : new ReviewedChatBindingNotReadyError();
    f.deps.scheduleBoundedRetryForRun.mockResolvedValueOnce({ outcome: "scheduled" } as never);
    await f.completion.failRunSetup(f.setup(error, scenario === "started"));
    const failed = await read(f.run.id);
    expect(failed).toMatchObject({ status: "failed", errorCode: scenario === "fresh" ? "reviewed_chat_execution_binding_not_ready" : "setup_failed" });
    if (scenario === "fresh") {
      expect(failed.resultJson).toMatchObject({ executionRecovery: { kind: "bootstrap", providerWorkStarted: false } });
      expect(f.deps.scheduleBoundedRetryForRun).toHaveBeenCalledWith(expect.objectContaining({ id: f.run.id }), f.agent);
    } else expect(f.deps.scheduleBoundedRetryForRun).not.toHaveBeenCalled();
  });

  it("keeps an answered chat interaction on its own bounded continuation retry", async () => {
    const f = await fixture({ contextSnapshot: { source: "issue.interaction.respond", externalChatContinuation: true,
      interactionId: "interaction-1", interactionStatus: "answered", interactionKind: "ask_user_questions",
      mutation: "interaction", wakeReason: "issue_commented" } });
    await f.completion.failRunSetup(f.setup(new ReviewedChatBindingNotReadyError()));
    expect(await read(f.run.id)).toMatchObject({ status: "failed", errorCode: "reviewed_chat_execution_binding_not_ready" });
    expect(f.deps.scheduleInteractionContinuationInfrastructureRetryIfEligible)
      .toHaveBeenCalledWith(expect.objectContaining({ id: f.run.id }), f.agent);
    expect(f.deps.scheduleBoundedRetryForRun).not.toHaveBeenCalled();
  });

  it.each([false, true])("selects the answer retry from the real delivery producer and heartbeat queue (legacy context=%s)", async legacy => {
    const f = await fixture();
    await db.update(agents).set({ adapterType: "paperclip_runner", status: "idle",
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).where(eq(agents.id, f.agent.id));
    const [issue] = await db.insert(issues).values({ companyId: f.run.companyId, title: "Answer delivery retry",
      status: "in_progress", assigneeAgentId: f.agent.id, responsibleUserId: "local-board" }).returning();
    const [questionRun] = await db.insert(heartbeatRuns).values({ companyId: f.run.companyId, agentId: f.agent.id,
      issueId: issue.id, nativeIssueId: issue.id, runtimeMode: "native", status: "succeeded", finishedAt: new Date(),
      contextSnapshot: { issueId: issue.id, source: "chat:telegram" } }).returning();
    const interactions = issueThreadInteractionService(db);
    const interaction = await interactions.create(issue, { kind: "ask_user_questions", sourceRunId: questionRun.id,
      continuationPolicy: "wake_assignee", payload: { version: 1, questions: [{ id: "choice", prompt: "Choose",
        selectionMode: "single", required: true, options: [{ id: "yes", label: "Yes" }] }] } },
      { agentId: f.agent.id, runId: questionRun.id });
    await interactions.answerQuestions(issue, interaction.id, { answers: [{ questionId: "choice", optionIds: ["yes"] }] },
      { userId: "local-board" });
    const heartbeat = heartbeatService(db);
    const answerHeartbeat = legacy ? { ...heartbeat, wakeup: (...[agentId, options]: Parameters<typeof heartbeat.wakeup>) => {
      const contextSnapshot = { ...options?.contextSnapshot };
      delete contextSnapshot.mutation;
      return heartbeat.wakeup(agentId, { ...options, contextSnapshot });
    } } : heartbeat;
    await questionResponseDeliveryService(db, { heartbeat: answerHeartbeat }).deliver(interaction.id);
    const [delivery] = await db.select().from(issueQuestionResponseDeliveries)
      .where(eq(issueQuestionResponseDeliveries.interactionId, interaction.id));
    expect(delivery).toMatchObject({ status: "fallback_queued", deliveryMode: "wake_fallback" });
    expect(delivery.targetRunId).toBeTruthy();
    const [admitted] = await db.update(heartbeatRuns).set({ status: "running", executionStage: "preparing", startedAt: new Date() })
      .where(eq(heartbeatRuns.id, delivery.targetRunId!)).returning();
    f.deps.scheduleInteractionContinuationInfrastructureRetryIfEligible.mockImplementation(async run => {
      await heartbeat.scheduleBoundedRetry(run.id, { now: new Date(), random: () => 0,
        retryReason: "interaction_continuation_infra_retry", wakeReason: "interaction_continuation_infra_retry", maxAttempts: 2 });
      return null;
    });
    f.deps.scheduleBoundedRetryForRun.mockResolvedValue({ outcome: "not_scheduled",
      reason: "Wrong retry owner fixture", issueId: issue.id });
    await f.completion.failRunSetup({ ...f.setup(new ReviewedChatBindingNotReadyError()), run: admitted, runId: admitted.id });
    expect(f.deps.scheduleBoundedRetryForRun).not.toHaveBeenCalled();
    expect(f.deps.scheduleInteractionContinuationInfrastructureRetryIfEligible)
      .toHaveBeenCalledWith(expect.objectContaining({ id: admitted.id }), expect.anything());
    const children = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, admitted.id));
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ scheduledRetryReason: "interaction_continuation_infra_retry",
      contextSnapshot: { interactionId: interaction.id, interactionStatus: "answered", mutation: "interaction" } });
    expect((await db.select().from(issueQuestionResponseDeliveries)
      .where(eq(issueQuestionResponseDeliveries.id, delivery.id)))[0]).toEqual(delivery);
  }, 30_000);

  const runnerMismatch = () => new JsonRpcCallError({ code: -32002, message: "The installed Runner does not match the expected revision",
    data: environmentTaskErrorCodeData(new PluginEnvironmentTaskError("runner_revision_mismatch")) });

  it.each(["fresh", "wrapped", "started", "untrusted", "retained"] as const)("waits for the Runner update after a %s Runner mismatch", async scenario => {
    const f = await fixture({ runtimeMode: scenario === "retained" ? "native" : "legacy" });
    const refusal = runnerMismatch();
    const error = scenario === "untrusted" ? new Error(refusal.message)
      : scenario === "wrapped" ? new Error("Plugin Runner task failed", { cause: refusal })
      : classifyManagedProjectAuthFailure(refusal, f.agent.id);
    f.deps.scheduleBoundedRetryForRun.mockResolvedValueOnce({ outcome: "not_scheduled", reason: "Fixture scheduler boundary", issueId: null });
    await f.completion.failRunSetup(f.setup(error, scenario === "started"));
    const failed = await read(f.run.id);
    const retried = scenario === "fresh" || scenario === "wrapped";
    expect(failed).toMatchObject({ status: "failed", errorCode: retried ? "runner_revision_mismatch" : "setup_failed" });
    expect(failed.resultJson).not.toHaveProperty("configurationIncomplete");
    if (retried) {
      expect(failed.resultJson).toMatchObject({ executionRecovery: { kind: "bootstrap", providerWorkStarted: false } });
      expect(f.deps.scheduleBoundedRetryForRun).toHaveBeenCalledWith(expect.objectContaining({ id: f.run.id }), f.agent, RUNNER_REVISION_MISMATCH_RETRY);
    } else expect(f.deps.scheduleBoundedRetryForRun).not.toHaveBeenCalled();
  });

  it("waits for the Runner update on an answered interaction instead of its two-attempt continuation retry", async () => {
    const f = await fixture({ contextSnapshot: { interactionId: "interaction-1", interactionStatus: "answered", interactionKind: "ask_user_questions",
      mutation: "interaction", wakeReason: "issue_commented" } });
    f.deps.scheduleBoundedRetryForRun.mockResolvedValueOnce({ outcome: "not_scheduled", reason: "Fixture scheduler boundary", issueId: null });
    await f.completion.failRunSetup(f.setup(runnerMismatch()));
    expect(await read(f.run.id)).toMatchObject({ status: "failed", errorCode: "runner_revision_mismatch" });
    expect(f.deps.scheduleBoundedRetryForRun).toHaveBeenCalledWith(expect.objectContaining({ id: f.run.id }), f.agent, RUNNER_REVISION_MISMATCH_RETRY);
    expect(f.deps.scheduleInteractionContinuationInfrastructureRetryIfEligible).not.toHaveBeenCalled();
  });

  it("records a workspace provider's reason on the run and in the setup failure log without retrying", async () => {
    const f = await fixture();
    const logged = vi.spyOn(logger, "error");
    onTestFinished(() => logged.mockRestore());
    const rejection = new JsonRpcCallError({ code: -32002, message: "Invalid runtime computer connection",
      data: workspaceOperationErrorData(new PluginWorkspaceOperationError("runtime_connection_invalid")) });
    await f.completion.failRunSetup(f.setup(workspaceProviderCallFailure(rejection)));
    const failed = await read(f.run.id);
    expect(failed).toMatchObject({ status: "failed", errorCode: "setup_failed",
      error: "The selected runtime's saved connection is invalid; reprovision the runtime before retrying",
      resultJson: { workspaceProviderFailure: { kind: "provider", reason: "runtime_connection_invalid", retryable: false } } });
    expect(JSON.stringify(failed)).not.toContain("Invalid runtime computer connection");
    expect(f.deps.scheduleBoundedRetryForRun).not.toHaveBeenCalled();
    const setupLog = logged.mock.calls.find(call => call[1] === "heartbeat execution setup failed");
    expect(setupLog?.[0]).toMatchObject({ runId: f.run.id, errorCode: "setup_failed",
      workspaceProviderFailure: { kind: "provider", reason: "runtime_connection_invalid", retryable: false } });
  });

  it("logs the driver cause code of a wrapped setup query failure without its text", async () => {
    const f = await fixture();
    const logged = vi.spyOn(logger, "error");
    onTestFinished(() => logged.mockRestore());
    const driverError = Object.assign(new Error("write CONNECTION_CLOSED 127.0.0.1:5432"), { code: "CONNECTION_CLOSED" });
    await f.completion.failRunSetup(f.setup(new Error("Failed query: select 1", { cause: driverError })));
    const setupLog = logged.mock.calls.find(call => call[1] === "heartbeat execution setup failed");
    expect(setupLog?.[0]).toMatchObject({ runId: f.run.id, errorCode: "setup_failed", causeCode: "CONNECTION_CLOSED" });
    expect(JSON.stringify(setupLog?.[0])).not.toContain("127.0.0.1:5432");
  });

  it("retries a workspace operation the stopped provider worker never received", async () => {
    const f = await fixture();
    const refusal = new PluginWorkerUnavailableError({ pluginId: "plugin-1", workerStatus: "stopped",
      message: 'Cannot call "workspaceOperation" — worker for "plugin-1" is stopped' });
    f.deps.scheduleBoundedRetryForRun.mockResolvedValueOnce({ outcome: "not_scheduled", reason: "Fixture scheduler boundary", issueId: null });
    await f.completion.failRunSetup(f.setup(workspaceProviderCallFailure(refusal)));
    expect(await read(f.run.id)).toMatchObject({ status: "failed", errorCode: "plugin_worker_unavailable",
      error: "Workspace storage provider is not running; retry the same workspace",
      resultJson: { workspaceProviderFailure: { kind: "worker_unavailable", reason: null, retryable: true } } });
    expect(f.deps.scheduleBoundedRetryForRun).toHaveBeenCalledWith(expect.objectContaining({ id: f.run.id }), f.agent);
  });

  it("keeps a found project authentication conflict a configuration gap that blocks for the board", async () => {
    const f = await fixture();
    const conflict = unprocessable("This agent's managed AI connection conflicts with project authentication settings in .claude/settings.json.",
      { code: "ai_connection_incompatible" });
    await f.completion.failRunSetup(f.setup(classifyManagedProjectAuthFailure(conflict, f.agent.id)));
    expect(await read(f.run.id)).toMatchObject({ status: "failed", errorCode: "configuration_incomplete",
      resultJson: { configurationIncomplete: { reason: "ai_connection_incompatible", actionUrl: `/agents/${f.agent.id}/runtime` } } });
    expect(f.deps.scheduleBoundedRetryForRun).not.toHaveBeenCalled();
  });

  it.each([
    ["an unavailable Runner identity", new Error("Runner identity unavailable")],
    ["an unreachable execution host", Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })],
    ["another 422", unprocessable("Select a saved AI account", { code: "ai_connection_busy" })],
  ])("does not report %s as a project authentication conflict", async (_name, error) => {
    const f = await fixture();
    const classified = classifyManagedProjectAuthFailure(error, f.agent.id);
    expect(classified).toBe(error);
    await f.completion.failRunSetup(f.setup(classified));
    const failed = await read(f.run.id);
    expect(failed.errorCode).not.toBe("configuration_incomplete");
    expect(failed.resultJson).not.toHaveProperty("configurationIncomplete");
  });

  it("routes a lease acquisition refused by a stopped provider worker through bounded bootstrap recovery", async () => {
    const f = await fixture();
    const refusal = new PluginWorkerUnavailableError({ pluginId: "plugin-1", workerStatus: null,
      message: 'Sandbox provider "daytona" is installed via plugin "paperclip.daytona-sandbox-provider", but its worker is not running.' });
    const wrapped = new EnvironmentRunError("lease_acquire_failed",
      `Failed to acquire lease for environment "Paperclip Sandbox" (sandbox): ${refusal.message}`, { cause: refusal });
    f.deps.scheduleBoundedRetryForRun.mockResolvedValueOnce({ outcome: "not_scheduled", reason: "Fixture scheduler boundary", issueId: null });
    await f.completion.failRunSetup(f.setup(wrapped));
    expect(await read(f.run.id)).toMatchObject({ status: "failed", errorCode: "plugin_worker_unavailable",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } });
    expect(f.deps.scheduleBoundedRetryForRun).toHaveBeenCalledWith(expect.objectContaining({ id: f.run.id }), f.agent);
  });

  it.each(["retried", "exhausted", "refused", "started", "in progress"] as const)("names a %s saved workspace restore failure and leaves recovery", async scenario => {
    const f = await fixture();
    const [issue] = await db.insert(issues).values({ companyId: f.run.companyId, title: "Parent task", status: scenario === "in progress" ? "in_progress" : "blocked",
      assigneeAgentId: f.agent.id }).returning();
    await db.update(heartbeatRuns).set({ issueId: issue.id, contextSnapshot: { issueId: issue.id } }).where(eq(heartbeatRuns.id, f.run.id));
    const sandboxCause = scenario === "refused"
      ? "remote_workspace_operation_failed: operation=restore exit=1; remote_workspace_restore_failed: stage=inspect_root reason=occupied_root"
      : "remote_workspace_operation_failed: operation=restore exit=1; remote_workspace_restore_failed: stage=extract code=EIO exit=1";
    const error = new RemoteWorkspaceRestoreError("sandbox_restore", scenario !== "refused", new RemoteWorkspaceOperationError(sandboxCause));
    if (scenario === "retried") f.deps.scheduleBoundedRetryForRun.mockResolvedValueOnce({ outcome: "scheduled" } as never);
    else f.deps.scheduleBoundedRetryForRun.mockResolvedValueOnce({ outcome: "retry_exhausted", attempt: 3, maxAttempts: 2 } as never);
    await f.completion.failRunSetup(f.setup(error, scenario === "started"));
    const failed = await read(f.run.id);
    // The run names the restore step and the sandbox step instead of a bare exit status.
    expect(failed.error).toBe(`remote_workspace_restore_failed: step=sandbox_restore; ${sandboxCause}`);
    const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issue.id));
    if (scenario === "started") {
      expect(failed.errorCode).toBe("setup_failed");
      expect(f.deps.scheduleBoundedRetryForRun).not.toHaveBeenCalled();
      // Started work keeps its existing reconciliation path.
      expect(actions.filter(action => action.cause === "remote_workspace_restore_failed")).toHaveLength(0);
      return;
    }
    expect(failed).toMatchObject({ status: "failed", errorCode: "remote_workspace_restore_failed" });
    expect(failed.resultJson).toMatchObject({ executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
      remoteWorkspaceRestore: { step: "sandbox_restore", retryable: scenario !== "refused" } });
    if (scenario === "refused") expect(f.deps.scheduleBoundedRetryForRun).not.toHaveBeenCalled();
    else expect(f.deps.scheduleBoundedRetryForRun).toHaveBeenCalledWith(expect.objectContaining({ id: f.run.id }), f.agent);
    // Stranded-work recovery owns scanned statuses; a retry owns the next step.
    if (scenario === "retried" || scenario === "in progress") { expect(actions).toHaveLength(0); return; }
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ status: "active", ownerType: "board", cause: "remote_workspace_restore_failed",
      kind: "stranded_assigned_issue", returnOwnerAgentId: f.agent.id });
    expect(actions[0]!.evidence).toMatchObject({ runId: f.run.id, restoreFailure: failed.error });
    expect(actions[0]!.nextAction).toContain("saved workspace version was kept");
  });

  it("keeps an active recovery action that another writer created for the task", async () => {
    const f = await fixture();
    const [issue] = await db.insert(issues).values({ companyId: f.run.companyId, title: "Parent task", status: "blocked",
      assigneeAgentId: f.agent.id }).returning();
    await db.update(heartbeatRuns).set({ issueId: issue.id, contextSnapshot: { issueId: issue.id } }).where(eq(heartbeatRuns.id, f.run.id));
    const [existing] = await db.insert(issueRecoveryActions).values({ companyId: f.run.companyId, sourceIssueId: issue.id,
      kind: "active_run_watchdog", status: "active", ownerType: "board", cause: "other_failure", fingerprint: "other",
      evidence: { runId: "other-run" }, nextAction: "Handle the other failure.", attemptCount: 1 }).returning();
    const error = new RemoteWorkspaceRestoreError("sandbox_restore", false, new RemoteWorkspaceOperationError(
      "remote_workspace_operation_failed: operation=restore exit=1; remote_workspace_restore_failed: stage=inspect_root reason=occupied_root"));
    await f.completion.failRunSetup(f.setup(error));
    expect((await read(f.run.id)).errorCode).toBe("remote_workspace_restore_failed");
    const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issue.id));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ id: existing.id, cause: "other_failure", fingerprint: "other", nextAction: "Handle the other failure.",
      attemptCount: 1, evidence: { runId: "other-run" } });
  });

  it("records a lease lost before dispatch as a retryable host stop, not an opaque setup failure", async () => {
    const f = await fixture();
    f.controller.abort(new LegacyControllerLeaseLostError("renewal_rejected"));
    await f.completion.failRunSetup(f.setup(f.controller.signal.reason));
    expect(await read(f.run.id)).toMatchObject({ status: "failed", errorCode: "controller_lease_lost", resultJson: {
      cancellation: { source: "controller_lease", expected: false, reason: "Legacy controller lease lost (renewal_rejected)" },
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } });
    expect(f.deps.releaseIssueExecutionAndPromote).toHaveBeenCalledOnce();
    expect(f.deps.finalizeAgentStatus).toHaveBeenCalledWith(f.agent.id, "failed", expect.any(String), expect.objectContaining({ keepIdleOnFailure: true }));
  });

  it("attributes a lease loss even when a setup step throws its own abort error", async () => {
    const f = await fixture();
    f.controller.abort(new LegacyControllerLeaseLostError("renewal_deadline"));
    await f.completion.failRunSetup(f.setup(new Error("environment acquisition aborted")));
    expect(await read(f.run.id)).toMatchObject({ status: "failed", errorCode: "controller_lease_lost",
      resultJson: { cancellation: { source: "controller_lease", reason: "Legacy controller lease lost (renewal_deadline)" } } });
  });

  it("does not make a lease loss retryable once provider work has started", async () => {
    const f = await fixture();
    f.controller.abort(new LegacyControllerLeaseLostError("renewal_error"));
    await f.completion.failRunSetup(f.setup(new Error("usage capture write failed"), true));
    expect(await read(f.run.id)).toMatchObject({ status: "failed", errorCode: "setup_failed",
      resultJson: { cancellation: { source: "controller_lease", reason: "Legacy controller lease lost (renewal_error)" } } });
    expect(f.deps.finalizeAgentStatus).toHaveBeenCalledWith(f.agent.id, "failed", expect.any(String), expect.objectContaining({ keepIdleOnFailure: false }));
  });

  it("leaves a winning terminal outcome and agent state untouched after a late setup error", async () => {
    const f = await fixture({ status: "succeeded", resultJson: { winner: "completion" } });
    await f.completion.failRunSetup(f.setup(new Error("late setup error")));
    expect(await read(f.run.id)).toMatchObject({ status: "succeeded", resultJson: { winner: "completion" } });
    expect(f.deps.setWakeupStatus).not.toHaveBeenCalled();
    expect(f.deps.releaseIssueExecutionAndPromote).not.toHaveBeenCalled();
    expect(f.deps.finalizeAgentStatus).not.toHaveBeenCalled();
  });
});
