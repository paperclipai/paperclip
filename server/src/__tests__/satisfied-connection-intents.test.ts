import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, agentWakeupRequests, agents, approvals, authUsers, companies, companyMemberships, connectionGrants, connectionGrantDelegations,
  connectionIntentDeliveries, createDb, environmentLeases, heartbeatRunEvents, heartbeatRuns, issueApprovals, issueRecoveryActions, issueThreadInteractions, issues, projects, toolApplications,
  toolCatalogEntries, toolConnectionInstalls, toolConnections, toolProfileBindings, toolProfiles, toolPolicies,
} from "@paperclipai/db";
import { createPostgresRunDispatchAdapter } from "../modules/run-dispatch/adapters/postgres.js";
import { connectionIntentDeliveryService } from "../services/connection-intent-delivery.js";
import { findSatisfiedToolConnection, satisfiedConnectionIntentService } from "../services/satisfied-connection-intents.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { materializeNativeInteractionResponses } from "../services/native-runtime/native-interaction-bridge.js";
import { DELIVERY_QUEUES, subscribeDeliveryWork } from "../services/delivery-work-notifications.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { legacyExecutionNeedsReconciliationWithEvidence } from "../services/legacy-execution-recovery.js";
import { remoteTerminationReceipt } from "../services/remote-execution-termination.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("already available connection requests", () => {
  let db!: ReturnType<typeof createDb>;
  let temp!: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-satisfied-connections-");
    db = createDb(temp.connectionString);
    await db.insert(authUsers).values({ id: "connection-owner", name: "Owner", email: "owner@example.test", createdAt: new Date(), updatedAt: new Date() });
  }, 20_000);
  beforeEach(async () => { await db.execute(sql`truncate table companies cascade`); });
  afterAll(async () => { await db.$client.end({ timeout: 1 }); await temp?.cleanup(); });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Connections", issuePrefix: "CON", defaultResponsibleUserId: "connection-owner" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "connection-owner", status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Assignee", role: "engineer", adapterType: "claude_local", status: "idle", runtimeConfig: { heartbeat: { wakeOnDemand: true } } });
    const [task] = await db.insert(issues).values({ id: issueId, companyId, title: "Use Sentry", status: "in_review", assigneeAgentId: agentId, responsibleUserId: "connection-owner" }).returning();
    const [intent] = await db.insert(issueThreadInteractions).values({ companyId, issueId, kind: "connection_intent", status: "pending", addresseeUserId: "connection-owner",
      requestedResolverPolicy: "human_only", effectiveResolverPolicy: "human_only", payload: { version: 1, serviceSlug: "sentry", serviceName: "Sentry", requestingAgentId: agentId, requestingAgentName: "Assignee", phase: "requested" } }).returning();
    const [app] = await db.insert(toolApplications).values({ companyId, applicationKey: "sentry", name: "Sentry", type: "mcp_http", status: "active", metadata: { sourceTemplateKey: "sentry" } }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId, applicationId: app!.id, name: "Existing Sentry", uid: "sentry", transport: "mcp_remote", authKind: "api_key", credentialPolicy: "per_user", status: "active", enabled: true, healthStatus: "ok", config: { sourceTemplateKey: "sentry" } }).returning();
    const [grant] = await db.insert(connectionGrants).values({ companyId, connectionId: connection!.id, kind: "user", subjectUserId: "connection-owner", status: "active" }).returning();
    await db.insert(toolConnectionInstalls).values({ companyId, connectionId: connection!.id, targetType: "agent", targetId: agentId });
    const [tool] = await db.insert(toolCatalogEntries).values({ companyId, connectionId: connection!.id, toolName: "sentry-read", name: "sentry-read", versionHash: "v1", status: "active", entryKind: "tool" }).returning();
    const [profile] = await db.insert(toolProfiles).values({ companyId, profileKey: "reads", name: "Reads", defaultAction: "allow", status: "active" }).returning();
    await db.insert(toolProfileBindings).values({ companyId, profileId: profile!.id, targetType: "agent", targetId: agentId });
    return { companyId, agentId, issueId, task: task!, intent: intent!, connection: connection!, grant: grant!, tool: tool!, profile: profile! };
  }
  async function retry(f: Awaited<ReturnType<typeof seed>>) {
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, issueId: f.issueId,
      status: "scheduled_retry", scheduledRetryReason: "transient_failure", scheduledRetryAt: new Date(), runtimeMode: "legacy",
      responsibleUserId: "connection-owner", contextSnapshot: { issueId: f.issueId }, resultJson: { conversationContinuation: "continue_conversation_v1" } }).returning();
    return run!;
  }

  it("ignores an already available connection before the worker retires its card", async () => {
    const f = await seed(); const run = await retry(f);
    expect(await createPostgresRunDispatchAdapter(db).evaluateScheduledRetryGate({ companyId: f.companyId, runId: run.id, now: new Date() })).toMatchObject({ allowed: true });
    expect((await db.select().from(issueThreadInteractions))[0].status).toBe("pending");
  });

  it("keeps a retry under another user's identity waiting for its response", async () => {
    const f = await seed(); const run = await retry(f);
    await db.update(heartbeatRuns).set({ responsibleUserId: "someone-else" }).where(eq(heartbeatRuns.id, run.id));
    expect(await createPostgresRunDispatchAdapter(db).evaluateScheduledRetryGate({ companyId: f.companyId, runId: run.id, now: new Date() })).toMatchObject({ allowed: false, errorCode: "issue_waiting_for_response" });
  });

  it("notifies an idle worker when a new connection request commits", async () => {
    const f = await seed(); const source = await retry(f);
    await db.delete(issueThreadInteractions);
    const wakeup = vi.fn().mockResolvedValue(null);
    const worker = connectionIntentDeliveryService(db, { wakeup });
    expect(await worker.hasPending()).toBe(false);
    const notified = vi.fn();
    const unsubscribe = subscribeDeliveryWork(db, DELIVERY_QUEUES.connection, notified);
    try {
      await issueThreadInteractionService(db).createConnectionIntent({ id: f.issueId, companyId: f.companyId }, {
        payload: f.intent.payload, sourceRunId: source.id, addresseeUserId: "connection-owner", idempotencyKey: "new-card",
      });
      expect(notified).toHaveBeenCalledOnce();
      expect(await worker.hasPending()).toBe(true);
      await worker.sweepPending();
      expect(wakeup).toHaveBeenCalledOnce();
    } finally { unsubscribe(); }
  });

  it.each(["wrong_identity", "revoked", "disabled", "removed_member", "denied_policy"] as const)("rechecks %s after the card retires", async (reason) => {
    const f = await seed(); const run = await retry(f);
    await satisfiedConnectionIntentService(db).sweepPending();
    if (reason === "wrong_identity") await db.update(heartbeatRuns).set({ responsibleUserId: "someone-else" });
    if (reason === "revoked") await db.update(connectionGrants).set({ status: "revoked" });
    if (reason === "disabled") await db.update(toolConnections).set({ enabled: false });
    if (reason === "removed_member") await db.delete(companyMemberships);
    if (reason === "denied_policy") await db.insert(toolPolicies).values({ companyId: f.companyId, name: "Block this task", policyType: "block", selectors: { issueId: f.issueId } });
    expect(await createPostgresRunDispatchAdapter(db).evaluateScheduledRetryGate({ companyId: f.companyId, runId: run.id, now: new Date() })).toMatchObject({ allowed: false, errorCode: "issue_waiting_for_response" });
  });

  it.each(["company", "issue", "project"] as const)("uses %s policy when deciding whether tools are ready", async (scope) => {
    const f = await seed();
    const selectors = scope === "issue" ? { issueId: f.issueId } : scope === "project" ? { projectId: randomUUID() } : {};
    if (scope === "project") {
      const projectId = (selectors as { projectId: string }).projectId;
      await db.insert(projects).values({ id: projectId, companyId: f.companyId, name: "Tools" });
      await db.update(issues).set({ projectId });
    }
    await db.insert(toolPolicies).values({ companyId: f.companyId, name: "Block tools", policyType: "block", selectors });
    expect(await satisfiedConnectionIntentService(db).sweepPending()).toMatchObject({ satisfied: 0 });
    expect((await db.select().from(issueThreadInteractions))[0].status).toBe("pending");
  });

  it("retains invocation approval when the authorized connection's tools require it", async () => {
    const f = await seed();
    await db.insert(toolPolicies).values({ companyId: f.companyId, name: "Ask before use", policyType: "require_approval", selectors: { issueId: f.issueId } });
    expect(await satisfiedConnectionIntentService(db).sweepPending()).toMatchObject({ satisfied: 1 });
    expect((await db.select().from(toolPolicies))[0].policyType).toBe("require_approval");
    expect(await db.select().from(approvals)).toHaveLength(0);
    expect((await db.select().from(issueThreadInteractions))[0].resolvedByUserId).toBeNull();
  });

  async function addWait(f: Awaited<ReturnType<typeof seed>>, kind: "question" | "approval") {
    if (kind === "question") {
      const [question] = await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId,
        kind: "ask_user_questions", status: "pending", payload: { version: 1, questions: [] } }).returning();
      return async () => { await db.update(issueThreadInteractions).set({ status: "answered" }).where(eq(issueThreadInteractions.id, question!.id)); };
    }
    const [approval] = await db.insert(approvals).values({ companyId: f.companyId, type: "tool_action", status: "pending", payload: {} }).returning();
    await db.insert(issueApprovals).values({ companyId: f.companyId, issueId: f.issueId, approvalId: approval!.id });
    return async () => { await db.update(approvals).set({ status: "approved" }).where(eq(approvals.id, approval!.id)); };
  }

  it.each(["question", "approval"] as const)("defers the saved system continuation for another %s", async (kind) => {
    const f = await seed(); const clearWait = await addWait(f, kind);
    const wakeup = vi.fn().mockResolvedValue(null);
    const worker = connectionIntentDeliveryService(db, { wakeup });
    await worker.sweepPending();
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, f.intent.id)))[0].status).toBe("expired");
    expect(wakeup).not.toHaveBeenCalled();
    expect((await db.select().from(connectionIntentDeliveries))[0].deliveredAt).toBeNull();
    await clearWait();
    await db.update(connectionIntentDeliveries).set({ nextAttemptAt: new Date() });
    await worker.sweepPending();
    expect(wakeup).toHaveBeenCalledOnce();
  });

  it.each(["question", "approval", "revoked"] as const)("rechecks a queued system continuation after %s changes", async (kind) => {
    const f = await seed(); const run = await retry(f);
    await satisfiedConnectionIntentService(db).sweepPending();
    await db.update(heartbeatRuns).set({ status: "queued", contextSnapshot: { issueId: f.issueId,
      connectionIntentResolution: "existing_connection", interactionKind: "connection_intent", interactionStatus: "expired",
      mutation: "interaction", wakeReason: "issue_commented", source: "connection_intent.resolved" } }).where(eq(heartbeatRuns.id, run.id));
    if (kind === "revoked") await db.update(connectionGrants).set({ status: "revoked" });
    else await addWait(f, kind);
    expect(await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({ companyId: f.companyId, runId: run.id,
      expectedStatus: "queued", now: new Date() })).toMatchObject({ outcome: "cancelled", errorCode: "issue_waiting_for_response" });
  });

  async function replaceAccount(f: Awaited<ReturnType<typeof seed>>) {
    await db.update(toolConnections).set({ enabled: false }).where(eq(toolConnections.id, f.connection.id));
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, f.grant.id));
    const [connection] = await db.insert(toolConnections).values({ ...f.connection, id: randomUUID(), uid: "sentry-replacement", name: "Replacement Sentry" }).returning();
    await db.insert(connectionGrants).values({ ...f.grant, id: randomUUID(), connectionId: connection!.id, status: "active" });
    await db.insert(toolConnectionInstalls).values({ companyId: f.companyId, connectionId: connection!.id, targetType: "agent", targetId: f.agentId });
    await db.insert(toolCatalogEntries).values({ ...f.tool, id: randomUUID(), connectionId: connection!.id });
    return connection!;
  }

  it("allows a later approved replacement instead of permanently binding retries to an old account", async () => {
    const f = await seed(); const run = await retry(f);
    await satisfiedConnectionIntentService(db).sweepPending();
    const replacement = await replaceAccount(f);
    await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId, kind: "connection_intent",
      status: "accepted", payload: f.intent.payload, addresseeUserId: "connection-owner", resolvedByUserId: "connection-owner",
      result: { version: 1, outcome: "accepted", connectionId: replacement.id }, resolvedAt: new Date() });
    expect(await createPostgresRunDispatchAdapter(db).evaluateScheduledRetryGate({ companyId: f.companyId, runId: run.id, now: new Date() })).toMatchObject({ allowed: true });
  });

  it("refreshes only the system observation for an already authorized replacement", async () => {
    const f = await seed(); const run = await retry(f);
    await satisfiedConnectionIntentService(db).sweepPending();
    const replacement = await replaceAccount(f);
    const input = { db, companyId: f.companyId, issueId: f.issueId, runId: run.id, agentId: f.agentId, interactionIds: [f.intent.id] };
    await expect(materializeNativeInteractionResponses(input)).rejects.toMatchObject({ code: "native_interaction_unresolved" });
    await connectionIntentDeliveryService(db, { wakeup: vi.fn().mockResolvedValue(null) }).sweepPending();
    expect((await db.select().from(issueThreadInteractions))[0]).toMatchObject({ status: "expired", resolvedByUserId: null,
      result: { outcome: "expired", connectionId: replacement.id } });
    expect(await materializeNativeInteractionResponses(input)).toEqual([expect.objectContaining({
      response: expect.objectContaining({ result: expect.objectContaining({ connectionId: replacement.id }) }) })]);
    expect(await db.select().from(activityLog)).toEqual(expect.arrayContaining([expect.objectContaining({ actorType: "system",
      details: expect.objectContaining({ previousConnectionId: f.connection.id, connectionId: replacement.id }) })]));
  });

  it("rearms an unstarted wait without manufacturing a workspace repair hold", async () => {
    const f = await seed(); const run = await retry(f);
    await satisfiedConnectionIntentService(db).sweepPending();
    const key = `connection-intent:${f.intent.id}:expired`;
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
      source: "automation", status: "claimed", idempotencyKey: key, runId: run.id }).returning();
    await db.update(connectionIntentDeliveries).set({ deliveredAt: new Date() });
    await db.update(heartbeatRuns).set({ status: "queued", wakeupRequestId: wake!.id, resultJson: null,
      contextSnapshot: { issueId: f.issueId, interactionId: f.intent.id, connectionIntentResolution: "existing_connection",
        interactionKind: "connection_intent", interactionStatus: "expired", mutation: "interaction", wakeReason: "issue_commented", source: "connection_intent.resolved" } }).where(eq(heartbeatRuns.id, run.id));
    await db.update(connectionGrants).set({ status: "revoked" });
    expect(await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({ companyId: f.companyId, runId: run.id,
      expectedStatus: "queued", now: new Date() })).toMatchObject({ outcome: "cancelled", errorCode: "issue_waiting_for_response" });
    const cancelled = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0];
    expect(await legacyExecutionNeedsReconciliationWithEvidence(db, cancelled)).toBe(false);
    expect((await db.select().from(connectionIntentDeliveries))[0].deliveredAt).toBeNull();
    expect((await db.select().from(agentWakeupRequests))[0].status).toBe("skipped");
    await db.update(connectionGrants).set({ status: "active" });
    const wakeup = vi.fn(async () => {
      await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "automation", status: "queued", idempotencyKey: key });
      return null;
    });
    await connectionIntentDeliveryService(db, { wakeup }).sweepPending();
    expect(wakeup).toHaveBeenCalledOnce();
    expect((await db.select().from(connectionIntentDeliveries))[0].deliveredAt).not.toBeNull();
    await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, runId: run.id, agentId: f.agentId,
      seq: 2, eventType: "adapter.invoke" });
    expect(await legacyExecutionNeedsReconciliationWithEvidence(db, cancelled)).toBe(true);
  });

  it("records a system completion and one durable continuation with a one-connection pool", async () => {
    const f = await seed();
    const single = createDb(temp.connectionString, { maxConnections: 1 });
    try {
      const outcomes = await Promise.all([satisfiedConnectionIntentService(single).sweepPending(), satisfiedConnectionIntentService(db).sweepPending()]);
      expect(outcomes.reduce((sum, outcome) => sum + outcome.satisfied, 0)).toBe(1);
      expect((await db.select().from(issueThreadInteractions))[0]).toMatchObject({ status: "expired", resolvedByUserId: null, result: { outcome: "expired", connectionId: f.connection.id } });
      expect(await db.select().from(connectionIntentDeliveries)).toHaveLength(1);
      expect(await db.select().from(activityLog)).toEqual([expect.objectContaining({ actorType: "system", action: "issue.thread_interaction_resolved" })]);
      expect(await db.select().from(connectionGrantDelegations)).toHaveLength(0);
      expect(await db.select().from(toolPolicies)).toHaveLength(0);
      expect(await db.select().from(connectionGrants)).toHaveLength(1);
      expect(await db.select().from(toolConnectionInstalls)).toHaveLength(1);
      expect(await satisfiedConnectionIntentService(single).sweepPending()).toMatchObject({ satisfied: 0 });
    } finally { await single.$client.end({ timeout: 1 }); }
  });

  it("discovers pending cards through the existing delivery worker", async () => {
    const f = await seed(); const wakeup = vi.fn().mockResolvedValue(null);
    const worker = connectionIntentDeliveryService(db, { wakeup });
    expect(await worker.hasPending()).toBe(true);
    await worker.sweepPending();
    expect((await db.select().from(issueThreadInteractions))[0].status).toBe("expired");
    expect(wakeup).toHaveBeenCalledOnce();
    expect(wakeup).toHaveBeenCalledWith(f.agentId, expect.objectContaining({ requestedByActorType: "system", idempotencyKey: `connection-intent:${f.intent.id}:expired`, contextSnapshot: expect.objectContaining({ refreshTools: true, responsibleUserId: "connection-owner" }) }));
  });

  it("rechecks access after a restart before it delivers the saved continuation", async () => {
    const f = await seed();
    await satisfiedConnectionIntentService(db).sweepPending();
    await db.update(connectionGrants).set({ status: "revoked" });
    const wakeup = vi.fn().mockResolvedValue(null);
    const worker = connectionIntentDeliveryService(db, { wakeup });
    await worker.sweepPending();
    expect(wakeup).not.toHaveBeenCalled();
    expect((await db.select().from(connectionIntentDeliveries))[0].deliveredAt).toBeNull();
    await db.update(connectionGrants).set({ status: "active" });
    await db.update(connectionIntentDeliveries).set({ nextAttemptAt: new Date() });
    await worker.sweepPending();
    expect(wakeup).toHaveBeenCalledOnce();
  });

  it("delivers system retirement to the native runner only while the same connection remains usable", async () => {
    const f = await seed(); const run = await retry(f);
    await satisfiedConnectionIntentService(db).sweepPending();
    const input = { db, companyId: f.companyId, issueId: f.issueId, runId: run.id, agentId: f.agentId, interactionIds: [f.intent.id] };
    expect(await materializeNativeInteractionResponses(input)).toEqual([expect.objectContaining({
      kind: "connection_intent", response: expect.objectContaining({ status: "expired", result: expect.objectContaining({ connectionId: f.connection.id }) }) })]);
    await db.update(connectionGrants).set({ status: "revoked" });
    await expect(materializeNativeInteractionResponses(input)).rejects.toMatchObject({ code: "native_interaction_unresolved" });
  });

  it.each(["missing_install", "denied_tools", "disabled", "unhealthy", "revoked", "wrong_user", "viewer", "removed_member", "additional_access", "ai", "channel", "upstream", "reassigned", "human_owner", "closed", "other_company"] as const)("preserves a request for %s", async (reason) => {
    const f = await seed();
    if (reason === "missing_install") await db.delete(toolConnectionInstalls);
    if (reason === "denied_tools") await db.update(toolProfiles).set({ defaultAction: "deny" });
    if (reason === "disabled") await db.update(toolConnections).set({ enabled: false });
    if (reason === "unhealthy") await db.update(toolConnections).set({ healthStatus: "error" });
    if (reason === "revoked") await db.update(connectionGrants).set({ status: "revoked" });
    if (reason === "wrong_user") await db.update(connectionGrants).set({ subjectUserId: "someone-else" });
    if (reason === "viewer") await db.update(companyMemberships).set({ membershipRole: "viewer" });
    if (reason === "removed_member") await db.delete(companyMemberships);
    if (["ai", "channel", "upstream", "additional_access"].includes(reason)) {
      const extra = reason === "ai" || reason === "channel" ? { purpose: reason }
        : reason === "upstream" ? { upstreamService: { slug: "sentry", name: "Sentry" } }
        : { accessRequest: { connectionId: f.connection.id, connectionName: "Sentry", tools: [{ catalogEntryId: f.tool.id, toolName: f.tool.toolName, versionHash: "v1", permission: "allowed" }] } };
      await db.update(issueThreadInteractions).set({ payload: { ...f.intent.payload, ...extra } as typeof f.intent.payload });
    }
    if (reason === "reassigned") await db.update(issues).set({ assigneeAgentId: null });
    if (reason === "human_owner") await db.update(issues).set({ assigneeUserId: "connection-owner" });
    if (reason === "closed") await db.update(issues).set({ status: "done" });
    if (reason === "other_company") {
      const [other] = await db.insert(companies).values({ name: "Other", issuePrefix: "OTH" }).returning();
      await db.update(issueThreadInteractions).set({ companyId: other!.id });
    }
    const task = (await db.select().from(issues))[0]; const intent = (await db.select().from(issueThreadInteractions))[0];
    expect(await findSatisfiedToolConnection(db, task, intent)).toBeNull();
    expect(await satisfiedConnectionIntentService(db).sweepPending()).toMatchObject({ satisfied: 0 });
    expect((await db.select().from(issueThreadInteractions))[0].status).toBe("pending");
    expect(await db.select().from(connectionIntentDeliveries)).toHaveLength(0);
  });

  it("keeps a real question blocking even when a sibling connection is available", async () => {
    const f = await seed(); const run = await retry(f);
    await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId, kind: "ask_user_questions", status: "pending", payload: { version: 1, questions: [] } });
    expect(await createPostgresRunDispatchAdapter(db).evaluateScheduledRetryGate({ companyId: f.companyId, runId: run.id, now: new Date() })).toMatchObject({ allowed: false, errorCode: "issue_waiting_for_response" });
  });

  it("does not bypass a retained workspace hold after connecting", async () => {
    const f = await seed();
    const leaseId = randomUUID();
    const workspaceRestoreRecovery = { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [leaseId] };
    const [source] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, issueId: f.issueId, status: "interrupted", finishedAt: new Date(), runtimeMode: "legacy",
      contextSnapshot: { issueId: f.issueId }, resultJson: { conversationContinuation: "continue_conversation_v1", workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovery } }).returning();
    const identity = { id: leaseId, companyId: f.companyId, heartbeatRunId: source!.id, provider: "daytona", providerLeaseId: `fixture-${leaseId}` };
    await db.insert(environmentLeases).values({ ...identity, issueId: f.issueId, status: "released", leasePolicy: "retain_on_failure", releasedAt: new Date(), cleanupStatus: "success",
      metadata: { remoteExecutionTermination: remoteTerminationReceipt(identity, { providerLeaseId: identity.providerLeaseId, state: "stopped" }) } });
    await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", ownerType: "board",
      fingerprint: `legacy-execution:${source!.id}`, status: "resolved", outcome: "blocked",
      nextAction: "Repair the retained workspace before continuing.", evidence: { runId: source!.id,
        workspaceRestoreFailure: "restore_failed", automaticRecovery: { replay: "blocked" },
        workspaceRestoreRecovery } });
    const run = await retry(f);
    await db.update(heartbeatRuns).set({ retryOfRunId: source!.id, contextSnapshot: { issueId: f.issueId, retryOfRunId: source!.id } }).where(eq(heartbeatRuns.id, run.id));
    await satisfiedConnectionIntentService(db).sweepPending();
    const dispatch = createPostgresRunDispatchAdapter(db);
    await dispatch.promoteOrCancelDueRetry({ companyId: f.companyId, runId: run.id, now: new Date() });
    const outcome = await dispatch.cancelStaleQueuedRun({ companyId: f.companyId, runId: run.id, expectedStatus: "queued", now: new Date() });
    expect(outcome).toMatchObject({ outcome: "cancelled", errorCode: "execution_reconciliation_required" });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0].status).toBe("cancelled");
  });
});
