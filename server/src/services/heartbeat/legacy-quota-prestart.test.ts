import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { agentTaskSessions, agentWakeupRequests, agents, aiConnectionPools, aiConnectionQuotaCooldowns, aiConnectionTaskPins, authUsers, companies, companyMemberships, companySecrets, connectionGrants, createDb, heartbeatRunEvents, heartbeatRuns, issues, toolInvocations, type Db } from "@paperclipai/db";
import { BUILTIN_AI_FAILOVER_ROUTER_KEY } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { aiConnectionService } from "../ai-connections.js";
import { aiConnectionRouterService } from "../ai-connection-router.js";
import { AI_CONNECTION_POOL_WAIT_RETRY_REASON } from "../../modules/run-dispatch/index.js";
import { createHeartbeatRetries, type HeartbeatRetryDependencies } from "./retries.js";
import { fenceLegacyQuotaPrestartStop, switchUnstartedLegacyQuotaPin } from "./quota-prestart-fence.js";
import { preparePoolAdapterClaim } from "./effective-run-adapter.js";
import { recordVerifiedRouterQuotaCooldown } from "./run-completion.js";
import { reopenNativeQuotaPoolWaits } from "../native-runtime/native-quota-wake.js";

describe("legacy quota prestart retry", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db, home: string;
  beforeAll(async () => { home = await mkdtemp(path.join(os.tmpdir(), "quota-prestart-home-")); vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "legacy-quota-test"); database = await startEmbeddedPostgresTestDatabase("legacy-quota-prestart-"); db = createDb(database.connectionString, { maxConnections: 8 }); }, 90_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); vi.unstubAllEnvs(); if (home) await rm(home, { recursive: true, force: true }); });
  let observedReset: string;
  beforeEach(() => {
    observedReset = new Date(Date.now() + 3_600_000).toISOString();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ five_hour: { utilization: 100, resets_at: observedReset }, extra_usage: { is_enabled: false } })));
  });
  afterEach(() => vi.restoreAllMocks());
  async function fixture(postStart = false, taskless = false, provider: "anthropic" | "openai" = "anthropic") {
    const adapterType = provider === "openai" ? "codex_local" : "claude_local";
    const credential = provider === "openai" ? JSON.stringify({ tokens: { access_token: "fixture-token", account_id: "fixture-account" } }) : "fixture-one";
    if (provider === "openai") vi.mocked(globalThis.fetch).mockImplementation(async () => new Response(JSON.stringify({ rate_limit: { allowed: false, primary_window: { used_percent: 100, reset_at: Math.ceil(Date.parse(observedReset) / 1000) } }, credits: { has_credits: false, unlimited: false } })));
    const companyId = randomUUID(), userId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Quota prestart", issuePrefix: `Q${companyId.slice(0, 8)}` });
    await db.insert(authUsers).values({ id: userId, name: "User", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    const [agent] = await db.insert(agents).values({ companyId, name: adapterType, adapterType, status: "active" }).returning();
    const accounts = aiConnectionService(db);
    const first = await accounts.save(companyId, userId, { provider, method: "subscription", ownership: "personal", name: "First", loginSessionId: "fixture", agentIds: [], allAgents: true }, credential);
    const second = await accounts.save(companyId, userId, { provider: "anthropic", method: "subscription", ownership: "personal", name: "Second", loginSessionId: "fixture", agentIds: [], allAgents: true }, "fixture-two");
    const members = [first, second].map(account => ({ id: randomUUID(), binding: { mode: "delegated" as const, provider: account === first ? provider : "anthropic" as const, method: "subscription" as const, ...account }, profile: account === first && provider === "openai" ? { provider: "codex" as const, model: "gpt-5.6-sol" } : { provider: "acpx" as const, acpxAgent: "claude" as const, model: "claude-sonnet-5" } }));
    const router = aiConnectionRouterService(db);
    const pool = await router.save(BUILTIN_AI_FAILOVER_ROUTER_KEY, { companyId, config: { name: "Pool", enabled: true, mode: "failover", thresholdPercent: 90, members } }, userId);
    const [updatedAgent] = await db.update(agents).set({ runtimeConfig: { aiConnection: { mode: "router", connectionId: pool.id } } }).where(eq(agents.id, agent.id)).returning();
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
      const contextSnapshot = { ...source!.contextSnapshot, aiRouterSelection: selected };
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
    const deps = { hasCaseHandoffForRun: async () => false, getRun: async () => null, getAgent: async () => undefined,
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
    const [failed] = await db.update(heartbeatRuns).set({ errorCode: failureKind === "auth" ? "claude_auth_required" : "codex_harness_crash",
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
    if (condition === "missing_receipt") await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.source.id));
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
