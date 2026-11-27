import { heartbeatService } from "../heartbeat.js";
import { buildExecutionContinuation } from "../execution-continuation.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { randomUUID } from "node:crypto";
import { createIsolatedTestHome } from "../../__tests__/helpers/isolated-test-home.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { activityLog, issueRecoveryActions, agentTaskSessions, agentWakeupRequests, agents, aiConnectionPools, aiConnectionQuotaCooldowns, aiConnectionTaskPins, authUsers, companies, companyMemberships, companySecrets, completionContracts, connectionGrants, createDb, heartbeatRunEvents, heartbeatRuns, issues, issueThreadInteractions, nativeRunFinalizations, nativeRunResults, toolInvocations, type Db } from "@paperclipai/db";
import { BUILTIN_AI_FAILOVER_ROUTER_KEY } from "@paperclipai/shared";
import { createPrpSemanticToolInputEnvelope, createPrpSemanticToolResultEnvelope } from "@paperclipai/paperclip-runner";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { secretService } from "../secrets.js";
import { instanceSettingsService } from "../instance-settings.js";
import { observeLegacyPoolAccountFailure, isCurrentLegacyPoolAccountProof } from "./legacy-pool-account-proof.js";
import { prepareManagedAiRuntime } from "../ai-connection-runtime.js";
import { connectionIntentService } from "../connection-intents.js";
import { aiConnectionService } from "../ai-connections.js";
import { aiConnectionRouterService } from "../ai-connection-router.js";
import { AI_CONNECTION_POOL_WAIT_RETRY_REASON } from "../../modules/run-dispatch/index.js";
import { createHeartbeatRetries, type HeartbeatRetryDependencies } from "./retries.js";
import { fenceLegacyQuotaPrestartStop, switchUnstartedLegacyQuotaPin } from "./quota-prestart-fence.js";
import { preparePoolAdapterClaim } from "./effective-run-adapter.js";
import { recordVerifiedRouterQuotaCooldown, recoverLegacyPoolAttribution } from "./run-completion.js";
import { reopenNativeQuotaPoolWaits } from "../native-runtime/native-quota-wake.js";

describe("legacy quota prestart retry", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db, home: ReturnType<typeof createIsolatedTestHome>;
  beforeAll(async () => { home = createIsolatedTestHome(); vi.stubEnv("PAPERCLIP_HOME", home.home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "legacy-quota-test");
    if (process.env.PAPERCLIP_TEST_DATABASE_URL) db = createDb(process.env.PAPERCLIP_TEST_DATABASE_URL, { maxConnections: 8 });
    else { database = await startEmbeddedPostgresTestDatabase("legacy-quota-prestart-"); db = createDb(database.connectionString, { maxConnections: 8 }); } }, 90_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); vi.unstubAllEnvs(); home?.cleanup(); });
  let observedReset: string;
  beforeEach(() => {
    observedReset = new Date(Date.now() + 3_600_000).toISOString();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ five_hour: { utilization: 100, resets_at: observedReset }, extra_usage: { is_enabled: false } })));
  });
  afterEach(() => vi.restoreAllMocks());
  async function fixture(postStart = false, taskless = false, provider: "anthropic" | "openai" = "anthropic",
    historicalAdapters?: { firstNative: boolean; backupCodex: boolean; backupNative?: boolean }) {
    const adapterType = historicalAdapters ? "paperclip_runner" : provider === "openai" ? "codex_local" : "claude_local";
    const credential = provider === "openai" ? JSON.stringify({ tokens: { access_token: "fixture-token", account_id: "fixture-account" } }) : "fixture-one";
    if (provider === "openai") vi.mocked(globalThis.fetch).mockImplementation(async () => new Response(JSON.stringify({ rate_limit: { allowed: false, primary_window: { used_percent: 100, reset_at: Math.ceil(Date.parse(observedReset) / 1000) } }, credits: { has_credits: false, unlimited: false } })));
    const companyId = randomUUID(), userId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Quota prestart", issuePrefix: `Q${companyId.slice(0, 8)}` });
    await db.insert(authUsers).values({ id: userId, name: "User", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    const [agent] = await db.insert(agents).values({ companyId, name: adapterType, adapterType, status: "active" }).returning();
    const accounts = aiConnectionService(db);
    const first = await accounts.save(companyId, userId, { provider, method: "subscription", ownership: "personal", name: "First", loginSessionId: "fixture", agentIds: [], allAgents: true }, credential);
    const backupProvider = historicalAdapters?.backupCodex ? "openai" : "anthropic";
    const second = await accounts.save(companyId, userId, { provider: backupProvider, method: "subscription", ownership: "personal", name: "Second", loginSessionId: "fixture", agentIds: [], allAgents: true }, historicalAdapters?.backupCodex
      ? JSON.stringify({ tokens: { access_token: "backup-token", account_id: "backup-account" } }) : "fixture-two");
    const members = [first, second].map((account, index) => {
      const accountProvider = index === 0 ? provider : backupProvider;
      return { id: randomUUID(), binding: { mode: "delegated" as const, provider: accountProvider, method: "subscription" as const, ...account },
        ...(historicalAdapters && { runner: ((index === 0 ? historicalAdapters.firstNative : historicalAdapters.backupNative) ? "paperclip" : "legacy") as "paperclip" | "legacy" }),
        profile: accountProvider === "openai" ? { provider: "codex" as const, model: "gpt-5.6-sol" }
          : { provider: "acpx" as const, acpxAgent: "claude" as const, model: "claude-sonnet-5" } };
    });
    const router = aiConnectionRouterService(db);
    const pool = await router.save(BUILTIN_AI_FAILOVER_ROUTER_KEY, { companyId, config: { name: "Pool", enabled: true, mode: "failover", thresholdPercent: 90, members,
      ...(historicalAdapters && { schemaVersion: 2 as const, kind: "harness_pool" as const }) } }, userId);
    if (historicalAdapters) await instanceSettingsService(db).updateExperimental({ enableNativeRunner: true });
    const [updatedAgent] = await db.update(agents).set({
      ...(historicalAdapters?.firstNative && provider === "anthropic" ? { adapterConfig: { provider: "acpx", acpxAgent: "claude" } } : {}),
      runtimeConfig: historicalAdapters
      ? { harnessPool: { poolId: pool.id } } : { aiConnection: { mode: "router", connectionId: pool.id } } }).where(eq(agents.id, agent.id)).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "Task", identifier: `Q${companyId.slice(0, 8)}-1`, status: "in_progress", assigneeAgentId: agent.id }).returning();
    const startedAt = new Date(Date.now() - 10_000);
    const runId = randomUUID(), taskKey = taskless ? runId : issue.id;
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: agent.id, scopeKind: taskless ? "company" : "issue", issueId: taskless ? null : issue.id, status: "running", startedAt,
      contextSnapshot: { ...(!taskless ? { issueId: issue.id } : {}), aiRouterTaskKey: taskKey }, responsibleUserId: userId }).returning();
    const selected = await router.resolve({ companyId, poolId: pool.id, agentId: agent.id, userId, adapterType, taskKey, skipUsageProbe: true });
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, first.grantId));
    const ref = grant!.credentialSecretRefs.find(item => item.configPath === "ai.credential")!;
    const [secret] = await db.select().from(companySecrets).where(eq(companySecrets.id, ref.secretId));
    await router.recordQuotaCooldown(companyId, first.connectionId, `secret:${ref.secretId}:${secret!.aiSessionEpoch}`, new Date(Date.now() + 3_600_000));
    const [source] = await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(), errorCode: "ai_connection_pool_exhausted",
      runnerProfileJson: { legacyQuotaPrestartFence: { schema: "paperclip.legacy-quota-prestart.v1", companyId, agentId: agent.id, runId: run.id, state: "preparing" } },
      resultJson: { executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: false }, cancellation: { source: "control_plane", reason: "Waiting for an AI connection pool account" } } }).where(eq(heartbeatRuns.id, run.id)).returning();
    if (postStart) {
      const contextSnapshot = { ...source!.contextSnapshot, aiRouterSelection: selected,
        aiConnection: { connectionId: first.connectionId, grantId: first.grantId, provider,
          sessionIdentity: `${first.grantId}:fixture:${ref.secretId}:${secret!.aiSessionEpoch}` } };
      const resultJson = { errorFamily: "provider_quota", conversationContinuation: "continue_conversation_v1",
        executionSettlement: { providerStopped: true, workspaceSettled: true, actionOutcomes: "unknown" },
        summary: "Completed the first change; continue with verification." };
      const [failed] = await db.update(heartbeatRuns).set({ status: "failed", errorCode: "provider_quota",
        contextSnapshot, resultJson, sessionIdAfter: "claude-original-session" }).where(eq(heartbeatRuns.id, source!.id)).returning();
      Object.assign(source!, failed);
      expect(await recordVerifiedRouterQuotaCooldown(db, { companyId, agentId: agent.id, runId: run.id,
        credentialIdentity: `${first.grantId}:fixture:${ref.secretId}:${secret!.aiSessionEpoch}`, retryNotBefore: null })).toBe(true);
    }
    if (!taskless) await db.update(issues).set({ executionRunId: run.id, checkoutRunId: run.id }).where(eq(issues.id, issue.id));
    const deps = { recoverPoolAttribution: (run: typeof source) => recoverLegacyPoolAttribution(db, run), hasCaseHandoffForRun: async () => false, getRun: async () => null, getAgent: async () => undefined,
      resolveSessionBeforeForWakeup: async () => null, resolveResponsibleUserIdForRunContext: async () => userId,
      getAgentInvokability: async () => ({ invokable: true }), appendRunEvent: async () => undefined,
      escalatePlanApprovalResumeFailureNeedsAttention: async () => null, recordPlanApprovalResumeFailureRetry: async () => null,
      setRunStatusIfRunning: async () => ({ updated: false, run: null }), setWakeupStatus: async () => undefined,
      releaseIssueExecutionAndPromote: async () => undefined, finalizeAgentStatus: async () => undefined,
      getWorktreeExecutionCutoff: async () => null, applyRunDispatchPostCommitEffects: () => {},
      runDispatch: { nextScheduledRetryAt: async () => null, evaluateScheduledRetryGate: async () => ({ allowed: true }),
        promoteDueScheduledRetries: async () => ({ promoted: 0, runIds: [], postCommitEffects: [] }), promoteScheduledRetry: async () => ({ outcome: "not_promoted" }) },
    } as unknown as HeartbeatRetryDependencies;
    const retries = createHeartbeatRetries(db, deps);
    const schedule = () => retries.scheduleBoundedRetryForRun(source!, updatedAgent!, postStart
      ? { maxAttempts: 5, delayMs: 3_600_000 }
      : { retryReason: AI_CONNECTION_POOL_WAIT_RETRY_REASON, wakeReason: "ai_connection_pool_retry", maxAttempts: 5, delayMs: 3_600_000 });
    return { companyId, userId, agent: updatedAgent!, issue, source: source!, pool, members, selected, schedule, router,
      credentialIdentity: `${first.grantId}:fixture:${ref.secretId}:${secret!.aiSessionEpoch}` };
  }
  it.each(["direct", "parked", "unverified", "owned"] as const)(
    "uses a verified operator reconciliation at native pool admission (%s)", async mode => {
      const f = await fixture(false, false, "anthropic", { firstNative: true, backupCodex: true, backupNative: true });
      const binding = { companyId: f.companyId, agentId: f.agent.id, issueId: f.issue.id };
      const actionId = randomUUID();
      const sourceId = f.source.id;
      await db.update(heartbeatRuns).set({
        status: "failed", runtimeMode: "native", nativeIssueId: f.issue.id, errorCode: "native_provider_usage_limit",
        contextSnapshot: { ...f.source.contextSnapshot, aiRouterSelection: f.selected },
        resultJson: { summary: "The first change is saved.", apiToolReceipts: {
          original: { state: "completed", operationId: "update_issue", result: { ok: true } },
        } },
      }).where(eq(heartbeatRuns.id, sourceId));
      await db.insert(nativeRunFinalizations).values({
        companyId: f.companyId, issueId: f.issue.id, runId: sourceId, phase: "terminal_failure",
        failureCode: "native_provider_usage_limit", failureDetail: { replacementDenied: "operator_reconciled" },
      });
      await appendHeartbeatRunEvent(db, { ...binding, runId: sourceId, eventType: "native.local_process_stopped" });
      const [sourcePin] = await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, f.pool.id));
      const sourceCooldown = await f.router.currentMemberCooldown({
        companyId: f.companyId, agentId: f.agent.id, userId: f.userId,
        adapterType: f.agent.adapterType, member: sourcePin.member, failureKind: "quota",
      });
      const { row: quotaEvent } = await appendHeartbeatRunEvent(db, {
        ...binding, runId: sourceId, eventType: "ai_connection.quota_attributed",
        payload: { ...binding, runId: sourceId, schema: "paperclip.ai-connection-quota-attribution.v1",
          poolId: f.pool.id, taskKey: f.issue.id, memberId: f.selected.memberId, selection: f.selected,
          quotaIdentityHash: sourceCooldown?.identityHash },
      });
      await db.update(heartbeatRunEvents).set({ sourceEventId: `ai-connection-quota-attributed:${sourceId}` })
        .where(eq(heartbeatRunEvents.id, quotaEvent.id));
      const id = randomUUID();
      const context = { issueId: f.issue.id, recoveryActionId: actionId, source: "execution.reconciled",
        previousRunId: sourceId, retryOfRunId: sourceId, forceFreshSession: true };
      await db.insert(issueRecoveryActions).values({
        id: actionId, companyId: f.companyId, sourceIssueId: f.issue.id, kind: "active_run_watchdog", status: "resolved",
        ownerType: "board", returnOwnerAgentId: f.agent.id, cause: "uncertain_provider_action", fingerprint: sourceId, nextAction: "Continue the saved task",
        evidence: { runId: sourceId, continuationDelivery: mode === "parked" ? "delivered" : "pending",
          ...(mode === "parked" ? { continuationRunId: id } : {}),
          executionReconciliation: { runId: sourceId, providerStopped: mode !== "unverified",
            actionOutcome: "mixed", outcomeEvidence: "The first change has a completed receipt. The last action performed no write.",
            actorId: f.userId, recordedAt: new Date().toISOString() } },
      });
      await db.update(issues).set({
        executionRunId: mode === "owned" ? sourceId : null, checkoutRunId: null, responsibleUserId: f.userId,
      }).where(eq(issues.id, f.issue.id));
      if (mode === "direct") {
        const beforeProvider = vi.fn(async () => {
          await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agent.id));
          throw new Error("fixture stopped before provider start");
        });
        const heartbeat = heartbeatService(db, {
          runtimeEnv: {},
          beforeNativeRuntimeSelection: beforeProvider,
          nativeSessionBackendFactory: () => { throw new Error("Unexpected provider start"); },
        });
        try {
          const queued = await heartbeat.wakeup(f.agent.id, {
            source: "automation", triggerDetail: "system", reason: "issue_recovery_action_restored",
            requestedByActorType: "system", requestedByActorId: "execution-recovery",
            idempotencyKey: `execution-reconciliation:${actionId}`,
            payload: { issueId: f.issue.id, recoveryActionId: actionId },
            contextSnapshot: context,
          });
          expect(queued).not.toBeNull();
          await heartbeat.drainActiveRunExecutions();
          const saved = await heartbeat.getRun(queued!.id);
          expect(saved?.contextSnapshot?.aiRouterSelection).toMatchObject({
            memberId: f.members[1].id, binding: { provider: "openai" },
          });
          expect(beforeProvider).toHaveBeenCalledExactlyOnceWith(queued!.id);
        } finally {
          await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agent.id));
          await heartbeat.drainActiveRunExecutions();
        }
      } else {
        const [wake] = await db.insert(agentWakeupRequests).values({
          companyId: f.companyId, agentId: f.agent.id, source: "automation", triggerDetail: "system",
          reason: "issue_recovery_action_restored", requestedByActorType: "system", requestedByActorId: "execution-recovery",
          idempotencyKey: `execution-reconciliation:${actionId}`, payload: { issueId: f.issue.id, recoveryActionId: actionId },
          status: "queued",
        }).returning();
        let [candidate] = await db.insert(heartbeatRuns).values({
          ...binding, id, scopeKind: "issue", status: "queued", wakeupRequestId: wake.id,
          retryOfRunId: sourceId, contextSnapshot: context, responsibleUserId: f.userId,
        }).returning();
        await db.update(agentWakeupRequests).set({ runId: id }).where(eq(agentWakeupRequests.id, wake.id));
        if (mode === "parked") {
          await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "ai_connection_pool_exhausted",
            startedAt: new Date(), finishedAt: new Date(), executionStage: "settled",
            resultJson: { executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: false },
              cancellation: { source: "control_plane", expected: true, initiator: { type: "system" },
                reason: "Waiting for an AI connection pool account" } },
          }).where(eq(heartbeatRuns.id, id));
          const [parkedWake] = await db.insert(agentWakeupRequests).values({
            companyId: f.companyId, agentId: f.agent.id, source: "automation", triggerDetail: "system",
            reason: "ai_connection_pool_retry", requestedByActorType: "system", status: "queued",
            payload: { issueId: f.issue.id, retryOfRunId: id, retryReason: AI_CONNECTION_POOL_WAIT_RETRY_REASON },
          }).returning();
          [candidate] = await db.insert(heartbeatRuns).values({
            ...binding, scopeKind: "issue", status: "queued", wakeupRequestId: parkedWake.id,
            retryOfRunId: id, scheduledRetryReason: AI_CONNECTION_POOL_WAIT_RETRY_REASON,
            contextSnapshot: { ...context, retryOfRunId: id }, responsibleUserId: f.userId,
          }).returning();
          await db.update(agentWakeupRequests).set({ runId: candidate.id }).where(eq(agentWakeupRequests.id, parkedWake.id));
        }
        const admissions = await Promise.all([1, 2].map(() => preparePoolAdapterClaim(db, candidate, f.agent, f.userId)));
        if (mode === "unverified" || mode === "owned") {
          const [pin] = await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, f.pool.id));
          expect(pin.selection.memberId).toBe(f.selected.memberId);
          expect(admissions[0].adapterDispatch.poolPreparationFailure).toMatchObject({ kind: "exhausted" });
          return;
        }
        expect(admissions.map(item => item.context.aiRouterSelection?.binding.provider)).toEqual(["openai", "openai"]);
      }
      const [pin] = await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, f.pool.id));
      expect(pin.selection.memberId).toBe(f.members[1].id);
      const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, sourceId));
      expect(saved.resultJson?.apiToolReceipts).toEqual({ original: { state: "completed", operationId: "update_issue", result: { ok: true } } });
      expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId),
        sql`${activityLog.details}->>'reason' = 'provider_quota_failover'`))).toHaveLength(1);
    }, 30_000);
  it.each([429, 403])("continues a typed Claude quota failure without an account-wide cooldown when usage returns %s", async status => {
    const f = await fixture(true);
    await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.source.id));
    await db.delete(aiConnectionQuotaCooldowns).where(eq(aiConnectionQuotaCooldowns.companyId, f.companyId));
    const [source] = await db.update(heartbeatRuns).set({
      runnerProfileJson: { adapterDispatch: { adapterType: "claude_local" } },
      resultJson: { ...f.source.resultJson, terminalSessionFailure: { category: "limit", title: "You've hit your weekly limit" } },
    }).where(eq(heartbeatRuns.id, f.source.id)).returning();
    Object.assign(f.source, source);
    vi.mocked(globalThis.fetch).mockImplementation(async () => new Response("unavailable", { status }));
    expect((await f.schedule()).outcome).toBe("scheduled");
    expect(await db.select().from(aiConnectionQuotaCooldowns).where(eq(aiConnectionQuotaCooldowns.companyId, f.companyId))).toHaveLength(0);
    const [pin] = await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, f.pool.id));
    expect(pin.selection.memberId).toBe(f.members[1].id);
  }, 30_000);
  it.each([
    ...[0, 1, 2].flatMap(ordinaryRetries => [true, false].map(healthy => ({ ordinaryRetries, healthy, tamper: "none" }))),
    ...["selection", "marker"].map(tamper => ({ ordinaryRetries: 1, healthy: true, tamper })),
  ])("does not revisit exhausted credentials in a failover chain (healthy: $healthy, ordinary retries: $ordinaryRetries, tamper: $tamper)", async ({ healthy, ordinaryRetries, tamper }) => {
    const f = await fixture(true);
    await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.source.id));
    await db.delete(aiConnectionQuotaCooldowns).where(eq(aiConnectionQuotaCooldowns.companyId, f.companyId));
    const third = await aiConnectionService(db).save(f.companyId, f.userId, { provider: "anthropic", method: "subscription",
      ownership: "personal", name: "Third", loginSessionId: "fixture", agentIds: [], allAgents: true }, "fixture-three");
    const alias = { ...f.members[0], id: randomUUID() };
    const thirdMember = { ...f.members[0], id: randomUUID(), binding: { ...f.members[0].binding, ...third } };
    await db.update(aiConnectionPools).set({ config: { name: f.pool.name, enabled: true, mode: "failover", thresholdPercent: 90,
      members: [...f.members, alias, ...(healthy ? [thirdMember] : [])] } }).where(eq(aiConnectionPools.id, f.pool.id));
    const failure = { ...f.source.resultJson, terminalSessionFailure: { category: "limit", title: "You've hit your weekly limit" } };
    const [first] = await db.update(heartbeatRuns).set({ runnerProfileJson: { adapterDispatch: { adapterType: "claude_local" } },
      resultJson: failure }).where(eq(heartbeatRuns.id, f.source.id)).returning();
    Object.assign(f.source, first);
    vi.mocked(globalThis.fetch).mockImplementation(async () => new Response("unavailable", { status: 429 }));
    expect((await f.schedule()).outcome).toBe("scheduled");
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, first.id));
    expect(successor.contextSnapshot?.aiRouterSelection).toMatchObject({ memberId: f.members[1].id });
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, f.members[1].binding.grantId));
    const ref = grant.credentialSecretRefs[0];
    const [secret] = await db.select().from(companySecrets).where(eq(companySecrets.id, ref.secretId));
    let retry = successor;
    for (let index = 0; index < ordinaryRetries; index++) {
      await db.update(heartbeatRuns).set({ status: "failed", errorCode: "adapter_failed", finishedAt: new Date(),
        resultJson: { ...failure, errorFamily: "transient_upstream", terminalSessionFailure: undefined },
      }).where(eq(heartbeatRuns.id, retry.id));
      const [next] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agent.id,
        issueId: f.issue.id, scopeKind: "issue", runtimeMode: "legacy", status: "scheduled_retry",
        retryOfRunId: retry.id, responsibleUserId: f.userId, contextSnapshot: retry.contextSnapshot,
      }).returning();
      if (index === ordinaryRetries - 1 && tamper !== "none") {
        await db.update(heartbeatRuns).set({ contextSnapshot: { ...retry.contextSnapshot,
          ...(tamper === "selection" ? { aiRouterSelection: { ...(retry.contextSnapshot?.aiRouterSelection as Record<string, unknown>), memberId: randomUUID() } }
            : { aiPoolFailover: { sourceRunId: randomUUID() } }),
        } }).where(eq(heartbeatRuns.id, retry.id));
      }
      retry = next;
    }
    const [second] = await db.update(heartbeatRuns).set({ status: "failed", errorCode: "provider_quota", finishedAt: new Date(),
      runnerProfileJson: first.runnerProfileJson, resultJson: failure,
      contextSnapshot: { ...retry.contextSnapshot, aiConnection: { ...f.members[1].binding,
        sessionIdentity: `${grant.id}:fixture:${secret.id}:${secret.aiSessionEpoch}` } },
    }).where(eq(heartbeatRuns.id, retry.id)).returning();
    await db.update(issues).set({ executionRunId: second.id, checkoutRunId: second.id }).where(eq(issues.id, f.issue.id));
    Object.assign(f.source, second);
    expect((await f.schedule()).outcome).toBe(healthy && tamper === "none" ? "scheduled" : "not_scheduled");
    const [pin] = await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, f.pool.id));
    expect(pin.selection.memberId).toBe(healthy && tamper === "none" ? thirdMember.id : f.members[1].id);
  }, 30_000);
  it("rechecks missing account evidence when a settled quota run is retried after a transient probe failure", async () => {
    const f = await fixture(true);
    await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.source.id));
    await db.delete(aiConnectionQuotaCooldowns).where(eq(aiConnectionQuotaCooldowns.companyId, f.companyId));
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response("busy", { status: 429 }));
    expect(await recordVerifiedRouterQuotaCooldown(db, { companyId: f.companyId, agentId: f.agent.id,
      runId: f.source.id, credentialIdentity: f.credentialIdentity, retryNotBefore: null })).toBe(false);
    expect((await f.schedule()).outcome).toBe("scheduled");
    const [pin] = await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, f.pool.id));
    expect(pin.selection.memberId).toBe(f.members[1].id);
  }, 30_000);
  it.each(["healthy", "offline", "reconnected", "forged_adapter_hint", "confirmed"] as const)("requires account-side evidence for model-visible quota text (%s)", async mode => {
    const f = await fixture(true);
    await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.source.id));
    await db.delete(aiConnectionQuotaCooldowns).where(eq(aiConnectionQuotaCooldowns.companyId, f.companyId));
    await db.update(heartbeatRuns).set({ stdoutExcerpt: "You've hit your limit. Resets 2099-01-01", error: "Provider quota exhausted" }).where(eq(heartbeatRuns.id, f.source.id));
    const fetch = vi.mocked(globalThis.fetch);
    if (mode === "healthy" || mode === "forged_adapter_hint") fetch.mockImplementation(async () => new Response(JSON.stringify({ five_hour: { utilization: 10, resets_at: observedReset }, extra_usage: { is_enabled: false } })));
    if (mode === "offline") fetch.mockRejectedValue(new Error("Provider usage endpoint unavailable"));
    if (mode === "forged_adapter_hint") await db.update(heartbeatRuns).set({
      runnerProfileJson: { adapterDispatch: { adapterType: "claude_local", configuredAdapterType: "claude_local" } },
      contextSnapshot: { ...f.source.contextSnapshot, aiRouterSelection: { ...f.selected, adapterType: "codex_local" } },
    }).where(eq(heartbeatRuns.id, f.source.id));
    if (mode === "reconnected") fetch.mockImplementation(async () => {
      const secretId = f.credentialIdentity.split(":").at(-2)!;
      await db.update(companySecrets).set({ aiSessionEpoch: Number(f.credentialIdentity.split(":").at(-1)) + 1 }).where(eq(companySecrets.id, secretId));
      return new Response(JSON.stringify({ five_hour: { utilization: 100, resets_at: observedReset }, extra_usage: { is_enabled: false } }));
    });
    expect(await recordVerifiedRouterQuotaCooldown(db, { companyId: f.companyId, agentId: f.agent.id, runId: f.source.id,
      credentialIdentity: f.credentialIdentity, retryNotBefore: "2099-01-01T00:00:00.000Z" })).toBe(mode === "confirmed");
    const receipts = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.source.id));
    const cooldowns = await db.select().from(aiConnectionQuotaCooldowns).where(eq(aiConnectionQuotaCooldowns.companyId, f.companyId));
    if (mode === "confirmed") {
      expect(cooldowns).toHaveLength(1);
      expect(cooldowns[0].retryAt.toISOString()).toBe(observedReset);
      expect(receipts).toHaveLength(1);
      expect((await f.schedule()).outcome).toBe("scheduled");
    } else {
      expect(cooldowns).toHaveLength(0); expect(receipts).toHaveLength(0);
      expect((await f.schedule()).outcome).toBe("not_scheduled");
    }
  }, 30_000);
  it.each(["healthy", "offline", "confirmed"] as const)("requires Codex account evidence for forged quota text (%s)", async mode => {
    const f = await fixture(true, false, "openai");
    await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.source.id));
    await db.delete(aiConnectionQuotaCooldowns).where(eq(aiConnectionQuotaCooldowns.companyId, f.companyId));
    await db.update(heartbeatRuns).set({ stdoutExcerpt: "usage limit resets 2099-01-01", error: "Provider quota exhausted" }).where(eq(heartbeatRuns.id, f.source.id));
    if (mode === "offline") vi.mocked(globalThis.fetch).mockRejectedValue(new Error("offline"));
    else vi.mocked(globalThis.fetch).mockImplementation(async () => new Response(JSON.stringify({ rate_limit: { allowed: mode !== "confirmed", primary_window: { used_percent: mode === "confirmed" ? 100 : 10, reset_at: Math.ceil(Date.parse(observedReset) / 1000) } }, credits: { has_credits: false, unlimited: false } })));
    expect(await recordVerifiedRouterQuotaCooldown(db, { companyId: f.companyId, agentId: f.agent.id, runId: f.source.id,
      credentialIdentity: f.credentialIdentity, retryNotBefore: "2099-01-01T00:00:00.000Z" })).toBe(mode === "confirmed");
    const cooldowns = await db.select().from(aiConnectionQuotaCooldowns).where(eq(aiConnectionQuotaCooldowns.companyId, f.companyId));
    expect(cooldowns).toHaveLength(mode === "confirmed" ? 1 : 0);
    if (mode === "confirmed") expect(cooldowns[0].retryAt.getTime()).toBe(Math.ceil(Date.parse(observedReset) / 1000) * 1000);
    expect((await f.schedule()).outcome).toBe(mode === "confirmed" ? "scheduled" : "not_scheduled");
  }, 30_000);
  it.each(["healthy", "offline", "confirmed", "reconnected", "refreshed"] as const)("requires account-owned evidence for Codex auth text (%s)", async mode => {
    const f = await fixture(true, false, "openai");
    await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.source.id));
    await db.delete(aiConnectionQuotaCooldowns).where(eq(aiConnectionQuotaCooldowns.companyId, f.companyId));
    const runtime = await prepareManagedAiRuntime(db, { companyId: f.companyId, agentId: f.agent.id, responsibleUserId: f.userId,
      adapterType: "codex_local", config: f.selected.runtimeConfig, binding: f.selected.binding });
    if (!runtime) throw new Error("Expected the selected Codex account");
    const account = { ...runtime.attribution, identity: runtime.identity, sessionIdentity: runtime.sessionIdentity };
    await runtime.cleanup();
    const [failed] = await db.update(heartbeatRuns).set({ errorCode: "refresh_token_expired", startedAt: new Date(),
      stdoutExcerpt: "refresh token expired; retry after 2099-01-01", contextSnapshot: { ...f.source.contextSnapshot, aiConnection: account },
      resultJson: { ...f.source.resultJson, errorFamily: "refresh_token_expired" } }).where(eq(heartbeatRuns.id, f.source.id)).returning();
    Object.assign(f.source, failed);
    if (mode === "offline") vi.mocked(globalThis.fetch).mockRejectedValue(new Error("offline"));
    else if (mode === "healthy") vi.mocked(globalThis.fetch).mockImplementation(async () => new Response(JSON.stringify({ rate_limit: { allowed: true, primary_window: { used_percent: 10 } }, credits: { has_credits: false, unlimited: false } })));
    else vi.mocked(globalThis.fetch).mockImplementation(async () => {
      if (mode === "reconnected") await db.update(companySecrets).set({ aiSessionEpoch: Number(f.credentialIdentity.split(":").at(-1)) + 1 }).where(eq(companySecrets.id, f.credentialIdentity.split(":").at(-2)!));
      if (mode === "refreshed") {
        const secretId = f.credentialIdentity.split(":").at(-2)!;
        await secretService(db).rotate(secretId, { value: JSON.stringify({ tokens: { access_token: "refreshed-working-token", account_id: "fixture-account" } }), preserveAiSessionEpoch: true });
        expect((await db.select().from(companySecrets).where(eq(companySecrets.id,secretId)))[0].aiSessionEpoch).toBe(Number(f.credentialIdentity.split(":").at(-1)));
      }
      return new Response("unauthorized", { status: 401 });
    });
    const now = new Date();
    expect(await recordVerifiedRouterQuotaCooldown(db, { companyId: f.companyId, agentId: f.agent.id, runId: f.source.id,
      credentialIdentity: account.sessionIdentity, failureKind: "auth", retryNotBefore: "2099-01-01T00:00:00.000Z", now })).toBe(mode === "confirmed");
    const cooldowns = await db.select().from(aiConnectionQuotaCooldowns).where(eq(aiConnectionQuotaCooldowns.companyId, f.companyId));
    expect(cooldowns).toHaveLength(mode === "confirmed" ? 1 : 0);
    if (mode === "confirmed") expect(cooldowns[0].retryAt.getTime()).toBe(now.getTime() + 2 * 60 * 60_000);
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, f.members[0].binding.grantId));
    expect(grant.status).toBe(mode === "confirmed" ? "needs_reauthorization" : "active");
    expect((await f.schedule()).outcome).toBe(mode === "confirmed" ? "scheduled" : "not_scheduled");
  }, 30_000);
  it.each(["auth", "quota"] as const)("revalidates %s evidence refreshed before the final credential lock", async kind => {
    const f = await fixture(true, false, "openai");
    vi.mocked(globalThis.fetch).mockImplementation(async () => kind === "auth" ? new Response("unauthorized", { status: 401 }) : new Response(JSON.stringify({ rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 100, reset_at: Math.floor(Date.now() / 1000) + 3600 } }, credits: { has_credits: false, unlimited: false } })));
    const scope = {companyId:f.companyId,agentId:f.agent.id,userId:f.userId,selection:f.selected,credentialIdentity:f.credentialIdentity};
    const proof = await observeLegacyPoolAccountFailure(db,scope,new Date(),kind); expect(proof).not.toBeNull();
    await secretService(db).rotate(f.credentialIdentity.split(":").at(-2)!,{value:JSON.stringify({tokens:{access_token:"working-new-token",account_id:"fixture-account"}}),preserveAiSessionEpoch:true});
    expect(await db.transaction(tx=>isCurrentLegacyPoolAccountProof(tx as unknown as Db,scope,proof!))).toBe(kind === "quota");
  }, 30_000);
  it("refuses a historical legacy auth receipt without account evidence", async () => {
    const f = await fixture(true, false, "openai");
    await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.source.id));
    const [failed] = await db.update(heartbeatRuns).set({ errorCode: "refresh_token_expired", resultJson: { ...f.source.resultJson, errorFamily: "refresh_token_expired" } }).where(eq(heartbeatRuns.id, f.source.id)).returning(); Object.assign(f.source, failed);
    await db.insert(heartbeatRunEvents).values({ companyId:f.companyId,agentId:f.agent.id,runId:f.source.id,seq:1,eventType:"ai_connection.auth_attributed",sourceEventId:`ai-connection-auth-attributed:${f.source.id}`,payload:{schema:"paperclip.ai-connection-auth-attribution.v1",taskKey:f.issue.id,selection:f.selected} });
    expect((await f.schedule()).outcome).toBe("not_scheduled");
  }, 30_000);
  it("does not mark a healthy pool credential unusable through forged auth repair", async () => {
    const f = await fixture(true, false, "openai");
    const runtime = await prepareManagedAiRuntime(db, { companyId:f.companyId,agentId:f.agent.id,responsibleUserId:f.userId,adapterType:"codex_local",config:f.selected.runtimeConfig,binding:f.selected.binding });
    try {
      await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId,f.source.id));
      await db.update(issues).set({responsibleUserId:f.userId,createdByUserId:f.userId}).where(eq(issues.id,f.issue.id));
      await db.update(heartbeatRuns).set({startedAt:new Date(),finishedAt:new Date(),errorCode:"refresh_token_expired",resultJson:{...f.source.resultJson,errorFamily:"refresh_token_expired"},contextSnapshot:{...f.source.contextSnapshot,aiConnection:{...runtime!.attribution,identity:runtime!.identity}}}).where(eq(heartbeatRuns.id,f.source.id));
      const repair = await connectionIntentService(db).requestForRunAuthFailure(f.source.id);
      expect((await db.select().from(connectionGrants).where(eq(connectionGrants.id,f.members[0].binding.grantId)))[0].status).toBe("active");
      expect(repair).toBeNull();
    } finally { await runtime?.cleanup(); }
  }, 30_000);
  it("does not attribute model-visible runner panic text without a host crash signal", async () => {
    const f = await fixture(true, false, "openai");
    await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId,f.source.id));
    await db.delete(aiConnectionQuotaCooldowns).where(eq(aiConnectionQuotaCooldowns.companyId,f.companyId));
    const [failed]=await db.update(heartbeatRuns).set({errorCode:"codex_harness_crash",signal:null,exitCode:1,stdoutExcerpt:"thread panicked at panic.rs",resultJson:{...f.source.resultJson,errorFamily:"transient_upstream"}}).where(eq(heartbeatRuns.id,f.source.id)).returning();Object.assign(f.source,failed);
    expect(await recordVerifiedRouterQuotaCooldown(db,{companyId:f.companyId,agentId:f.agent.id,runId:f.source.id,credentialIdentity:f.credentialIdentity,failureKind:"runner",retryNotBefore:"2099-01-01T00:00:00.000Z"})).toBe(false);
    expect((await f.schedule()).outcome).toBe("scheduled");
    const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.source.id));
    expect(retry.contextSnapshot?.aiRouterSelection).toMatchObject({ memberId: f.members[0].id });
    expect(retry.contextSnapshot?.aiPoolFailover).toBeUndefined();
    expect(await db.select().from(aiConnectionQuotaCooldowns).where(eq(aiConnectionQuotaCooldowns.companyId,f.companyId))).toHaveLength(0);
  }, 30_000);
  it.each(["pending_invocation", "missing_result", "pending_provider_tool", "pending_semantic_tool", "incomplete_api_receipt"])("holds a local backup for %s until its outcome is receipted", async condition => {
    const f = await fixture(true);
    let invocationId: string | undefined;
    if (condition === "pending_invocation" || condition === "missing_result") {
      const [invocation] = await db.insert(toolInvocations).values({ companyId: f.companyId, agentId: f.agent.id, runId: f.source.id, toolName: "write_record", riskLevel: "write", status: condition === "pending_invocation" ? "executing" : "succeeded", completedAt: condition === "missing_result" ? new Date() : null }).returning();
      invocationId = invocation!.id;
    } else if (condition !== "incomplete_api_receipt") {
      await appendHeartbeatRunEvent(db, { companyId: f.companyId, agentId: f.agent.id, runId: f.source.id, stream: "system", level: "info", eventType: condition === "pending_semantic_tool" ? "semantic_tool.input" : "tool.execution.started", payload: { executionId: "write-1", name: "write_record", callId: "call-1", toolId: "tool-1", operationId: "updateRecord" } });
    } else {
      f.source.resultJson = { ...f.source.resultJson, apiToolReceipts: { write: { operationId: "updateRecord" } } };
      await db.update(heartbeatRuns).set({ resultJson: f.source.resultJson }).where(eq(heartbeatRuns.id, f.source.id));
    }
    expect(await f.schedule()).toMatchObject({ outcome: "not_scheduled", errorCode: "legacy_execution_requires_reconciliation" });
    expect((await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, f.pool.id)))[0]!.selection.memberId).toBe(f.members[0]!.id);
    if (invocationId) await db.update(toolInvocations).set({ status: "succeeded", completedAt: new Date(), resultHash: "receipted-result" }).where(eq(toolInvocations.id, invocationId));
    else if (condition !== "incomplete_api_receipt") await appendHeartbeatRunEvent(db, { companyId: f.companyId, agentId: f.agent.id, runId: f.source.id, stream: "system", level: "info", eventType: condition === "pending_semantic_tool" ? "semantic_tool.result" : "tool.execution.completed", payload: { executionId: "write-1", name: "write_record", status: "succeeded", callId: "call-1", toolId: "tool-1", operationId: "updateRecord", outcome: "succeeded" } });
    else { f.source.resultJson = { ...f.source.resultJson, apiToolReceipts: { write: { operationId: "updateRecord", result: { ok: true } } } }; await db.update(heartbeatRuns).set({ resultJson: f.source.resultJson }).where(eq(heartbeatRuns.id, f.source.id)); }
    expect((await f.schedule()).outcome).toBe("scheduled");
  });
  it("continues a quota-interrupted conversation on the next account with a fresh session", async () => {
    const f = await fixture(true);
    const result = await f.schedule();
    expect(result.outcome).toBe("scheduled");
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.source.id));
    expect(successor?.contextSnapshot?.aiRouterSelection).toMatchObject({ memberId: f.members[1]!.id });
    expect(successor?.contextSnapshot?.forceFreshSession).toBe(true);
    expect(successor?.contextSnapshot?.previousRunId).toBe(f.source.id);
    expect(successor?.sessionIdBefore).toBeNull();
    expect(successor!.scheduledRetryAt!.getTime()).toBeLessThan(Date.now() + 10_000);
  }, 30_000);
  it.each(["portable", "confined"])("continues a taskless Pool harness with its %s source policy", async policy => {
    const f = await fixture(true, true, "openai");
    const { harnessPoolService } = await import("../harness-pools.js");
    await harnessPoolService(db).convertV1(f.companyId, f.pool.id, f.pool.revision, false, f.userId);
    const [configured] = await db.update(agents).set({ adapterType: "paperclip_runner", adapterConfig: policy === "confined" ? { provider: "codex" } : { provider: "acpx", acpxAgent: "claude" },
      runtimeConfig: { harnessPool: { poolId: f.pool.id } } }).where(eq(agents.id, f.agent.id)).returning();
    Object.assign(f.agent, configured);
    const { instanceSettingsService } = await import("../instance-settings.js");
    await instanceSettingsService(db).updateExperimental({ enableNativeRunner: true });
    expect((await f.schedule()).outcome).toBe("scheduled");
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.source.id));
    expect(successor).toMatchObject({ scopeKind: "company", issueId: null });
    if (policy === "confined") {
      expect(successor.contextSnapshot?.aiRouterSelection).toMatchObject({ adapterType: "codex_local", memberId: f.members[0]!.id });
      expect(successor.scheduledRetryAt!.getTime()).toBeGreaterThan(Date.now() + 60_000);
      return;
    }
    expect(successor.contextSnapshot?.aiRouterSelection).toMatchObject({ adapterType: "claude_local", memberId: f.members[1]!.id });
    expect(successor.contextSnapshot?.aiRouterTaskKey).toBe(f.source.id);
    const admitted = await preparePoolAdapterClaim(db, successor, f.agent, f.userId);
    expect(admitted.adapterDispatch).toMatchObject({ adapterType: "claude_local", configuredAdapterType: "paperclip_runner", companyPoolExecution: true });
    expect(admitted.context.aiRouterSelection).toMatchObject({ memberId: f.members[1]!.id });
  }, 30_000);

  it("continues an agent heartbeat without an issue using bounded progress and the original affinity", async () => {
    const f = await fixture(true, true);
    expect((await f.schedule()).outcome).toBe("scheduled");
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.source.id));
    expect(successor?.scopeKind).toBe("company");
    expect(successor?.issueId).toBeNull();
    expect(successor?.contextSnapshot?.aiRouterSelection).toMatchObject({ memberId: f.members[1]!.id });
    expect(successor?.contextSnapshot?.aiRouterTaskKey).toBe(f.source.id);
    expect(successor?.contextSnapshot?.paperclipSessionHandoffMarkdown).toContain("Completed the first change");
    expect(successor?.contextSnapshot?.forceFreshSession).toBe(true);
  }, 30_000);
  it("serializes Stop for a failed background run without an issue", async () => {
    const f = await fixture(true, true);
    expect(await fenceLegacyQuotaPrestartStop(db, { companyId: f.companyId, runId: f.source.id, issueId: null })).toMatchObject({ kind: "fenced" });
    expect((await f.schedule()).outcome).toBe("not_scheduled");
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.source.id))).toHaveLength(0);
  }, 30_000);
  it("creates one backup successor when two workers reconcile the same interrupted run", async () => {
    const f = await fixture(true);
    const results = await Promise.all([f.schedule(), f.schedule()]);
    expect(results.every(result => result.outcome === "scheduled")).toBe(true);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.source.id))).toHaveLength(1);
    const [pin] = await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, f.pool.id));
    expect(pin?.selection.memberId).toBe(f.members[1]!.id);
  }, 30_000);
  it("does not commit a changed pin when the original user continuation is denied", async () => {
    const f = await fixture(true);
    const [source] = await db.update(heartbeatRuns).set({ contextSnapshot: { ...f.source.contextSnapshot,
      explicitUserContinuation: { previousRunId: randomUUID() } } }).where(eq(heartbeatRuns.id, f.source.id)).returning();
    Object.assign(f.source, source);
    expect((await f.schedule()).outcome).toBe("not_scheduled");
    const [pin] = await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, f.pool.id));
    expect(pin?.selection.memberId).toBe(f.members[0]!.id);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.source.id))).toHaveLength(0);
  }, 30_000);
  it("attributes quota after a task changes model effort without changing its pinned account", async () => {
    const f = await fixture(true);
    const selection = { ...f.selected, runtimeConfig: { ...f.selected.runtimeConfig, effort: "low" }, notes: ["Task effort override"] };
    const [source] = await db.update(heartbeatRuns).set({ contextSnapshot: { ...f.source.contextSnapshot, aiRouterSelection: selection } })
      .where(eq(heartbeatRuns.id, f.source.id)).returning();
    Object.assign(f.source, source);
    await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.source.id));
    expect(await recordVerifiedRouterQuotaCooldown(db, { companyId: f.companyId, agentId: f.agent.id, runId: f.source.id,
      credentialIdentity: f.credentialIdentity, retryNotBefore: null })).toBe(true);
    expect((await f.schedule()).outcome).toBe("scheduled");
  }, 30_000);
  it("attributes and switches after editing only the pool member model and effort", async () => {
    const f = await fixture(true);
    await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.source.id));
    await db.update(aiConnectionPools).set({ config: { name: f.pool.name, enabled: f.pool.enabled, mode: f.pool.mode, thresholdPercent: f.pool.thresholdPercent, members: f.members.map(member => ({
      ...member, profile: { ...member.profile, model: "claude-opus-5", effort: "high" },
    })) } }).where(eq(aiConnectionPools.id, f.pool.id));
    expect(await recordVerifiedRouterQuotaCooldown(db, { companyId: f.companyId, agentId: f.agent.id,
      runId: f.source.id, credentialIdentity: f.credentialIdentity, retryNotBefore: null })).toBe(true);
    expect((await f.schedule()).outcome).toBe("scheduled");
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.source.id));
    expect(successor.contextSnapshot?.aiRouterSelection).toMatchObject({ memberId: f.members[1].id,
      runtimeConfig: { model: "claude-opus-5" } });
  }, 30_000);
  it.each(["binding", "revoked", "removed"])("retains source attribution but refuses changed successor authority (%s)", async change => {
    const f = await fixture(true);
    if (change === "binding") await db.update(aiConnectionPools).set({ config: { name: f.pool.name, enabled: f.pool.enabled, mode: f.pool.mode, thresholdPercent: f.pool.thresholdPercent,
      members: [{ ...f.members[0], binding: f.members[1].binding }, f.members[1]] } }).where(eq(aiConnectionPools.id, f.pool.id));
    else if (change === "removed") await db.update(aiConnectionPools).set({ config: { name: f.pool.name, enabled: f.pool.enabled, mode: f.pool.mode, thresholdPercent: f.pool.thresholdPercent, members: [f.members[1]] } }).where(eq(aiConnectionPools.id, f.pool.id));
    else await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, f.members[0].binding.grantId));
    if (change !== "revoked") {
      await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.source.id));
      expect(await recordVerifiedRouterQuotaCooldown(db, { companyId: f.companyId, agentId: f.agent.id,
        runId: f.source.id, credentialIdentity: f.credentialIdentity, retryNotBefore: null })).toBe(true);
      expect(await f.router.accountCooldown(f.companyId, f.members[0].binding.connectionId, `secret:${f.credentialIdentity.split(":").slice(-2).join(":")}`)).toBeInstanceOf(Date);
    }
    expect((await f.schedule()).outcome).toBe("not_scheduled");
  }, 30_000);
  it.each(["stop", "started", "claim", "lineage", "receipt", "race"])("reselects only an unstarted authorized successor (%s)", async condition => {
    const f = await fixture(true);
    // Cool every current credential, then reconnect only the other account.
    for (const member of f.members) {
      const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, member.binding.grantId));
      const ref = grant.credentialSecretRefs[0];
      const [secret] = await db.select().from(companySecrets).where(eq(companySecrets.id, ref.secretId));
      await aiConnectionRouterService(db).recordQuotaCooldown(f.companyId, member.binding.connectionId,
        `secret:${secret.id}:${secret.aiSessionEpoch}`, new Date(Date.now() + (member.id === f.members[0].id ? 2 : 3) * 60 * 60_000));
    }
    expect((await f.schedule()).outcome).toBe("scheduled");
    let [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.source.id));
    expect(successor.contextSnapshot?.aiRouterSelection).toMatchObject({ memberId: f.members[0].id });
    await aiConnectionService(db).save(f.companyId, f.userId, { connectionId: f.members[1].binding.connectionId,
      provider: "anthropic", method: "subscription", ownership: "personal", name: "Second", loginSessionId: "fixture", agentIds: [], allAgents: true }, "reconnected");
    if (condition === "stop") await fenceLegacyQuotaPrestartStop(db, { companyId: f.companyId, runId: f.source.id, issueId: f.issue.id });
    if (condition === "started") await db.update(heartbeatRuns).set({ startedAt: new Date() }).where(eq(heartbeatRuns.id, successor.id));
    if (condition === "claim") await db.update(heartbeatRuns).set({ runnerProfileJson: { adapterDispatch: { adapterType: "claude_local" } } }).where(eq(heartbeatRuns.id, successor.id));
    if (condition === "lineage") await db.update(heartbeatRuns).set({ retryOfRunId: null }).where(eq(heartbeatRuns.id, successor.id));
    if (condition === "receipt") await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.source.id));
    [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successor.id));
    if (condition === "race") {
      const prepared = await Promise.all([preparePoolAdapterClaim(db, successor, f.agent, f.userId), preparePoolAdapterClaim(db, successor, f.agent, f.userId)]);
      expect(prepared.every(result => result.context.aiRouterSelection?.memberId === f.members[1].id)).toBe(true);
    } else await preparePoolAdapterClaim(db, successor, f.agent, f.userId);
    const [pin] = await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, f.pool.id));
    expect(pin.selection.memberId).toBe(f.members[condition === "race" ? 1 : 0].id);
  }, 30_000);
  it.each(["auth", "runner"] as const)("uses the backup after a confirmed %s failure", async failureKind => {
    const f = await fixture(true);
    if (failureKind === "auth") vi.mocked(globalThis.fetch).mockImplementation(async () => new Response("unauthorized", { status: 401 }));
    const [failed] = await db.update(heartbeatRuns).set({ signal: failureKind === "runner" ? "SIGABRT" : null, errorCode: failureKind === "auth" ? "claude_auth_required" : "codex_harness_crash",
      resultJson: { ...f.source.resultJson, errorFamily: failureKind === "auth" ? "refresh_token_expired" : "transient_upstream" } })
      .where(eq(heartbeatRuns.id, f.source.id)).returning();
    Object.assign(f.source, failed);
    expect(await recordVerifiedRouterQuotaCooldown(db, { companyId: f.companyId, agentId: f.agent.id, runId: f.source.id,
      credentialIdentity: f.credentialIdentity, retryNotBefore: null, failureKind })).toBe(true);
    expect((await f.schedule()).outcome).toBe("scheduled");
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.source.id));
    expect(successor?.contextSnapshot?.aiRouterSelection).toMatchObject({ memberId: f.members[1]!.id });
    expect(successor?.contextSnapshot?.aiPoolFailover).toMatchObject({ reason: failureKind });
  }, 30_000);
  it.each(["stop", "unsettled", "missing_receipt", "unverified_quota_receipt", "reassigned", "paused"] as const)("does not switch the failed pin when %s prevents continuation", async condition => {
    const f = await fixture(true);
    if (condition === "stop") await db.update(heartbeatRuns).set({ resultJson: { ...f.source.resultJson, legacyQuotaStopRequested: { requestedAt: new Date().toISOString() } } }).where(eq(heartbeatRuns.id, f.source.id));
    if (condition === "unsettled") await db.update(heartbeatRuns).set({ resultJson: { ...f.source.resultJson, executionSettlement: undefined } }).where(eq(heartbeatRuns.id, f.source.id));
    if (condition === "missing_receipt") {
      await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.source.id));
      vi.mocked(globalThis.fetch).mockResolvedValue(new Response("busy", { status: 429 }));
    }
    if (condition === "unverified_quota_receipt") {
      const [receipt] = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.source.id));
      const { providerEvidence: _ignored, ...oldPayload } = receipt.payload!;
      await db.update(heartbeatRunEvents).set({ payload: oldPayload }).where(eq(heartbeatRunEvents.id, receipt.id));
    }
    if (condition === "reassigned") await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, f.issue.id));
    if (condition === "paused") await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agent.id));
    expect((await f.schedule()).outcome).toBe("not_scheduled");
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.source.id))).toHaveLength(0);
    const [pin] = await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, f.pool.id));
    expect(pin?.selection.memberId).toBe(f.members[0]!.id);
  }, 30_000);
  it("waits for the earliest backup cooldown when every account is exhausted", async () => {
    const f = await fixture(true);
    const second = f.members[1]!;
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, second.binding.grantId));
    const ref = grant!.credentialSecretRefs.find(item => item.configPath === "ai.credential")!;
    const [secret] = await db.select().from(companySecrets).where(eq(companySecrets.id, ref.secretId));
    const deadline = new Date(Date.now() + 30 * 60_000);
    await f.router.recordQuotaCooldown(f.companyId, second.binding.connectionId, `secret:${ref.secretId}:${secret!.aiSessionEpoch}`, deadline);
    expect((await f.schedule()).outcome).toBe("scheduled");
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.source.id));
    expect(successor?.contextSnapshot?.aiRouterSelection).toMatchObject({ memberId: second.id });
    expect(successor?.scheduledRetryAt?.getTime()).toBe(deadline.getTime());
    expect(successor?.contextSnapshot?.aiPoolFailover).toMatchObject({ reason: "quota", waitingUntil: deadline.toISOString() });
    await expect(db.transaction(async tx => {
      expect(await reopenNativeQuotaPoolWaits(tx as unknown as Db, { companyId: f.companyId, poolId: f.pool.id })).toBe(1);
      throw new Error("rollback reconnect");
    })).rejects.toThrow("rollback reconnect");
    const [unchanged] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successor!.id));
    expect(unchanged?.scheduledRetryAt?.getTime()).toBe(deadline.getTime());
    expect(await db.transaction(tx => reopenNativeQuotaPoolWaits(tx as unknown as Db, { companyId: f.companyId, poolId: f.pool.id }))).toBe(1);
    const [reopened] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successor!.id));
    expect(reopened!.scheduledRetryAt!.getTime()).toBeLessThan(Date.now() + 1_000);
  }, 30_000);
  async function historicalWait(runtimeMode: "legacy" | "native" = "legacy") {
    const f = await fixture(false, false, "anthropic", { firstNative: runtimeMode === "native", backupCodex: true, backupNative: runtimeMode === "native" });
    const priorAdapter = runtimeMode === "native" ? "paperclip_runner" : "claude_local";
    const [contract] = runtimeMode === "native" ? await db.insert(completionContracts).values({
      companyId: f.companyId, issueId: f.issue.id, revision: 1, schemaVersion: "v1", policyVersion: "v1",
      risk: "low", completionAuthority: "agent_claim_policy", incompleteCriteriaPolicy: "block",
      contractJson: {}, canonicalSha256: "fixture-contract", createdByActorType: "system", createdByActorId: "system",
    }).returning() : [];
    const priorStartedAt = new Date(f.source.startedAt!.getTime() - 60_000);
    const priorFinishedAt = new Date(f.source.startedAt!.getTime() - 30_000);
    const [predecessor] = await db.insert(heartbeatRuns).values({
      companyId: f.companyId, agentId: f.agent.id, issueId: f.issue.id, scopeKind: "issue",
      status: "succeeded", runtimeMode, executionStage: "dispatching",
      ...(contract ? { nativeIssueId: f.issue.id, nativeSessionId: randomUUID(), completionContractId: contract.id }
        : { processPid: 1234, processGroupId: 1234, processStartedAt: priorStartedAt }),
      createdAt: priorStartedAt, startedAt: priorStartedAt, finishedAt: priorFinishedAt,
      contextSnapshot: { issueId: f.issue.id, aiRouterTaskKey: f.issue.id, aiRouterSelection: f.selected },
      sessionIdAfter: "prior-private-session", responsibleUserId: f.userId,
      resultJson: contract ? { workspaceFinalizeStatus: "succeeded",
        semanticToolReceipts: { completed: { operationId: "paperclip_get_issue", result: {} } } }
        : { executionSettlement: { providerStopped: true, workspaceSettled: true, actionOutcomes: "unknown" },
          acpToolInventoryComplete: true, acpPendingToolCount: 0, summary: "Implementation is done. Verification remains." },
    }).returning();
    if (contract) {
      const [accepted] = await db.insert(nativeRunResults).values({ companyId: f.companyId, issueId: f.issue.id, runId: predecessor.id,
        completionContractId: contract.id, serverFingerprint: "accepted", schemaStatus: "accepted",
        resultJson: { summary: "Implementation is done. Verification remains." }, canonicalSha256: "accepted" }).returning();
      await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId: f.issue.id,
        runId: predecessor.id, phase: "committed", resultId: accepted.id });
    }
    await db.update(aiConnectionTaskPins).set({ createdAt: priorStartedAt }).where(eq(aiConnectionTaskPins.poolId, f.pool.id));
    await db.insert(agentTaskSessions).values({ companyId: f.companyId, agentId: f.agent.id, taskKey: f.issue.id,
      adapterType: priorAdapter, sessionDisplayId: predecessor.sessionIdAfter, lastRunId: predecessor.id });
    const [source] = await db.update(heartbeatRuns).set({
      // Existing waiting rows predate the first-claim fence.
      runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner",
        poolPreparationFailure: { kind: "exhausted", poolId: f.pool.id, retryAt: observedReset } } },
      resultJson: { ...f.source.resultJson, cancellation: { source: "control_plane", expected: true,
        initiator: { type: "system" }, reason: "Waiting for an AI connection pool account",
        recordedAt: f.source.finishedAt!.toISOString() }, retryAt: observedReset },
      contextSnapshot: { ...f.source.contextSnapshot, aiRouterPoolId: f.pool.id },
      sessionIdBefore: predecessor.sessionIdAfter,
      executionStage: "settled",
    }).where(eq(heartbeatRuns.id, f.source.id)).returning();
    Object.assign(f.source, source);
    return { ...f, predecessor };
  }

  it.each(["legacy", "native"] as const)(
    "switches an exhausted historical %s Claude pin to a fresh Codex session on the same issue", async runtimeMode => {
    const f = await historicalWait(runtimeMode);
    expect((await f.schedule()).outcome).toBe("scheduled");
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.source.id));
    expect(successor).toMatchObject({ companyId: f.companyId, issueId: f.issue.id, agentId: f.agent.id,
      responsibleUserId: f.userId, sessionIdBefore: null, contextSnapshot: {
        aiRouterSelection: { memberId: f.members[1].id, adapterType: runtimeMode === "native" ? "paperclip_runner" : "codex_local" }, forceFreshSession: true, previousRunId: f.predecessor.id,
      },
    });
    expect(successor.scheduledRetryAt!.getTime()).toBeLessThan(Date.now() + 1000);
    expect(JSON.stringify(successor.contextSnapshot)).not.toContain("prior-private-session");
    const continuation = await buildExecutionContinuation({ db, companyId: f.companyId, issueId: f.issue.id,
      agentId: f.agent.id, runId: successor.id, context: successor.contextSnapshot!, summary: null, exposeLowTrustRaw: false });
    expect(continuation.trigger.sourceRunId).toBe(f.source.id);
    expect(continuation.completedWork).toBe("Implementation is done. Verification remains.");
    const fake = randomUUID();
    const tampered = await buildExecutionContinuation({ db, companyId: f.companyId, issueId: f.issue.id, agentId: f.agent.id,
      runId: successor.id, context: { ...successor.contextSnapshot, previousRunId: fake,
        aiPoolPreDispatchHandoff: { sourceRunId: f.source.id, predecessorRunId: fake } },
      summary: null, exposeLowTrustRaw: false });
    expect(tampered.completedWork).toBeNull();
  }, 30_000);

  it.each(["succeeded", "missing", "failed", "different_turn"] as const)(
    "requires a same-turn successful native PRP tool receipt before switching (%s)", async outcome => {
      const f = await historicalWait("native");
      const sourceInstanceId = randomUUID();
      const correlation = { runId: f.predecessor.id, normalizedSessionId: f.predecessor.nativeSessionId!,
        turnId: "prior-turn", itemId: "read-item" };
      const call = { callId: "get-issue-call", operationId: "paperclip_get_issue", correlation, content: { issueId: f.issue.id } };
      const append = async (eventType: "semantic_tool.input" | "semantic_tool.result", sourceSeq: number,
        semanticTool: ReturnType<typeof createPrpSemanticToolInputEnvelope>) => {
        const event = { schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceKind: "runner", sourceInstanceId,
          sourceEventId: `semantic-${sourceSeq}`, sourceSeq, runId: correlation.runId,
          normalizedSessionId: correlation.normalizedSessionId, turnId: semanticTool.correlation.turnId,
          itemId: correlation.itemId, eventType, priority: 0, emittedAt: new Date().toISOString(),
          payload: { semantic_tool: semanticTool } };
        await appendHeartbeatRunEvent(db, { companyId: f.companyId, runId: f.predecessor.id, agentId: f.agent.id, eventType,
          payload: { prpEvent: event },
          nativeSource: { sourceInstanceId, sourceEventId: event.sourceEventId, sourceSeq, protocolSchemaVersion: 1,
            canonicalPayload: event } });
      };
      await append("semantic_tool.input", 1, createPrpSemanticToolInputEnvelope(call));
      if (outcome !== "missing") {
        await append("semantic_tool.result", 2, createPrpSemanticToolResultEnvelope({ ...call,
          correlation: outcome === "different_turn" ? { ...correlation, turnId: "different-turn" } : correlation,
          outcome: outcome === "failed" ? "failed" : "succeeded", code: "fixture_result",
          authorizationBoundary: "active_task", retryable: false,
        }));
      }
      expect((await f.schedule()).outcome).toBe("scheduled");
      const [pin] = await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, f.pool.id));
      expect(pin.selection.memberId).toBe(f.members[outcome === "succeeded" ? 1 : 0].id);
    }, 30_000);

  async function recordBackupCooldown(f: Awaited<ReturnType<typeof historicalWait>>, retryAt: Date) {
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, f.members[1].binding.grantId));
    const [secret] = await db.select().from(companySecrets).where(eq(companySecrets.id, grant.credentialSecretRefs[0].secretId));
    const identity = `secret:${secret.id}:${secret.aiSessionEpoch}`;
    await f.router.recordQuotaCooldown(f.companyId, f.members[1].binding.connectionId, identity, retryAt);
    return identity;
  }

  it("schedules a settled historical quota wait at the earlier backup reset", async () => {
    const f = await historicalWait();
    const backupReset = new Date(Date.now() + 5 * 60_000);
    await recordBackupCooldown(f, backupReset);

    expect((await f.schedule()).outcome).toBe("scheduled");
    const [waiting] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.source.id));
    expect(waiting.scheduledRetryAt).toEqual(backupReset);
    expect(waiting.contextSnapshot).toMatchObject({ scheduledRetryAt: backupReset.toISOString(), poolWaitScope: "pool" });
    expect(waiting.contextSnapshot?.forceFreshSession).toBeUndefined();
    const [pin] = await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, f.pool.id));
    expect(pin.member.id).toBe(f.members[0].id);
  }, 30_000);

  it.each(["queued", "scheduled_retry"] as const)("reconsiders an already persisted %s quota wait", async status => {
    const f = await historicalWait();
    const backupIdentity = await recordBackupCooldown(f, new Date(Date.now() + 3_600_000));
    expect((await f.schedule()).outcome).toBe("scheduled");
    const [waiting] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.source.id));
    expect(waiting.scheduledRetryAt!.getTime()).toBeGreaterThan(Date.now() + 60_000);
    await db.delete(aiConnectionQuotaCooldowns).where(and(eq(aiConnectionQuotaCooldowns.companyId, f.companyId),
      eq(aiConnectionQuotaCooldowns.credentialIdentity, backupIdentity)));
    if (status === "scheduled_retry") {
      await db.transaction(tx => reopenNativeQuotaPoolWaits(tx as unknown as Db, { companyId: f.companyId, poolId: f.pool.id }));
      const [reopened] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, waiting.id));
      expect(reopened.scheduledRetryAt!.getTime()).toBeLessThan(Date.now() + 1000);
      expect(reopened.contextSnapshot?.poolWaitScope).toBeUndefined();
    }
    const [candidate] = await db.update(heartbeatRuns).set({ status: "queued", sessionIdBefore: f.predecessor.sessionIdAfter })
      .where(eq(heartbeatRuns.id, waiting.id)).returning();
    const handoff = { aiRouterSelection: { memberId: f.members[1].id }, forceFreshSession: true, previousRunId: f.predecessor.id };
    if (status === "queued") {
      await db.insert(agentTaskSessions).values({ companyId: f.companyId, agentId: f.agent.id, taskKey: f.issue.id,
        adapterType: "codex_local", sessionDisplayId: "old-codex-session", sessionParamsJson: { paperclipAiCredentialIdentity: "old-grant" } });
      const claims = await Promise.all([
        preparePoolAdapterClaim(db, candidate, f.agent, f.userId),
        preparePoolAdapterClaim(db, candidate, f.agent, f.userId),
      ]);
      expect(claims).toMatchObject([{ context: handoff }, { context: handoff }]);
    } else {
      expect(await preparePoolAdapterClaim(db, candidate, f.agent, f.userId)).toMatchObject({ context: handoff });
    }
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, candidate.id));
    expect(successor.sessionIdBefore).toBeNull();
    expect(successor.scheduledRetryAt!.getTime()).toBeLessThan(Date.now() + 1000);
  }, 30_000);

  it.each(["pending_action", "unsettled", "private_owner", "pending_interaction", "stop", "newer_active",
    "unproven_source", "source_provider_event", "quota_reset"])(
    "keeps the historical pin when %s prevents safe predispatch failover", async condition => {
      const f = await historicalWait();
      if (condition === "pending_action") await appendHeartbeatRunEvent(db, {
        companyId: f.companyId, agentId: f.agent.id, runId: f.predecessor.id,
        eventType: "tool.execution.started", stream: "system", level: "info", message: "Began an external action",
        payload: { executionId: "exec", name: "shell" },
      });
      if (condition === "unsettled" || condition === "private_owner") {
        await db.update(heartbeatRuns).set(condition === "unsettled"
          ? { resultJson: { ...f.predecessor.resultJson, executionSettlement: undefined } }
          : { responsibleUserId: null }).where(eq(heartbeatRuns.id, f.predecessor.id));
      }
      if (condition === "pending_interaction") await db.insert(issueThreadInteractions).values({
        companyId: f.companyId, issueId: f.issue.id, kind: "request_confirmation", payload: {} as never,
      });
      if (condition === "stop") expect(await fenceLegacyQuotaPrestartStop(db, { companyId: f.companyId,
        issueId: f.issue.id, runId: f.source.id })).toMatchObject({ kind: "fenced" });
      if (condition === "newer_active") await db.insert(heartbeatRuns).values({
        companyId: f.companyId, agentId: f.agent.id, issueId: f.issue.id, scopeKind: "issue", status: "running",
      });
      if (condition === "unproven_source") await db.update(heartbeatRuns).set({ runnerProfileJson: {} })
        .where(eq(heartbeatRuns.id, f.source.id));
      if (condition === "source_provider_event") await appendHeartbeatRunEvent(db, {
        companyId: f.companyId, agentId: f.agent.id, runId: f.source.id,
        eventType: "turn.started", stream: "system", level: "info", message: "Started a provider turn",
      });
      if (condition === "quota_reset") await db.delete(aiConnectionQuotaCooldowns)
        .where(eq(aiConnectionQuotaCooldowns.companyId, f.companyId));
      expect((await f.schedule()).outcome).toBe(condition === "stop" ? "not_scheduled" : "scheduled");
      const [pin] = await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, f.pool.id));
      expect(pin.selection.memberId).toBe(f.members[0].id);
    }, 30_000);

  it("atomically switches one pin and creates one immediate successor across concurrent claims", async () => {
    const f = await fixture();
    const results = await Promise.all([f.schedule(), f.schedule()]);
    expect(results.every(result => result.outcome === "scheduled")).toBe(true);
    const successors = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.source.id));
    expect(successors).toHaveLength(1);
    expect(successors[0]!.scheduledRetryAt!.getTime()).toBeLessThan(Date.now() + 10_000);
    const [pin] = await db.select().from(aiConnectionTaskPins).where(and(eq(aiConnectionTaskPins.poolId, f.pool.id), eq(aiConnectionTaskPins.taskKey, f.issue.id)));
    expect(pin?.selection.memberId).toBe(f.members[1]!.id);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.runId, successors[0]!.id))).toHaveLength(1);
  }, 30_000);
  it("rolls back a pin switch on transaction failure", async () => {
    const f = await fixture();
    await expect(db.transaction(async tx => {
      await tx.select().from(issues).where(eq(issues.id, f.issue.id)).for("update");
      await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.source.id)).for("update");
      expect(await switchUnstartedLegacyQuotaPin(tx as unknown as Db, { companyId: f.companyId, issueId: f.issue.id, agentId: f.agent.id, runId: f.source.id, userId: f.userId })).toMatchObject({ memberId: f.members[1]!.id });
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    const [pin] = await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, f.pool.id));
    expect(pin?.selection.memberId).toBe(f.members[0]!.id);
  }, 30_000);
  it("serializes Stop against successor creation", async () => {
    const f = await fixture();
    const [result, stop] = await Promise.all([f.schedule(), fenceLegacyQuotaPrestartStop(db, { companyId: f.companyId, issueId: f.issue.id, runId: f.source.id })]);
    const successors = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.source.id));
    if (stop?.kind === "fenced") { expect(successors).toHaveLength(0); expect(result.outcome).toBe("not_scheduled"); }
    else { expect(stop).toMatchObject({ kind: "successor", run: { id: successors[0]?.id } }); expect(successors).toHaveLength(1); }
  }, 30_000);
  it.each(["consumed", "session", "history", "native_history", "explicit_resume", "context_taskId", "context_taskKey", "context_identifier", "payload_taskId", "payload_taskKey", "payload_issueId"] as const)("keeps the existing pin when %s makes the handoff uncertain", async condition => {
    const f = await fixture();
    if (condition === "consumed") await db.update(heartbeatRuns).set({ runnerProfileJson: { legacyQuotaPrestartFence: {
      schema: "paperclip.legacy-quota-prestart.v1", companyId: f.companyId, agentId: f.agent.id, runId: f.source.id, state: "consumed" } } }).where(eq(heartbeatRuns.id, f.source.id));
    if (condition === "session") await db.insert(agentTaskSessions).values({ companyId: f.companyId, agentId: f.agent.id, adapterType: "claude_local", taskKey: f.issue.id, sessionDisplayId: "old-session" });
    if (condition === "history") await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agent.id, issueId: f.issue.id, scopeKind: "issue", status: "succeeded" });
    if (condition === "native_history") await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agent.id, nativeIssueId: f.issue.id, status: "succeeded" });
    if (condition.startsWith("context_")) {
      const key = condition === "context_identifier" ? "taskKey" : condition.slice("context_".length);
      await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agent.id, status: "succeeded", contextSnapshot: { [key]: condition === "context_identifier" ? f.issue.identifier : f.issue.id } });
    }
    if (condition.startsWith("payload_")) {
      const key = condition.slice("payload_".length);
      const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agent.id, source: "automation", payload: { [key]: f.issue.identifier } }).returning();
      await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agent.id, status: "succeeded", wakeupRequestId: wake.id });
    }
    if (condition === "explicit_resume") await db.update(heartbeatRuns).set({ contextSnapshot: { ...f.source.contextSnapshot, resumeSessionParams: { sessionId: "old" } } }).where(eq(heartbeatRuns.id, f.source.id));
    const result = await f.schedule();
    expect(result.outcome).toBe("scheduled");
    const [pin] = await db.select().from(aiConnectionTaskPins).where(eq(aiConnectionTaskPins.poolId, f.pool.id));
    expect(pin?.selection.memberId).toBe(f.members[0]!.id);
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.source.id));
    expect(successor!.scheduledRetryAt!.getTime()).toBeGreaterThan(Date.now() + 60_000);
  }, 30_000);
});
