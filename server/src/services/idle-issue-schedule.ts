import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { AGENT_STATUSES, issueExecutionMonitorPolicySchema, PROVIDER_QUOTA_MONITOR_SERVICE_NAME } from "@paperclipai/shared";
import type { ScheduledWake } from "./idle-scheduled-work.js";
import { onboardingFirstTaskAwaitingUserSql } from "./recovery/onboarding-first-task-wait.js";

const processGeneration = randomUUID();
const limit = 10_000;
const statuses = new Set(["backlog", "todo", "in_progress", "in_review", "blocked"]);
const agentStatuses = new Set<string>(AGENT_STATUSES);
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

export async function readIdleIssueSchedule(tx: Pick<Db, "execute">, ownerId: string, now: number): Promise<{
  blocked: boolean;
  scheduledWake?: ScheduledWake;
}> {
  const rows = await tx.execute<{
    id: string; company_id: string; status: string; updated_at: Date | string;
    assignee_agent_id: string | null; assignee_user_id: string | null;
    checkout_run_id: string | null; execution_run_id: string | null;
    execution_policy: unknown; execution_state: unknown; unblock_descriptor: unknown;
    conversation_agent_id: string | null; monitor_next_check_at: Date | string | null;
    monitor_wake_requested_at: Date | string | null; monitor_attempt_count: number;
    company_status: string; company_updated: Date | string; agent_status: string | null;
    agent_updated: Date | string | null; scoped: boolean; unsafe_dependencies: boolean; dependency_ready: boolean;
    untouched_onboarding: boolean;
  }>(sql`SELECT i.id, i.company_id, i.status, i.updated_at, i.assignee_agent_id, i.assignee_user_id,
      i.checkout_run_id, i.execution_run_id, i.execution_policy, i.execution_state, i.unblock_descriptor,
      i.conversation_agent_id, i.monitor_next_check_at, i.monitor_wake_requested_at, i.monitor_attempt_count,
      c.status AS company_status, c.updated_at AS company_updated,
      a.status AS agent_status, a.updated_at AS agent_updated,
      (i.assignee_agent_id IS NULL OR a.id IS NOT NULL) AS scoped,
      (${onboardingFirstTaskAwaitingUserSql(sql`i.company_id`, sql`i.id`, sql`i.origin_kind`)}
        AND NOT EXISTS (SELECT 1 FROM heartbeat_runs h WHERE h.company_id = i.company_id
          AND (h.context_snapshot ->> 'issueId' = i.id::text OR h.context_snapshot ->> 'taskId' = i.id::text))) AS untouched_onboarding,
      EXISTS (SELECT 1 FROM issue_relations r LEFT JOIN issues b ON b.id = r.issue_id
        WHERE r.related_issue_id = i.id AND (r.company_id <> i.company_id OR b.company_id <> i.company_id
          OR b.id IS NULL OR r.type <> 'blocks' OR b.status NOT IN ('backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'))) AS unsafe_dependencies,
      (EXISTS (SELECT 1 FROM issue_relations r WHERE r.related_issue_id = i.id AND r.type = 'blocks')
        AND NOT EXISTS (SELECT 1 FROM issue_relations r JOIN issues b ON b.id = r.issue_id
          WHERE r.related_issue_id = i.id AND r.type = 'blocks' AND b.status <> 'done')) AS dependency_ready
    FROM issues i JOIN companies c ON c.id = i.company_id
    LEFT JOIN agents a ON a.id = i.assignee_agent_id AND a.company_id = i.company_id
    WHERE i.status NOT IN ('done', 'cancelled') ORDER BY i.id LIMIT ${limit + 1}`);
  if (rows.length > limit) return { blocked: true };
  let earliest = Infinity;
  for (const row of rows) {
    const policy = record(row.execution_policy);
    const state = record(row.execution_state);
    if (!statuses.has(row.status) || row.company_status !== "active" || row.scoped !== true
      || (row.assignee_agent_id && !agentStatuses.has(row.agent_status ?? ""))
      || row.unsafe_dependencies !== false || row.checkout_run_id || row.execution_run_id
      || row.conversation_agent_id || row.monitor_wake_requested_at
      || (row.execution_state !== null && state?.status !== "idle")
      || (row.execution_policy !== null && !policy)) return { blocked: true };
    if (row.status === "blocked" && row.dependency_ready) return { blocked: true };
    if (row.monitor_next_check_at !== null) {
      const monitor = issueExecutionMonitorPolicySchema.safeParse(policy?.monitor);
      const at = new Date(row.monitor_next_check_at).getTime();
      if (!monitor.success || !row.assignee_agent_id || row.assignee_user_id
        || !["in_progress", "in_review"].includes(row.status)
        || !["idle", "active", "error"].includes(row.agent_status ?? "")
        || !Number.isFinite(at) || at <= now || Date.parse(monitor.data.nextCheckAt) !== at
        || monitor.data.serviceName === PROVIDER_QUOTA_MONITOR_SERVICE_NAME
        || !Number.isSafeInteger(row.monitor_attempt_count) || row.monitor_attempt_count < 0
        || (monitor.data.timeoutAt && Date.parse(monitor.data.timeoutAt) <= at)
        || (monitor.data.maxAttempts !== null && row.monitor_attempt_count >= monitor.data.maxAttempts)) return { blocked: true };
      earliest = Math.min(earliest, at);
      continue;
    }
    if (policy?.monitor != null) return { blocked: true };
    const unblock = record(row.unblock_descriptor);
    const passive = row.status === "backlog"
      || (row.status === "todo" && !row.assignee_agent_id)
      || (row.status === "todo" && row.assignee_agent_id && row.agent_status === "idle" && row.untouched_onboarding === true)
      || (row.status === "blocked" && (row.unblock_descriptor === null || unblock?.owner === "board"))
      || Boolean(row.assignee_user_id && !row.assignee_agent_id);
    if (!passive) return { blocked: true };
  }
  if (!Number.isFinite(earliest)) return { blocked: false };
  return { blocked: false, scheduledWake: { version: 1, kind: "routines_and_issue_monitors",
    generation: createHash("sha256").update(JSON.stringify([processGeneration, ownerId, rows])).digest("hex"),
    nextWakeAt: new Date(earliest).toISOString() } };
}

export function combineIdleSchedules(routine?: ScheduledWake, issue?: ScheduledWake): ScheduledWake | undefined {
  if (!issue) return routine;
  if (!routine) return issue;
  return { version: 1, kind: "routines_and_issue_monitors",
    generation: createHash("sha256").update(JSON.stringify([routine, issue])).digest("hex"),
    nextWakeAt: new Date(Math.min(Date.parse(routine.nextWakeAt), Date.parse(issue.nextWakeAt))).toISOString() };
}
