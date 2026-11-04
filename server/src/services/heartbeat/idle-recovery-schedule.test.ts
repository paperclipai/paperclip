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
function tx(rows: unknown[], onRead: () => void = () => {}) {
  const query = { from: () => query, leftJoin: () => query, where: () => query, orderBy: () => query,
    limit: async () => { onRead(); return rows; } };
  return { select: () => query } as unknown as Pick<Db, "select" | "execute">;
}
function retry() {
  return { run: { id: "retry", companyId: "company", agentId: "agent", wakeupRequestId: "wake", status: "scheduled_retry",
    scheduledRetryAt: new Date(now + 600_000), startedAt: null, finishedAt: null, costAccountingPending: false, resultJson: null },
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
    const subtree = [{ id: "issue", companyId: "company", status: "in_progress", createdAt: new Date(now), updatedAt: new Date(now),
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
