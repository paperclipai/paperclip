import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { createHeartbeatQueue } from "../services/heartbeat/queue.js";
import { createHeartbeatQueueTestDependencies } from "./helpers/heartbeat-queue.js";
import { createHeartbeatScheduling, type HeartbeatSchedulingDependencies } from "../services/heartbeat/scheduling.js";
import { createHeartbeatRunState } from "../services/heartbeat/run-state.js";
import { createHeartbeatRunPreparation } from "../services/heartbeat/run-preparation.js";
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { reconcileTaskChatRetryReceipts } from "../services/task-retry.js";
import { chatActions } from "@paperclipai/db";
import { createChatPublicationResolution } from "../services/chat-channels/publications/resolution.js";
import { createChatPublicationTaskControl } from "../services/chat-channels/publications/task-control.js";
import { chatCredentialMutationLease } from "../services/chat-credential-mutation-lease.js";
import { createHeartbeatLifecycle, type HeartbeatLifecycleDependencies } from "../services/heartbeat/run-lifecycle.js";
import { createAdmissionTransactionScope, createPostgresWakeQueueAdapter, createWakeAdmissionWriter } from "../modules/wake-queue/adapters/postgres.js";
import { applyRunnerGoalPrpEvent } from "../services/runner-goals.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { setTimeout as delay } from "node:timers/promises";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { externalConversationSettlementWork } from "../services/external-conversation-settlement-work.js";
import { notifyNativeFinalizationWork } from "../services/native-finalization-notifications.js";
import { notifyChatRunMilestones } from "../services/chat-run-milestone-notifications.js";
import { notifyChatInboundWakeNotices } from "../services/chat-inbound-wake-notice-notifications.js";
import { notifyChatResponseAvailability } from "../services/chat-response-availability.js";
import { issueApprovalService } from "../services/issue-approvals.js";
import express from "express";
import request from "supertest";
import { issueRoutes } from "../routes/issues.js";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, agentWakeupRequests, approvals, chatConversations, chatEndpoints,
  chatMessageLinks, chatPublications, companies, createDb, heartbeatRuns, issueApprovals,
  issueComments, issueRelations, issueThreadInteractions, issues, nativeRunFinalizations,
  toolApplications, toolConnections, subscribeDatabaseWork, type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { pendingExternalConversationSettlement, externalConversationSettlementCandidates, settleSlackConversation } from "../services/slack-conversation-lifecycle.js";
import { externalConversationStateSql, resumeExternalConversation } from "../services/slack-conversation-state.js";
import { executionIssueCondition } from "../services/issue-visibility.js";
import { dashboardService } from "../services/dashboard.js";
import { attentionService } from "../services/attention.js";
import { companySearchQuerySchema } from "@paperclipai/shared";
import { companySearchService } from "../services/company-search.js";
import { recoveryService } from "../services/recovery/service.js";
import { issueService } from "../services/issues.js";

import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
const external = resolveExternalTestDatabaseUrl("PAPERCLIP_EXTERNAL_CONVERSATION_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("Slack conversation idle lifecycle", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    if (!external) database = await startEmbeddedPostgresTestDatabase("paperclip-slack-idle-");
    db = createDb(external ?? database!.connectionString);
  }, 90000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
  });

  async function fixture(native = false, issueId = randomUUID()) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const endpointId = randomUUID();
    const conversationId = randomUUID();
    const runId = randomUUID();
    const wakeId = randomUUID();
    const responseId = randomUUID();
    const publicationId = randomUUID();
    const applicationId = randomUUID();
    const connectionId = randomUUID();
    const start = new Date(Date.now() - 10000);
    await db.insert(companies).values({ id: companyId, name: "Slack", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Carl", role: "general", adapterType: "codex_local" });
    await db.insert(issues).values({ id: issueId, companyId, title: "you there?", status: "in_progress", assigneeAgentId: agentId, originKind: "chat_channel" });
    await db.insert(toolApplications).values({ id: applicationId, companyId, name: "Slack", type: "native" });
    await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: "Slack", uid: connectionId, transport: "chat_sdk", connectionPurpose: "channel" });
    await db.insert(chatEndpoints).values({ id: endpointId, companyId, connectionId, provider: "slack", publicId: endpointId, assignedAgentId: agentId, status: "active" });
    await db.insert(chatConversations).values({ id: conversationId, companyId, endpointId, issueId, externalConversationId: "channel", externalThreadId: runId, externalLabel: "#test" });
    await db.insert(issueComments).values({ id: wakeId, companyId, issueId, authorType: "user", authorUserId: "local-board", body: "you there?", createdAt: start });
    await db.insert(chatMessageLinks).values({ companyId, endpointId, conversationId, commentId: wakeId, providerMessageId: wakeId, direction: "inbound" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "succeeded", runtimeMode: native ? "native" : "legacy", nativeIssueId: native ? issueId : null,
      resultJson: native ? { finalizationReasonCode: "external_chat_response_waiting" } : null,
      createdAt: new Date(start.getTime() + 1), startedAt: start, finishedAt: new Date(),
      contextSnapshot: { issueId, source: "chat:slack", wakeCommentId: wakeId, wakeCommentIds: [wakeId] } });
    if (native) await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "committed" });
    await db.insert(issueComments).values({ id: responseId, companyId, issueId, authorType: "agent", authorAgentId: agentId, createdByRunId: runId, body: "Yes, I’m here.",
      metadata: { version: 1, authorizationReason: "allow_chat_run_presentation", sections: [] } });
    await db.insert(chatPublications).values({ id: publicationId, companyId, endpointId, conversationId, issueId, commentId: responseId,
      idempotencyKey: `comment:${responseId}:${endpointId}`, payload: { text: "Yes, I’m here." }, state: "published", providerMessageId: responseId, publishedAt: new Date() });
    return { companyId, agentId, issueId, endpointId, conversationId, runId, wakeId, responseId, publicationId, start };
  }
  async function state(f: Awaited<ReturnType<typeof fixture>>) {
    return (await db.select({ status: issues.status, externalConversationState: externalConversationStateSql() })
      .from(issues).where(eq(issues.id, f.issueId)))[0];
  }
  const settle = (f: Awaited<ReturnType<typeof fixture>>) => settleSlackConversation(db, f.companyId, f.issueId);

  async function exhaustedMonitor(f: Awaited<ReturnType<typeof fixture>>,
    enqueueWakeup: HeartbeatSchedulingDependencies["enqueueWakeup"],
    recoveryPolicy: "wake_owner" | "escalate_to_board" = "wake_owner") {
    const now = new Date(), due = new Date(now.getTime() - 60_000);
    await db.update(issues).set({ monitorNextCheckAt: due, monitorAttemptCount: 1,
      executionPolicy: { mode: "normal", commentRequired: true, stages: [], monitor: {
        nextCheckAt: due.toISOString(), maxAttempts: 1, recoveryPolicy,
      } },
    }).where(eq(issues.id, f.issueId));
    const state = createHeartbeatRunState(db), preparation = createHeartbeatRunPreparation(db);
    return createHeartbeatScheduling(db, {
      getAgent: state.getAgent, getRun: state.getRun,
      toAgentOrgRow: preparation.toAgentOrgRow, groupAgentOrgRowsByCompany: preparation.groupAgentOrgRowsByCompany,
      issuesSvc: issueService(db), enqueueWakeup,
      getSchedulingSuppression: async () => ({ suppressed: false }), getWorktreeExecutionCutoff: async () => null,
      scheduleBoundedRetryForRun: vi.fn(), claimDueTimerHeartbeat: vi.fn(), parseHeartbeatPolicy: vi.fn(), nextTimerHeartbeatAt: vi.fn(),
    });
  }

  it("notifies timer eligibility at outer commit when a published conversation becomes idle", async () => {
    const f = await fixture();
    const [agent] = await db.update(agents).set({ runtimeConfig: { heartbeat: {
      enabled: true, intervalSec: 600, skipTimerWhenNoActionableWork: true,
    } } }).where(eq(agents.id, f.agentId)).returning();
    const queue = createHeartbeatQueue(db, createHeartbeatQueueTestDependencies(db));
    expect(await queue.nextTimerHeartbeatAt(agent)).toBe(agent.createdAt.getTime() + 600_000);
    const events: string[] = [];
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.agentTimers, event => events.push(event));
    try {
      await db.transaction(async tx => {
        expect(await settleSlackConversation(tx as unknown as Db, f.companyId, f.issueId)).toBe(true);
        expect(events).toContain("intent");
        expect(events).not.toContain("settled");
        expect((await state(f)).status).toBe("in_progress");
      });
      expect(events).toContain("settled");
      expect((await state(f)).status).toBe("in_review");
      expect(await queue.nextTimerHeartbeatAt(agent)).toBeNull();
    } finally { unsubscribe(); }
  });

  it("keeps monitor recovery pending until its wake handoff finishes", async () => {
    const f = await fixture();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const scheduler = await exhaustedMonitor(f, async () => {
      entered(); await gate;
      await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
        source: "automation", status: "queued", payload: { issueId: f.issueId } });
      return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)).then(rows => rows[0]!);
    });
    const dispatch = scheduler.triggerIssueMonitor(f.issueId);
    try {
      await started;
      expect(await pendingExternalConversationSettlement(db, f.companyId, f.issueId)).toBe(false);
      expect(await settle(f)).toBe(false);
    } finally { release(); await dispatch; }
    expect(await pendingExternalConversationSettlement(db, f.companyId, f.issueId)).toBe(false);
  });

  it.each(["failure", "deferred"])("retains the monitor obligation after a %s recovery handoff", async mode => {
    const f = await fixture();
    const scheduler = await exhaustedMonitor(f, async () => {
      if (mode === "failure") throw new Error("recovery handoff unavailable");
      return null;
    });
    if (mode === "failure") await expect(scheduler.triggerIssueMonitor(f.issueId)).rejects.toThrow("recovery handoff unavailable");
    else await scheduler.triggerIssueMonitor(f.issueId);
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(issue!.monitorNextCheckAt).not.toBeNull();
    expect(issue!.monitorWakeRequestedAt).toBeNull();
    expect(await pendingExternalConversationSettlement(db, f.companyId, f.issueId)).toBe(false);
  });

  it.each(["original limit", "later timeout", "stable key"])("consumes accepted monitor recovery after restart (%s)", async scenario => {
    const f = await fixture();
    const enqueue = vi.fn<HeartbeatSchedulingDependencies["enqueueWakeup"]>(async () => null);
    const scheduler = await exhaustedMonitor(f, enqueue);
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
      source: "automation", status: "completed", runId: f.runId, reason: "issue_monitor_recovery",
      idempotencyKey: scenario === "stable key"
        ? `issue-monitor-recovery:${f.issueId}:${issue!.monitorNextCheckAt!.toISOString()}`
        : `issue-monitor-recovery:${f.issueId}:max_attempts_exhausted:${issue!.monitorNextCheckAt!.toISOString()}`,
      payload: { issueId: f.issueId } });
    const now = new Date();
    if (scenario === "later timeout") {
      const policy = issue!.executionPolicy!;
      await db.update(issues).set({ executionPolicy: { ...policy,
        monitor: { ...policy.monitor as object, timeoutAt: new Date(now.getTime() - 1).toISOString() },
      } }).where(eq(issues.id, f.issueId));
    }
    await scheduler.triggerIssueMonitor(f.issueId, { now });
    expect(enqueue).not.toHaveBeenCalled();
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]!.monitorNextCheckAt).toBeNull();
  });

  it("consumes monitor recovery coalesced by the real queue writer after the joined run finishes", async () => {
    const f = await fixture();
    const enqueue = vi.fn<HeartbeatSchedulingDependencies["enqueueWakeup"]>(async () => null);
    const scheduler = await exhaustedMonitor(f, enqueue);
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const key = `issue-monitor-recovery:${f.issueId}:${issue!.monitorNextCheckAt!.toISOString()}`;
    await db.update(heartbeatRuns).set({ status: "running", finishedAt: null }).where(eq(heartbeatRuns.id, f.runId));
    await db.transaction(async tx => {
      await createWakeAdmissionWriter().coalesceIntoActiveExecutionRun(createAdmissionTransactionScope(f.companyId, tx as unknown as typeof db), {
        companyId: f.companyId, agentId: f.agentId, activeExecutionRunId: f.runId,
        mergedContextSnapshot: { issueId: f.issueId }, source: "automation", triggerDetail: "system",
        payload: { issueId: f.issueId }, requestedByActorType: "system", requestedByActorId: null,
        idempotencyKey: key,
      });
    });
    const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, key));
    expect(receipt).toMatchObject({ reason: "issue_execution_same_name", status: "coalesced", runId: f.runId });
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));

    await scheduler.triggerIssueMonitor(f.issueId);
    expect(enqueue).not.toHaveBeenCalled();
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]!.monitorNextCheckAt).toBeNull();
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, key))).toHaveLength(1);
  });

  it.each(["issue_monitor_recovery", "issue_execution_same_name"])("does not consume a %s receipt for a different monitor schedule", async reason => {
    const f = await fixture();
    const enqueue = vi.fn<HeartbeatSchedulingDependencies["enqueueWakeup"]>(async () => null);
    const scheduler = await exhaustedMonitor(f, enqueue);
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const previousSchedule = new Date(issue!.monitorNextCheckAt!.getTime() - 60_000).toISOString();
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
      source: "automation", status: "completed", runId: f.runId, reason,
      idempotencyKey: `issue-monitor-recovery:${f.issueId}:${previousSchedule}`,
      payload: { issueId: f.issueId } });
    await scheduler.triggerIssueMonitor(f.issueId);
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue.mock.calls[0]![1]?.idempotencyKey).toBe(
      `issue-monitor-recovery:${f.issueId}:${issue!.monitorNextCheckAt!.toISOString()}`);
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]!.monitorNextCheckAt).not.toBeNull();
  });

  describe("settlement worker", () => {
    let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
    const errors: unknown[] = [];
    let admitted = true;
    afterEach(async () => { await coordinator?.stop(); coordinator = undefined; admitted = true; vi.useRealTimers(); expect(errors.splice(0)).toEqual([]); });
    async function start(settle = settleSlackConversation) {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => admitted, canReconcile: () => admitted,
        onError: error => errors.push(error) });
      await externalConversationSettlementWork(db, settle).register(coordinator, () => admitted).ready;
    }
    async function flush() {
      await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(idleWorkSnapshot().active).toBe(0); expect(coordinator!.nextWakeAt()).toBeNull(); }, { timeout: 5000 });
    }
    async function quiet() {
      const prior = db.$client.options.debug, queries: string[] = [];
      db.$client.options.debug = (_id, query) => { queries.push(query); };
      try { await vi.advanceTimersByTimeAsync(120_000); await delay(10); expect(queries).toEqual([]); }
      finally { db.$client.options.debug = prior; }
    }
    it.each(["native finalization", "chat milestone"] as const)("ignores routine company-only settlement hints from %s and resumes on execution release", async producer => {
      const f = await fixture(true);
      await db.update(issues).set({ executionRunId: f.runId }).where(eq(issues.id, f.issueId));
      await start(); await flush(); await quiet();
      const previous = db.$client.options.debug;
      const queries: string[] = [];
      db.$client.options.debug = (_id, query) => {
        if (query.includes('"issues"') && query.includes("chat_conversations")) queries.push(query);
      };
      try {
        for (let index = 0; index < 3; index += 1) {
          await db.transaction(async tx => {
            if (producer === "native finalization") await notifyNativeFinalizationWork(tx, { companyId: f.companyId });
            else await notifyChatRunMilestones(tx, { companyId: f.companyId });
          });
          await flush();
        }
        expect(queries).toEqual([]);
      } finally { db.$client.options.debug = previous; }
      await issueService(db).update(f.issueId, { executionRunId: null });
      await flush();
      expect(await state(f)).toMatchObject({ status: "in_review", externalConversationState: "waiting" });
      await quiet();
    });

    it.each(["inbound notice", "response availability"] as const)("keeps real company-wide %s settlement notifications enabled", async producer => {
      const f = await fixture(true);
      await db.update(issues).set({ executionRunId: f.runId }).where(eq(issues.id, f.issueId));
      await start(); await flush(); await quiet();
      await db.transaction(async tx => {
        if (producer === "inbound notice") await notifyChatInboundWakeNotices(tx, { companyId: f.companyId });
        else await notifyChatResponseAvailability(tx, { companyId: f.companyId });
        await tx.update(issues).set({ executionRunId: null }).where(eq(issues.id, f.issueId));
      });
      await flush();
      expect(await state(f)).toMatchObject({ status: "in_review", externalConversationState: "waiting" });
      await quiet();
    });

    it("reconstructs answered turns and becomes quiet with retained history", async () => {
      const f = await fixture(true); await start(); await flush();
      expect(await state(f)).toMatchObject({ status: "in_review", externalConversationState: "waiting" });
      await quiet();
    });
    it("finds ready work beyond a full page of ineligible active conversations", async () => {
      const ids = Array.from({ length: 102 }, () => randomUUID()).sort();
      const f = await fixture(false, ids.pop()!);
      await db.insert(issues).values(ids.map(id => ({ id, companyId: f.companyId,
        title: "Waiting for input", status: "in_progress", assigneeAgentId: f.agentId, originKind: "chat_channel" })));
      await db.insert(chatConversations).values(ids.map(issueId => ({ companyId: f.companyId,
        endpointId: f.endpointId, issueId, externalConversationId: issueId, externalLabel: "#waiting", state: "active" })));
      const entries = await externalConversationSettlementWork(db).load({ companyId: f.companyId });
      expect(entries.map(entry => entry.id)).toEqual([f.issueId]);
      await start(); await flush();
      expect(await state(f)).toMatchObject({ status: "in_review", externalConversationState: "waiting" });
      await quiet();
    });
    it("leaves an active conversation waiting for real work without recurring SQL", async () => {
      const f = await fixture();
      await db.update(issues).set({ executionRunId: f.runId }).where(eq(issues.id, f.issueId));
      await start(); await flush();
      expect(await state(f)).toMatchObject({ status: "in_progress" }); await quiet();
    });
    it("reactivates after an issue producer releases execution", async () => {
      const f = await fixture();
      await db.update(issues).set({ executionRunId: f.runId }).where(eq(issues.id, f.issueId));
      await start(); await flush(); await quiet();
      await issueService(db).update(f.issueId, { executionRunId: null });
      await flush(); expect(await state(f)).toMatchObject({ status: "in_review", externalConversationState: "waiting" });
    });
    it.each(["restore", "worktree"])("preserves %s suppression and activation", async mode => {
      const f = await fixture();
      const runtimeEnv = mode === "restore" ? { PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS: "true" }
        : { PAPERCLIP_IN_WORKTREE: "true", PAPERCLIP_INSTANCE_ID: "conversation-settlement-test" };
      const settings = instanceSettingsService(db, { runtimeEnv });
      if (mode === "worktree") await settings.updateExperimental({ enableWorktreeRunExecution: false });
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => admitted, canReconcile: () => admitted,
        onError: error => errors.push(error) });
      await heartbeatService(db, { runtimeEnv }).registerExternalConversationSettlementWork(coordinator, () => admitted).ready;
      await flush(); await quiet(); expect(await state(f)).toMatchObject({ status: "in_progress" });
      if (mode === "worktree") {
        try { await settings.updateExperimental({ enableWorktreeRunExecution: true }); await flush();
          expect(await state(f)).toMatchObject({ status: "in_review" }); await quiet();
        } finally { await settings.updateExperimental({ enableWorktreeRunExecution: false }); }
      }
    });
    it("joins in-flight settlement and reconstructs a later committed wake after restart", async () => {
      const first = await fixture(), second = await fixture();
      for (const f of [first, second]) await db.update(issues).set({ executionRunId: f.runId }).where(eq(issues.id, f.issueId));
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const entered = vi.fn();
      await start(async (...args) => { entered(); await gate; return settleSlackConversation(...args); });
      await flush(); await issueService(db).update(first.issueId, { executionRunId: null });
      await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(entered).toHaveBeenCalledTimes(1); });
      await issueService(db).update(second.issueId, { executionRunId: null });
      let stopped = false;
      const stopping = coordinator!.stop().then(() => { stopped = true; });
      try { await delay(20); expect(stopped).toBe(false); }
      finally { release(); await stopping; }
      expect(await state(first)).toMatchObject({ status: "in_review" });
      expect(await state(second)).toMatchObject({ status: "in_progress" });
      await start(); await flush(); expect(await state(second)).toMatchObject({ status: "in_review" }); await quiet();
    });
    it.each(["wake_owner", "escalate_to_board"] as const)("reactivates settlement checks after monitor recovery (%s)", async policy => {
      const f = await fixture();
      const enqueue = vi.fn<HeartbeatSchedulingDependencies["enqueueWakeup"]>(async () =>
        db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)).then(rows => rows[0]!));
      const scheduler = await exhaustedMonitor(f, enqueue, policy);
      await start(); await flush(); await quiet();
      expect(await state(f)).toMatchObject({ status: "in_progress" });
      await scheduler.triggerIssueMonitor(f.issueId);
      await flush();
      if (policy === "wake_owner") {
        expect(enqueue).toHaveBeenCalledOnce();
        expect(await state(f)).toMatchObject({ status: "in_review", externalConversationState: "waiting" });
      } else {
        const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
        expect(comments.some(comment => comment.body.includes("Recovery policy: escalate_to_board"))).toBe(true);


        expect(await state(f)).toMatchObject({ status: "in_progress", externalConversationState: "active" });
        expect(enqueue).not.toHaveBeenCalled();
      }
      await quiet();
    });
    it("reactivates when a failed chat retry releases its task receipt", async () => {
      const f = await fixture(), wakeId = randomUUID(), actionId = randomUUID();
      await db.insert(chatActions).values({ id: actionId, companyId: f.companyId, endpointId: f.endpointId,
        kind: "failed_run_retry", providerActionId: actionId, status: "failed", payload: { issueId: f.issueId } });
      await db.insert(agentWakeupRequests).values({ id: wakeId, companyId: f.companyId, agentId: f.agentId, source: "on_demand",
        reason: "task_retry", status: "deferred_issue_execution", payload: { issueId: f.issueId, taskRetry: {
          schema: "paperclip.task-retry.v1", generationId: wakeId, sourceRunId: f.runId, actorId: "local-board",
          strategy: "evaluate", chatActionId: actionId } } });
      await start(); await flush(); await quiet();
      await reconcileTaskChatRetryReceipts(db);
      await flush(); expect(await state(f)).toMatchObject({ status: "in_review" }); await quiet();
    });
    it.each(["run", "publication"])("wakes from real run/publication owners when %s finishes first", async first => {
      const f = await fixture();
      await db.update(heartbeatRuns).set({ status: "running", finishedAt: null }).where(eq(heartbeatRuns.id, f.runId));
      await db.update(chatPublications).set({ state: "delivery_unknown" }).where(eq(chatPublications.id, f.publicationId));
      const resolution = createChatPublicationResolution(db, {
        endpointRecord: async id => {
          const [endpoint] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, id));
          return { endpoint, assignedAgentName: "Carl", connectionName: "Slack", applicationId: randomUUID(), credentialSecretRefs: [] };
        },
        withCredentialMutationLease: chatCredentialMutationLease(db),
        teamsTransferProtocol: vi.fn(() => { throw new Error("Slack does not use Teams file resolution"); }),
        commitTaskControlCompletion: createChatPublicationTaskControl(db).commitTaskControlCompletion,
        processPendingPublications: vi.fn(async () => ({ attempted: 0 })),
        processProviderEffect: vi.fn(async () => undefined),
      });
      const lifecycle = createHeartbeatLifecycle(db, { emitTerminalAgentTaskRun: vi.fn() } as unknown as HeartbeatLifecycleDependencies);
      const finishRun = () => lifecycle.setRunStatus(f.runId, "succeeded", { finishedAt: new Date() });
      const publish = () => resolution.resolvePublication(f.endpointId, f.publicationId, "mark_delivered", "local-board");
      await start(); await flush(); await quiet();
      await (first === "run" ? finishRun() : publish()); await flush();
      expect(await state(f)).toMatchObject({ status: "in_progress" }); await quiet();
      await (first === "run" ? publish() : finishRun()); await flush();
      expect(await state(f)).toMatchObject({ status: "in_review" }); await quiet();
    });
    it("reactivates after administrative execution release", async () => {
      const f = await fixture();
      await db.update(issues).set({ executionRunId: f.runId }).where(eq(issues.id, f.issueId));
      await start(); await flush(); await quiet();
      await issueService(db).adminForceRelease(f.issueId);
      await flush(); expect(await state(f)).toMatchObject({ status: "in_review" }); await quiet();
    });
    it("reactivates after a blocking issue is removed", async () => {
      const f = await fixture(), blockerId = randomUUID();
      await db.insert(issues).values({ id: blockerId, companyId: f.companyId, title: "Blocker", status: "todo" });
      await issueService(db).update(f.issueId, { blockedByIssueIds: [blockerId] });
      await start(); await flush(); await quiet();
      await issueService(db).remove(blockerId);
      await flush(); expect(await state(f)).toMatchObject({ status: "in_review" }); await quiet();
    });
    it.each(["release", "cancel_wake", "fail_wake"])("reactivates through the wake queue's %s transaction", async operation => {
      const f = await fixture(true), wakeId = randomUUID();
      if (operation === "release") await db.update(issues).set({ executionRunId: f.runId }).where(eq(issues.id, f.issueId));
      else await db.insert(agentWakeupRequests).values({ id: wakeId, companyId: f.companyId, agentId: f.agentId,
        source: "on_demand", status: "deferred_issue_execution", payload: { issueId: f.issueId } });
      await start(); await flush(); await quiet();
      const adapter = createPostgresWakeQueueAdapter(db, {
        resolveResponsibleUserId: async () => "local-board",
        getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
        resolveSessionBeforeForWakeup: async () => null,
      });
      let entered = false;
      await adapter.withIssueExecutionLock({ companyId: f.companyId, runId: f.runId, now: new Date() }, async (_locked, ports) => {
        entered = true;
        if (operation === "cancel_wake") await ports.transaction.cancelDeferredWake({ companyId: f.companyId, wakeId, reason: "cancelled", now: new Date() });
        if (operation === "fail_wake") await ports.transaction.failDeferredWake({ companyId: f.companyId, wakeId, now: new Date() });
        return { outcome: { kind: "released" as const }, postCommitEffects: [] };
      });
      expect(entered).toBe(true);
      await flush(); expect(await state(f)).toMatchObject({ status: "in_review" }); await quiet();
    });
    it.each(["clear", "complete"])("reactivates after the goal owner reports %s", async outcome => {
      const f = await fixture();
      const binding = { companyId: f.companyId, issueId: f.issueId, agentId: f.agentId, adapterType: "codex_local" };
      await applyRunnerGoalPrpEvent(db, binding, { eventType: "session.goal.updated", sourceSeq: 1,
        payload: { goal: { objective: "Finish the conversation", status: "active" } } });
      await start(); await flush(); await quiet();
      expect(await state(f)).toMatchObject({ status: "in_progress" });
      await applyRunnerGoalPrpEvent(db, binding, { eventType: outcome === "clear" ? "session.goal.cleared" : "session.goal.updated",
        sourceSeq: 2, payload: outcome === "clear" ? {} : { goal: { objective: "Finish the conversation", status: "complete" } } });
      await flush(); expect(await state(f)).toMatchObject({ status: "in_review" }); await quiet();
    });
    it.each(["remove", "tombstone"])("reactivates after the comment owner performs %s", async operation => {
      const f = await fixture(), newer = randomUUID();
      await db.insert(issueComments).values({ id: newer, companyId: f.companyId, issueId: f.issueId,
        authorType: "user", authorUserId: "local-board", body: "another request" });
      await start(); await flush(); await quiet();
      if (operation === "remove") await issueService(db).removeComment(newer);
      else await issueService(db).tombstoneComment(newer, { actorType: "user", userId: "local-board" });
      await flush(); expect(await state(f)).toMatchObject({ status: "in_review" }); await quiet();
    });
    it("reactivates dependents when a different issue completes", async () => {
      const f = await fixture(), blockerId = randomUUID();
      await db.insert(issues).values({ id: blockerId, companyId: f.companyId, title: "Blocker", status: "todo" });
      await issueService(db).update(f.issueId, { blockedByIssueIds: [blockerId] });
      await start(); await flush(); await quiet();
      await issueService(db).update(blockerId, { status: "done" });
      await flush(); expect(await state(f)).toMatchObject({ status: "in_review" }); await quiet();
    });
    it.each(["commit", "rollback"])("honors the issue writer's outer %s", async outcome => {
      const f = await fixture();
      await db.update(issues).set({ executionRunId: f.runId }).where(eq(issues.id, f.issueId));
      await start(); await flush();
      const transaction = db.transaction(async tx => {
        await issueService(db).update(f.issueId, { executionRunId: null }, tx);
        await vi.advanceTimersByTimeAsync(5000);
        expect(await state(f)).toMatchObject({ status: "in_progress" });
        if (outcome === "rollback") throw new Error("rollback execution release");
      });
      if (outcome === "rollback") await expect(transaction).rejects.toThrow("rollback execution release");
      else await transaction;
      await flush();
      expect(await state(f)).toMatchObject({ status: outcome === "rollback" ? "in_progress" : "in_review" });
      await quiet();
    });
    it("preserves a release committed during drain until resume", async () => {
      const f = await fixture();
      await db.update(issues).set({ executionRunId: f.runId }).where(eq(issues.id, f.issueId));
      await start(); await flush(); admitted = false;
      await issueService(db).update(f.issueId, { executionRunId: null });
      await vi.advanceTimersByTimeAsync(120_000); await quiet();
      expect(await state(f)).toMatchObject({ status: "in_progress" });
      admitted = true; await vi.advanceTimersByTimeAsync(30_000); await flush();
      expect(await state(f)).toMatchObject({ status: "in_review" }); await quiet();
    });
    it("reconstructs failed settlement after drain and restart", async () => {
      const f = await fixture();
      await start(async () => { throw new Error("settlement unavailable"); });
      expect(errors.length).toBeGreaterThan(0); errors.splice(0);
      expect(coordinator!.nextWakeAt()).not.toBeNull(); admitted = false;
      await vi.advanceTimersByTimeAsync(120_000); await quiet();
      expect(await state(f)).toMatchObject({ status: "in_progress" });
      await coordinator!.stop(); admitted = true; await start(); await flush();
      expect(await state(f)).toMatchObject({ status: "in_review" }); await quiet();
    });
    it("reactivates when the approval owner removes the last blocker", async () => {
      const f = await fixture(), approvalId = randomUUID();
      await db.insert(approvals).values({ id: approvalId, companyId: f.companyId, type: "approve_ceo_strategy", status: "pending", payload: {} });
      await issueApprovalService(db).link(f.issueId, approvalId);
      await start(); await flush(); await quiet();
      await issueApprovalService(db).unlink(f.issueId, approvalId);
      await flush(); expect(await state(f)).toMatchObject({ status: "in_review", externalConversationState: "waiting" });
    });
  });

  it("discovers active candidates without treating unready or retained conversations as work", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ status: "running", finishedAt: null }).where(eq(heartbeatRuns.id, f.runId));
    expect(await externalConversationSettlementCandidates(db, { companyId: f.companyId })).toEqual([{ id: f.issueId, companyId: f.companyId }]);
    expect(await pendingExternalConversationSettlement(db, f.companyId, f.issueId)).toBe(false);
    expect(await externalConversationSettlementCandidates(db, { companyId: f.companyId }, f.issueId)).toEqual([]);
    expect(await externalConversationSettlementCandidates(db, { companyId: randomUUID(), issueId: f.issueId })).toEqual([]);
    await db.update(chatConversations).set({ state: "waiting" }).where(eq(chatConversations.id, f.conversationId));
    expect(await externalConversationSettlementCandidates(db, { companyId: f.companyId })).toEqual([]);
  });

  it.each([false, true])("settles a published answered turn once (native=%s)", async (native) => {
    const f = await fixture(native);
    expect(await pendingExternalConversationSettlement(db, f.companyId, f.issueId)).toBe(true);
    expect(await settle(f)).toBe(true);
    expect(await state(f)).toEqual({ status: "in_review", externalConversationState: "waiting" });
    expect(await pendingExternalConversationSettlement(db, f.companyId, f.issueId)).toBe(false);
    expect(await settle(f)).toBe(false);
    expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, f.issueId), eq(activityLog.action, "issue.updated")))).toHaveLength(1);
    expect(await db.select().from(issues).where(and(eq(issues.id, f.issueId), executionIssueCondition()))).toHaveLength(0);
    expect((await issueService(db).getById(f.issueId))?.externalConversationState).toBe("waiting");
    expect(await issueService(db).list(f.companyId)).toHaveLength(0);
    expect((await dashboardService(db).summary(f.companyId)).tasks.open).toBe(0);
    expect((await attentionService(db).list(f.companyId)).items.filter((item) => item.issueId === f.issueId)).toHaveLength(0);
    const results = await companySearchService(db).search(f.companyId, companySearchQuerySchema.parse({ q: "you there" }));
    expect(results.results.find((result) => result.issue?.id === f.issueId)?.issue?.externalConversationState).toBe("waiting");
    expect((await issueService(db).list(f.companyId, { q: "you there" }))[0]?.externalConversationState).toBe("waiting");
    expect((await issueService(db).listReviewAttention(f.companyId, [{ id: f.issueId, companyId: f.companyId, status: "in_review" }])).get(f.issueId)?.state).toBe("none");
  });

  it("settles and resumes Speko-owned tasks without adopting existing task lifecycles", async () => {
    const f = await fixture(true);
    await db.update(chatEndpoints).set({ provider: "speko" }).where(eq(chatEndpoints.id, f.endpointId));
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, source: "chat:speko", wakeCommentId: f.wakeId, wakeCommentIds: [f.wakeId] } }).where(eq(heartbeatRuns.id, f.runId));
    expect(await pendingExternalConversationSettlement(db, f.companyId, f.issueId)).toBe(false);
    expect(await settle(f)).toBe(false);
    await db.update(issues).set({ originId: f.endpointId }).where(eq(issues.id, f.issueId));
    expect(await pendingExternalConversationSettlement(db, f.companyId, f.issueId)).toBe(true);
    expect(await settle(f)).toBe(true);
    expect(await state(f)).toMatchObject({ status: "in_review", externalConversationState: "waiting" });
    await db.transaction(tx => resumeExternalConversation(tx as unknown as typeof db, f.companyId, f.issueId));
    expect(await state(f)).toMatchObject({ status: "todo", externalConversationState: "active" });
  });

  it("preserves waiting state in compact list responses used by the Inbox", async () => {
    const f = await fixture();
    await settle(f);
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = { type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    const response = await request(app).get(`/api/companies/${f.companyId}/issues`)
      .query({ view: "compact", q: "you there" });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toEqual([expect.objectContaining({ id: f.issueId, status: "in_review", externalConversationState: "waiting" })]);
  });

  it("defers generic dispatch while the settlement worker owns an answered turn", async () => {
    const f = await fixture();
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const [{ createdAt }] = await db.select({ createdAt: issues.createdAt }).from(issues).where(eq(issues.id, f.issueId));
    await recovery.reconcileStrandedAssignedIssues({ skipExternalConversationSettlement: true, issueCreatedAtGte: createdAt });
    expect(await state(f)).toMatchObject({ status: "in_progress", externalConversationState: "active" });
    expect(enqueueWakeup).not.toHaveBeenCalled();
    expect(await settle(f)).toBe(true);
    await recovery.reconcileStrandedAssignedIssues({ skipExternalConversationSettlement: true, issueCreatedAtGte: createdAt });
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("reconciles an already-answered conversation without another model run", async () => {
    const f = await fixture();
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    // Restrict to this newly created fixture, like the rollout reconciler's candidate scan.
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    await recovery.reconcileStrandedAssignedIssues({ issueCreatedAtGte: issue.createdAt });
    expect((await state(f))?.externalConversationState).toBe("waiting");
    await recovery.reconcileStrandedAssignedIssues({ issueCreatedAtGte: issue.createdAt });
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("waits for both finalization and delivery, regardless of their order", async () => {
    for (const first of ["run", "publication"]) {
      const f = await fixture();
      if (first === "run") await db.update(chatPublications).set({ state: "pending" }).where(eq(chatPublications.id, f.publicationId));
      else await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, f.runId));
      expect(await pendingExternalConversationSettlement(db, f.companyId, f.issueId)).toBe(false);
      expect(await settle(f)).toBe(false);
      await db.update(chatPublications).set({ state: "published" }).where(eq(chatPublications.id, f.publicationId));
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.runId));
      expect(await pendingExternalConversationSettlement(db, f.companyId, f.issueId)).toBe(true);
      expect(await settle(f)).toBe(true);
    }
  });

  it("a new board message reactivates the same conversation and prevents stale settlement", async () => {
    const f = await fixture();
    await settle(f);
    const followup = await issueService(db).addComment(f.issueId, "what's your name?", { userId: "local-board" });
    expect((await state(f))?.externalConversationState).toBe("active");
    expect(await pendingExternalConversationSettlement(db, f.companyId, f.issueId)).toBe(false);
    expect(await settle(f)).toBe(false);
    expect((await state(f))?.status).toBe("todo");
    await issueService(db).checkout(f.issueId, f.agentId, ["todo", "backlog", "blocked"], null);
    expect((await state(f))?.status).toBe("in_progress");
    const nextRun = randomUUID();
    await db.insert(chatMessageLinks).values({ companyId: f.companyId, endpointId: f.endpointId, conversationId: f.conversationId, commentId: followup.id, providerMessageId: followup.id, direction: "inbound" });
    await db.insert(heartbeatRuns).values({ id: nextRun, companyId: f.companyId, agentId: f.agentId, runtimeMode: "legacy", status: "succeeded", finishedAt: new Date(),
      contextSnapshot: { issueId: f.issueId, source: "chat:slack", wakeCommentId: followup.id } });
    const [response] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorAgentId: f.agentId, createdByRunId: nextRun, body: "Carl", metadata: { version: 1, authorizationReason: "allow_chat_run_presentation", sections: [] } }).returning();
    await db.insert(chatPublications).values({ companyId: f.companyId, endpointId: f.endpointId, conversationId: f.conversationId, issueId: f.issueId, commentId: response.id,
      idempotencyKey: nextRun, payload: { text: "Carl" }, state: "published", providerMessageId: nextRun });
    expect(await pendingExternalConversationSettlement(db, f.companyId, f.issueId)).toBe(true);
    expect(await settle(f)).toBe(true);
    expect((await state(f))?.externalConversationState).toBe("waiting");
  });

  it("serializes simultaneous finalizers and a new message without losing the message", async () => {
    const f = await fixture();
    await Promise.all([settle(f), settle(f), issueService(db).addComment(f.issueId, "another request", { userId: "local-board" })]);
    expect((await state(f))?.externalConversationState).toBe("active");
    expect(await pendingExternalConversationSettlement(db, f.companyId, f.issueId)).toBe(false);
    expect(await settle(f)).toBe(false);
  });

  it("lets an operator explicitly request review instead of keeping Idle", async () => {
    const f = await fixture();
    await settle(f);
    await issueService(db).update(f.issueId, { status: "in_review", actorUserId: "local-board" });
    expect(await state(f)).toEqual({ status: "in_review", externalConversationState: "active" });
    expect(await pendingExternalConversationSettlement(db, f.companyId, f.issueId)).toBe(false);
    expect(await settle(f)).toBe(false);
  });

  it("duplicate board delivery does not reactivate an answered turn", async () => {
    const f = await fixture();
    const clientRequestId = randomUUID();
    await db.update(issueComments).set({ clientRequestId }).where(eq(issueComments.id, f.wakeId));
    await settle(f);
    const duplicate = await issueService(db).addComment(f.issueId, "you there?", { userId: "local-board" }, { clientRequestId });
    expect(duplicate.id).toBe(f.wakeId);
    expect((await state(f))?.externalConversationState).toBe("waiting");
  });

  it("keeps delivery errors visible after a conversation has settled", async () => {
    const f = await fixture();
    await settle(f);
    await db.update(chatPublications).set({ state: "failed" }).where(eq(chatPublications.id, f.publicationId));
    expect((await state(f))?.externalConversationState).toBe("active");
    expect(await db.select().from(issues).where(and(eq(issues.id, f.issueId), executionIssueCondition()))).toHaveLength(1);
  });

  it("does not settle past an unlinked Slack guest's newer message", async () => {
    const f = await fixture();
    const [message] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "system", body: "one more thing" }).returning();
    await db.insert(chatMessageLinks).values({ companyId: f.companyId, endpointId: f.endpointId, conversationId: f.conversationId, commentId: message.id, providerMessageId: message.id, direction: "inbound" });
    expect(await pendingExternalConversationSettlement(db, f.companyId, f.issueId)).toBe(false);
    expect(await settle(f)).toBe(false);
  });

  it("requires committed native response-wait evidence", async () => {
    const f = await fixture(true);
    await db.update(nativeRunFinalizations).set({ phase: "arbitrating" }).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(await pendingExternalConversationSettlement(db, f.companyId, f.issueId)).toBe(false);
    expect(await settle(f)).toBe(false);
    await db.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, f.runId));
    await db.update(heartbeatRuns).set({ resultJson: { finalizationReasonCode: "governed_response_waiting" } }).where(eq(heartbeatRuns.id, f.runId));
    expect(await pendingExternalConversationSettlement(db, f.companyId, f.issueId)).toBe(false);
    expect(await settle(f)).toBe(false);
  });

  it("settles an authorized published reply after an interaction continuation", async () => {
    const f = await fixture(true);
    const [answer] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: "local-board", body: "Here is the requested answer", createdAt: new Date(f.start.getTime() + 2) }).returning();
    await db.update(heartbeatRuns).set({ contextSnapshot: {
      issueId: f.issueId, source: "issue.interaction.respond", externalChatContinuation: true, wakeCommentId: answer.id,
    } }).where(eq(heartbeatRuns.id, f.runId));
    expect(await pendingExternalConversationSettlement(db, f.companyId, f.issueId)).toBe(true);
    expect(await settle(f)).toBe(true);
  });

  it("waits for execution release before moving the issue to review", async () => {
    const f = await fixture();
    await db.update(issues).set({ executionRunId: f.runId }).where(eq(issues.id, f.issueId));
    expect(await pendingExternalConversationSettlement(db, f.companyId, f.issueId)).toBe(false);
    expect(await settle(f)).toBe(false);
    expect((await state(f))?.status).toBe("in_progress");
    await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, f.issueId));
    expect(await pendingExternalConversationSettlement(db, f.companyId, f.issueId)).toBe(true);
    expect(await settle(f)).toBe(true);
  });

  it.each([
    { status: "pending" },
    { status: "changes_requested" },
    { status: "idle", monitor: { status: "scheduled" } },
    { status: "idle", monitor: { status: "triggered" } },
  ])("preserves governed or monitored unfinished work: %j", async (executionState) => {
    const f = await fixture();
    await db.update(issues).set({ executionState }).where(eq(issues.id, f.issueId));
    expect(await pendingExternalConversationSettlement(db, f.companyId, f.issueId)).toBe(false);
    expect(await settle(f)).toBe(false);
  });

  it("preserves pending interactions and removes Idle if a real review is requested later", async () => {
    const f = await fixture();
    await settle(f);
    await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId, kind: "request_confirmation", payload: { version: 1, prompt: "Approve?" } });
    expect((await state(f))?.externalConversationState).toBe("active");
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, f.issueId));
    await db.update(chatConversations).set({ state: "active" }).where(eq(chatConversations.id, f.conversationId));
    expect(await pendingExternalConversationSettlement(db, f.companyId, f.issueId)).toBe(false);
    expect(await settle(f)).toBe(false);
  });

  it.each(["failed", "cancelled", "timed_out", "queued", "running", "scheduled_retry"])("does not park a %s run", async (status) => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ status }).where(eq(heartbeatRuns.id, f.runId));
    expect(await pendingExternalConversationSettlement(db, f.companyId, f.issueId)).toBe(false);
    expect(await settle(f)).toBe(false);
  });
  it.each(["pending", "failed", "delivery_unknown", "retry", "streaming", "awaiting_consent"] as const)("does not park %s delivery", async (state) => {
    const f = await fixture();
    await db.update(chatPublications).set({ state }).where(eq(chatPublications.id, f.publicationId));
    expect(await pendingExternalConversationSettlement(db, f.companyId, f.issueId)).toBe(false);
    expect(await settle(f)).toBe(false);
  });
  it.each(["done", "blocked", "cancelled", "in_review"])("preserves explicit %s disposition", async (status) => {
    const f = await fixture();
    await db.update(issues).set({ status }).where(eq(issues.id, f.issueId));
    expect(await pendingExternalConversationSettlement(db, f.companyId, f.issueId)).toBe(false);
    expect(await settle(f)).toBe(false);
  });
  it.each(["completed", "unavailable", "endpoint_removed"])("does not reactivate a %s conversation", async (state) => {
    const f = await fixture();
    await db.update(chatConversations).set({ state }).where(eq(chatConversations.id, f.conversationId));
    expect(await pendingExternalConversationSettlement(db, f.companyId, f.issueId)).toBe(false);
    expect(await settle(f)).toBe(false);
  });
  it("respects company, provider, and connection boundaries", async () => {
    const f = await fixture();
    expect(await settleSlackConversation(db, randomUUID(), f.issueId)).toBe(false);
    await db.update(chatEndpoints).set({ status: "revoked" }).where(eq(chatEndpoints.id, f.endpointId));
    expect(await pendingExternalConversationSettlement(db, f.companyId, f.issueId)).toBe(false);
    expect(await settle(f)).toBe(false);
    await db.update(chatEndpoints).set({ status: "active", provider: "telegram" }).where(eq(chatEndpoints.id, f.endpointId));
    expect(await pendingExternalConversationSettlement(db, f.companyId, f.issueId)).toBe(false);
    expect(await settle(f)).toBe(false);
  });
  it("preserves scheduled work, newer runs, queued wakes, monitors, blockers, and approvals", async () => {
    const monitor = await fixture();
    await db.update(issues).set({ monitorNextCheckAt: new Date(Date.now() + 60000) }).where(eq(issues.id, monitor.issueId));
    expect(await settle(monitor)).toBe(false);
    const queued = await fixture();
    await db.insert(agentWakeupRequests).values({ companyId: queued.companyId, agentId: queued.agentId, source: "automation", status: "deferred_issue_execution", payload: { issueId: queued.issueId } });
    expect(await settle(queued)).toBe(false);
    const newer = await fixture();
    await db.insert(heartbeatRuns).values({ companyId: newer.companyId, agentId: newer.agentId, status: "scheduled_retry", contextSnapshot: { issueId: newer.issueId } });
    expect(await settle(newer)).toBe(false);
    const blocked = await fixture();
    const [blocker] = await db.insert(issues).values({ companyId: blocked.companyId, title: "dependency", status: "todo" }).returning();
    await db.insert(issueRelations).values({ companyId: blocked.companyId, issueId: blocker.id, relatedIssueId: blocked.issueId, type: "blocks" });
    expect(await settle(blocked)).toBe(false);
    const review = await fixture();
    const [approval] = await db.insert(approvals).values({ companyId: review.companyId, type: "hire_agent", status: "pending", payload: {} }).returning();
    await db.insert(issueApprovals).values({ companyId: review.companyId, issueId: review.issueId, approvalId: approval.id });
    expect(await settle(review)).toBe(false);
  });
});
