import { getTableName } from "drizzle-orm";
import { taskWatchdogService } from "../task-watchdogs.js";
import { readIdleIssueSchedule } from "../idle-issue-schedule.js";
import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { PROVIDER_QUOTA_MONITOR_SERVICE_NAME } from "@paperclipai/shared";
import { readIdleRetrySchedule } from "./idle-retry-schedule.js";
import { readIdleQuotaSchedule } from "./idle-quota-schedule.js";
import { bindIdleDeadlineOwner } from "../idle-deadline-owner.js";

const now = Date.parse("2099-01-01T00:00:00Z");
const owner = () => ({ revision: "registered:1", reconciled: true });
function tx(rows: unknown[], onRead: () => void = () => {}, receipts: unknown[] = []) {
  let reads = 0;
  const query = { from: () => query, leftJoin: () => query, where: () => query, orderBy: () => query,
    limit: async () => { onRead(); return reads++ === 0 ? rows : receipts; } };
  return { select: () => query } as unknown as Pick<Db, "select" | "execute">;
}
function retry() {
  return { run: { id: "retry", scopeKind: "issue", issueId: "issue", companyId: "company", agentId: "agent", wakeupRequestId: "wake", status: "scheduled_retry",
    runtimeMode: "legacy", nativeIssueId: null, nativeSessionId: null, processPid: null, processGroupId: null,
    processStartedAt: null, controllerBootId: null, controllerLeaseExpiresAt: null, hasProcessSettlement: false,
    scheduledRetryAt: new Date(now + 600_000), startedAt: null, finishedAt: null, costAccountingPending: false, resultJson: null },
    source: { id: "source", companyId: "company", agentId: "agent", scopeKind: "issue", issueId: "issue",
      nativeIssueId: null, nativeSessionId: null, runtimeMode: "legacy", status: "failed", settled: true,
      hasCancellation: false, processPid: null, processGroupId: null, processStartedAt: null,
      controllerBootId: null, controllerLeaseExpiresAt: null, legacyProcessSettlement: null, finishedAt: new Date(now - 1000) },
    wake: { id: "wake", runId: "retry", companyId: "company", agentId: "agent", status: "queued", finishedAt: null },
    agent: { id: "agent", companyId: "company", status: "idle" }, company: { status: "active" },
    issue: { id: "issue", companyId: "company", assigneeAgentId: "agent", assigneeUserId: null, status: "in_progress",
      executionRunId: null, checkoutRunId: null, executionState: null } };
}
function quota() {
  return { issue: { id: "issue", companyId: "company", assigneeAgentId: "agent", assigneeUserId: null,
    status: "in_progress", monitorNextCheckAt: new Date(now + 600_000), monitorWakeRequestedAt: null, monitorAttemptCount: 0,
    executionRunId: null, checkoutRunId: null, conversationAgentId: null, executionState: null,
    executionPolicy: { monitor: { nextCheckAt: new Date(now + 600_000).toISOString(), notes: null, scheduledBy: "assignee",
      kind: "external_service", serviceName: PROVIDER_QUOTA_MONITOR_SERVICE_NAME, externalRef: "source", timeoutAt: null,
      maxAttempts: null, recoveryPolicy: "wake_owner" } } },
    source: { id: "source", companyId: "company", agentId: "agent", contextSnapshot: { issueId: "issue" },
      status: "failed", finishedAt: new Date(now - 1000), runtimeMode: "legacy", costAccountingPending: false },
    target: { id: "agent", companyId: "company", status: "idle" }, company: { status: "active" } };
}
describe("owned recovery deadline inspection", () => {
  it("retains the actual retry deadline and only its exact paired queued wake", async () => {
    const row = retry();
    expect(await readIdleRetrySchedule(tx([row]), now, owner)).toMatchObject({ blocked: false,
      deadlines: [now + 600_000], runIds: ["retry"], wakeIds: ["wake"], issueWaits: [{ kind: "scheduled_retry", issueId: "issue", runId: "retry" }] });
    for (const patch of [{ companyId: "foreign" }, { agentId: "foreign" }, { runId: "foreign" }, { id: "foreign" }, { status: "coalesced" }]) {
      expect((await readIdleRetrySchedule(tx([{ ...retry(), wake: { ...row.wake, ...patch } }]), now, owner)).blocked).toBe(true);
    }
    for (const patch of [{ scheduledRetryAt: null }, { scheduledRetryAt: new Date(now) }, { costAccountingPending: true },
      { resultJson: { startupCancellation: {} } }, { runtimeMode: "native" }]) {
      expect((await readIdleRetrySchedule(tx([{ ...retry(), run: { ...row.run, ...patch } }]), now, owner)).blocked).toBe(true);
    }
  });
  it("requires an exact settled predecessor for an ordinary issue retry", async () => {
    const row = retry();
    expect((await readIdleRetrySchedule(tx([row]), now, owner)).blocked).toBe(false);
    const sources = [
      ["missing", null],
      ["foreign company", { ...row.source, companyId: "foreign" }],
      ["foreign agent", { ...row.source, agentId: "foreign" }],
      ["foreign issue", { ...row.source, issueId: "foreign" }],
      ["company scope", { ...row.source, scopeKind: "company" }],
      ["unknown scope", { ...row.source, scopeKind: "unknown" }],
      ["cancelled", { ...row.source, hasCancellation: true }],
      ["unsettled", { ...row.source, settled: false }],
      ["running", { ...row.source, status: "running" }],
      ["native runtime", { ...row.source, runtimeMode: "native" }],
      ["native issue", { ...row.source, nativeIssueId: "issue" }],
      ["native session", { ...row.source, nativeSessionId: "session" }],
      ["retained PID without receipt", { ...row.source, processPid: 42 }],
      ["retained birth without receipt", { ...row.source, processStartedAt: new Date(now - 2000) }],
    ];
    for (const [label, source] of sources) {
      expect((await readIdleRetrySchedule(tx([{ ...row, source }]), now, owner)).blocked, String(label)).toBe(true);
    }
  });
  it("binds retained process settlement to every source identity field for an ordinary issue retry", async () => {
    const row = retry();
    const identity = { ...row.source, processPid: 42, processGroupId: 42,
      processStartedAt: new Date(now - 2000), controllerBootId: "boot" };
    const receipt = { schema: "paperclip.legacy-process-settlement.v1", runId: identity.id,
      companyId: identity.companyId, agentId: identity.agentId, runtimeMode: "legacy", targetKind: "local",
      controllerBootId: identity.controllerBootId, processPid: identity.processPid, processGroupId: identity.processGroupId,
      processStartedAt: identity.processStartedAt.toISOString(), finishedAt: identity.finishedAt.toISOString(), status: identity.status };
    const retained = { ...row, source: { ...identity, legacyProcessSettlement: receipt } };
    expect((await readIdleRetrySchedule(tx([retained]), now, owner)).blocked).toBe(false);
    for (const patch of [{ schema: "unknown" }, { runId: "foreign" }, { companyId: "foreign" },
      { agentId: "foreign" }, { runtimeMode: "native" }, { targetKind: "remote" }, { controllerBootId: "foreign" },
      { processPid: 43 }, { processGroupId: 43 }, { processStartedAt: new Date(now - 3000).toISOString() },
      { finishedAt: new Date(now - 2000).toISOString() }, { status: "interrupted" }, { extra: true }]) {
      expect((await readIdleRetrySchedule(tx([{ ...retained, source: { ...retained.source,
        legacyProcessSettlement: { ...receipt, ...patch } } }]), now, owner)).blocked, JSON.stringify(patch)).toBe(true);
    }
    for (const proof of [null, {}, [], { ...receipt, processPid: "42" }]) {
      expect((await readIdleRetrySchedule(tx([{ ...retained, source: { ...retained.source,
        legacyProcessSettlement: proof } }]), now, owner)).blocked, JSON.stringify(proof)).toBe(true);
    }
    for (const patch of [{ processPid: 43 }, { processGroupId: 43 }, { controllerBootId: "claimed" },
      { processStartedAt: new Date(now - 3000) }, { finishedAt: null }, { nativeIssueId: "issue" },
      { nativeSessionId: "session" }, { controllerLeaseExpiresAt: new Date(0) },
      { controllerLeaseExpiresAt: new Date(now + 1000) }]) {
      expect((await readIdleRetrySchedule(tx([{ ...retained, source: { ...retained.source, ...patch } }]), now, owner)).blocked,
        JSON.stringify(patch)).toBe(true);
    }
  });
  it("rejects runtime ownership on the future target of an ordinary issue retry", async () => {
    const row = retry();
    for (const patch of [{ runtimeMode: "unknown" }, { runtimeMode: null }, { nativeIssueId: "issue" },
      { nativeSessionId: "session" }, { processPid: 42 }, { processPid: 0 }, { processGroupId: 42 },
      { processStartedAt: new Date(now - 2000) }, { controllerBootId: "boot" }, { controllerBootId: "" },
      { controllerLeaseExpiresAt: new Date(0) }, { controllerLeaseExpiresAt: new Date(now + 1000) },
      { hasProcessSettlement: true }]) {
      expect((await readIdleRetrySchedule(tx([{ ...row, run: { ...row.run, ...patch } }]), now, owner)).blocked,
        JSON.stringify(patch)).toBe(true);
    }
  });
  it("covers explicit company retries without granting incidental task context authority", async () => {
    const row = retry();
    const company = { ...row, issue: null, run: { ...row.run, scopeKind: "company", issueId: null,
      runtimeMode: "legacy", scopedContinuation: false, responsibleUserId: "owner", responsibleUserActive: true, agentMemberActive: true },
      source: { id: "source", companyId: "company", agentId: "agent", scopeKind: "company", issueId: null,
        nativeIssueId: null, runtimeMode: "legacy", status: "failed", settled: true, hasCancellation: false,
        processPid: null, processGroupId: null, processStartedAt: null, controllerBootId: null, controllerLeaseExpiresAt: null, legacyProcessSettlement: null } };
    expect(await readIdleRetrySchedule(tx([company]), now, owner)).toMatchObject({ blocked: false,
      runIds: ["retry"], wakeIds: ["wake"], issueWaits: [] });
    for (const patch of [{ scopeKind: "unknown" }, { issueId: "issue" }, { nativeIssueId: "native" },
      { responsibleUserActive: false }, { agentMemberActive: false }, { processPid: 42 }, { scopedContinuation: true }]) {
      expect((await readIdleRetrySchedule(tx([{ ...company, run: { ...company.run, ...patch } }]), now, owner)).blocked).toBe(true);
    }
    for (const patch of [{ companyId: "foreign" }, { agentId: "foreign" }, { settled: false },
      { scopedContinuation: true }, { processPid: 42 }, { scopeKind: "issue" }, { runtimeMode: "native" }, { controllerBootId: "live" }]) {
      expect((await readIdleRetrySchedule(tx([{ ...company, source: { ...company.source, ...patch } }]), now, owner)).blocked).toBe(true);
    }
  });
  it("covers only finished exact represented coalesced receipts for the inspected retry", async () => {
    const receipt = { id: "coalesced", runId: "retry", companyId: "company", agentId: "agent",
      status: "coalesced", finishedAt: new Date(now - 1000), represented: true };
    expect(await readIdleRetrySchedule(tx([retry()], () => {}, [receipt]), now, owner)).toMatchObject({
      blocked: false, wakeIds: ["wake", "coalesced"] });
    for (const patch of [{ runId: "orphan" }, { companyId: "foreign" }, { agentId: "foreign" },
      { unsupportedContinuation: true }, { represented: false }, { represented: null }, { finishedAt: null }]) {
      expect((await readIdleRetrySchedule(tx([retry()], () => {}, [{ ...receipt, ...patch }]), now, owner)).blocked).toBe(true);
    }
  });
  it("binds a review retry to the exact current stage, participant and safe failed predecessor", async () => {
    const row = retry();
    const reviewerAgentId = "11111111-1111-4111-8111-111111111111";
    const stageId = "22222222-2222-4222-8222-222222222222";
    const review = { ...row, run: { ...row.run, agentId: reviewerAgentId, runtimeMode: "legacy",
      responsibleUserActive: true, agentMemberActive: true }, wake: { ...row.wake, agentId: reviewerAgentId },
      source: { companyId: "company", agentId: reviewerAgentId, scopeKind: "issue", issueId: "issue",
        contextIssueId: "issue", contextStageId: stageId, runtimeMode: "legacy", status: "failed", settled: true, safePreparationFailure: true,
        processPid: null, processGroupId: null, processStartedAt: null, controllerBootId: null, controllerLeaseExpiresAt: null, legacyProcessSettlement: null },
      issue: { ...row.issue, status: "in_review", executionState: { status: "pending", currentStageId: stageId,
        currentStageIndex: 0, currentStageType: "review", currentParticipant: { type: "agent", agentId: reviewerAgentId, userId: null },
        returnAssignee: null, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null },
        executionPolicy: { stages: [{ id: stageId, type: "review", participants: [{ type: "agent", agentId: reviewerAgentId, userId: null }] }] } } };
    expect(await readIdleRetrySchedule(tx([review]), now, owner)).toMatchObject({ blocked: false,
      issueWaits: [{ kind: "current_review_retry", issueId: "issue", runId: "retry", reviewerAgentId, stageId }] });
    for (const patch of [{ contextStageId: null }, { contextStageId: "changed" }, { companyId: "foreign" },
      { hasCancellation: true }, { scopeKind: "company" }, { contextIssueId: "foreign" }, { safePreparationFailure: false }, { runtimeMode: "native" }]) {
      expect((await readIdleRetrySchedule(tx([{ ...review, source: { ...review.source, ...patch } }]), now, owner)).blocked).toBe(true);
    }
    for (const patch of [{ currentStageIndex: 1 }, { status: "idle" }, { currentStageId: "changed" },
      { currentParticipant: { type: "user", userId: "human" } }]) {
      expect((await readIdleRetrySchedule(tx([{ ...review, issue: { ...review.issue,
        executionState: { ...review.issue.executionState, ...patch } } }]), now, owner)).blocked).toBe(true);
    }
    const common = { id: "issue", status: "in_review", company_status: "active", scoped: true,
      assignee_agent_id: "implementor", assignee_user_id: null, agent_status: "idle", unsafe_dependencies: false,
      checkout_run_id: null, execution_run_id: null, conversation_agent_id: null, monitor_wake_requested_at: null,
      monitor_next_check_at: null, execution_policy: review.issue.executionPolicy, execution_state: review.issue.executionState,
      unblock_descriptor: null, dependency_ready: false, response_driven_wait: false, passive_conversation: false };
    const wait = { kind: "current_review_retry" as const, issueId: "issue", runId: "retry", reviewerAgentId, stageId };
    const read = (rows: unknown[], waits = [wait]) => readIdleIssueSchedule({ execute: async () => rows } as unknown as Pick<Db, "execute">, "owner", now, waits);
    expect((await read([common])).blocked).toBe(false);
    expect((await read([common], [])).blocked).toBe(true);
    for (const patch of [{ unsafe_dependencies: true }, { scoped: false }, { execution_run_id: "foreign" },
      { checkout_run_id: "foreign" }, { company_status: "paused" }, { execution_policy: null },
      { execution_state: { ...review.issue.executionState, currentStageId: "changed" } }]) {
      expect((await read([{ ...common, ...patch }])).blocked).toBe(true);
    }
    expect((await read([common, { ...common, id: "unknown-sibling", status: "unknown" }])).blocked).toBe(true);
  });
  it("uses the current agent reviewer rather than the source assignee", async () => {
    const row = quota();
    const reviewer = "11111111-1111-4111-8111-111111111111";
    const stage = "22222222-2222-4222-8222-222222222222";
    const review = { ...row, issue: { ...row.issue, status: "in_review", executionState: {
      status: "pending", currentStageId: stage, currentStageIndex: 0, currentStageType: "review",
      currentParticipant: { type: "agent", agentId: reviewer, userId: null }, returnAssignee: null,
      completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null,
    }, executionPolicy: { ...row.issue.executionPolicy, stages: [{ id: stage, type: "review", participants: [{ type: "agent", agentId: reviewer, userId: null }] }] } }, source: { ...row.source, agentId: reviewer }, target: { ...row.target, id: reviewer } };
    expect((await readIdleQuotaSchedule(tx([review]), now, owner)).blocked).toBe(false);
    expect((await readIdleQuotaSchedule(tx([{ ...review, source: row.source }]), now, owner)).blocked).toBe(true);
    expect((await readIdleQuotaSchedule(tx([{ ...review, issue: { ...review.issue, executionPolicy: row.issue.executionPolicy } }]), now, owner)).blocked).toBe(true);
  });
  it("keeps covered waits under common scope, dependency and sibling guards", async () => {
    const row = { id: "issue", company_id: "company", status: "in_progress", updated_at: new Date(now),
      assignee_agent_id: "agent", assignee_user_id: null, checkout_run_id: null, execution_run_id: null,
      execution_policy: quota().issue.executionPolicy, execution_state: null, unblock_descriptor: null,
      conversation_agent_id: null, monitor_next_check_at: new Date(now + 600_000), monitor_wake_requested_at: null,
      monitor_attempt_count: 0, company_status: "active", company_updated: new Date(now), agent_status: "idle",
      agent_updated: new Date(now), scoped: true, unsafe_dependencies: false, dependency_ready: false,
      untouched_onboarding: false, response_driven_wait: false, unblock_request_finished: false, passive_conversation: false };
    const waits = [{ kind: "provider_quota" as const, issueId: "issue", sourceRunId: "source", targetAgentId: "agent", reviewer: false }];
    const read = (rows: unknown[]) => readIdleIssueSchedule({ execute: async () => rows } as unknown as Pick<Db, "execute">, "owner", now, waits);
    expect((await read([row])).blocked).toBe(false);
    for (const patch of [{ unsafe_dependencies: true }, { scoped: false }, { company_status: "paused" },
      { status: "unknown" }, { execution_state: { status: "unknown" } }, { execution_state: { status: "pending" } },
      { checkout_run_id: "foreign" }, { execution_run_id: "foreign" }]) {
      expect((await read([{ ...row, ...patch }])).blocked).toBe(true);
    }
    expect((await read([row, { ...row, id: "sibling", status: "unknown" }])).blocked).toBe(true);
    expect((await read([row, { ...row, id: "sibling", unsafe_dependencies: true }])).blocked).toBe(true);
  });
  it("reconstructs watchdog grace from creation time without extending it", async () => {
    const watchdog = { id: "watchdog", companyId: "company", issueId: "issue", watchdogAgentId: "agent", status: "active",
      lastReviewedFingerprint: null, lastReviewedStopSnapshot: null };
    const subtree = [{ watchdogId: "watchdog", id: "issue", companyId: "company", status: "in_progress", createdAt: new Date(now), updatedAt: new Date(now),
      originKind: "manual", parentId: null, assigneeAgentId: "agent", assigneeUserId: null, subtreeIncomplete: false }];
    const reader = { select: () => {
      let table = "";
      const rows = () => table === "issue_watchdogs" ? [watchdog] : [];
      const query = { from: (source: Parameters<typeof getTableName>[0]) => { table = getTableName(source); return query; },
        innerJoin: () => query, where: () => query, groupBy: () => query, orderBy: () => query,
        limit: async () => rows(), then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(rows()).then(resolve) };
      return query;
    }, execute: async () => subtree } as unknown as Pick<Db, "select" | "execute">;
    const service = taskWatchdogService(reader as Db);
    expect(await service.readIdleSchedule(reader, now, owner)).toMatchObject({ blocked: false, deadlines: [now + 15_000] });
    expect(await service.readIdleSchedule(reader, now + 1000, owner)).toMatchObject({ blocked: false, deadlines: [now + 15_000] });
    expect((await service.readIdleSchedule(reader, now + 15_000, owner)).blocked).toBe(true);
  });
  it("keeps first-run grace scoped to the run and issue company across batched watchdogs", async () => {
    const watchdogs = ["A", "B"].map(key => ({ id: `watchdog${key}`, companyId: `company${key}`,
      issueId: `issue${key}`, watchdogAgentId: `agent${key}`, status: "active",
      lastReviewedFingerprint: null, lastReviewedStopSnapshot: null }));
    const subtree = watchdogs.map(row => ({ watchdogId: row.id, id: row.issueId, companyId: row.companyId,
      status: "in_progress", createdAt: new Date(now), updatedAt: new Date(now), originKind: "manual",
      parentId: null, assigneeAgentId: row.watchdogAgentId, assigneeUserId: null, subtreeIncomplete: false }));
    const reader = { select: (fields?: Record<string, unknown>) => {
      let table = "";
      const rows = () => table === "issue_watchdogs" ? watchdogs : table === "heartbeat_runs"
        && fields?.contextSnapshot && !fields.status
        ? [{ companyId: "companyA", contextSnapshot: { issueId: "issueB" } }] : [];
      const query = { from: (source: Parameters<typeof getTableName>[0]) => { table = getTableName(source); return query; },
        innerJoin: () => query, where: () => query, groupBy: () => query, orderBy: () => query,
        limit: async () => rows(), then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(rows()).then(resolve) };
      return query;
    }, execute: async () => subtree } as unknown as Pick<Db, "select" | "execute">;
    const result = await taskWatchdogService(reader as Db).readIdleSchedule(reader, now, owner);
    expect(result.blocked).toBe(false);
    expect(result.deadlines).toEqual([now + 15_000, now + 15_000]);
  });
  it("does not certify a first producer during drain, failed reconstruction, or a changed revision", async () => {
    let revision = "1";
    const read = () => ({ revision, reconciled: true });
    expect((await readIdleRetrySchedule(tx([]), now, () => ({ revision, reconciled: false }))).blocked).toBe(true);
    expect((await readIdleRetrySchedule(tx([], () => { revision = "2"; }), now, read)).blocked).toBe(true);
    const bound = bindIdleDeadlineOwner(read, readIdleRetrySchedule);
    const inspection = await bound(tx([]), now, () => {});
    expect(inspection.current()).toBe(true);
    revision = "3";
    expect(inspection.current()).toBe(false);
  });
  it("preserves quota source/current target and rejects native, missing, due or claimed recovery", async () => {
    const row = quota();
    expect(await readIdleQuotaSchedule(tx([row]), now, owner)).toMatchObject({ blocked: false,
      deadlines: [now + 600_000], issueWaits: [{ kind: "provider_quota", issueId: "issue" }] });
    for (const patch of [{ companyId: "foreign" }, { agentId: "foreign" }, { runtimeMode: "native" },
      { status: "running" }, { costAccountingPending: true }, { contextSnapshot: { issueId: "foreign" } }]) {
      expect((await readIdleQuotaSchedule(tx([{ ...quota(), source: { ...row.source, ...patch } }]), now, owner)).blocked).toBe(true);
    }
    for (const patch of [{ executionState: {} }, { executionState: { status: "pending" } }, { executionState: { status: "mystery" } }, { status: "blocked" }, { monitorNextCheckAt: new Date(now) }, { monitorWakeRequestedAt: new Date(now) }]) {
      expect((await readIdleQuotaSchedule(tx([{ ...quota(), issue: { ...row.issue, ...patch } }]), now, owner)).blocked).toBe(true);
    }
  });
});
