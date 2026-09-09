import type { IssueExecutionPolicy, IssueThreadInteractionContinuationPolicy } from "@paperclipai/shared";
import { normalizeIssueExecutionPolicy } from "./issue-execution-policy.js";

/**
 * A pending `wake_assignee` interaction is only *reachable* — the board can answer
 * it at any time — but nothing guarantees it is ever *reached*. Without a scheduled
 * issue monitor the card ages silently: no timer wakes the assignee, so a gate that
 * the board never notices has unbounded latency.
 *
 * Agents are told to arm a monitor in the same breath as the gate, but that rule is
 * only documentation. This module makes the floor server-owned: when an agent parks
 * work behind a wake-on-response interaction, the issue gets a default monitor unless
 * one is already armed.
 */
export const INTERACTION_WAIT_MONITOR_SERVICE_NAME = "pending issue interaction";

export const DEFAULT_INTERACTION_WAIT_MONITOR_INTERVAL_MS = 72 * 60 * 60 * 1000;
export const DEFAULT_INTERACTION_WAIT_MONITOR_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_INTERACTION_WAIT_MONITOR_MAX_ATTEMPTS = 8;

const WAKE_ON_RESPONSE_POLICIES: ReadonlySet<string> = new Set<IssueThreadInteractionContinuationPolicy>([
  "wake_assignee",
  "wake_assignee_on_accept",
]);

type MonitorIssueLike = {
  status: string;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  monitorNextCheckAt?: Date | null;
  executionPolicy?: IssueExecutionPolicy | Record<string, unknown> | null;
};

type MonitorInteractionLike = {
  id: string;
  kind: string;
  continuationPolicy: string;
};

export function isWakeOnResponseContinuationPolicy(policy: string | null | undefined) {
  return typeof policy === "string" && WAKE_ON_RESPONSE_POLICIES.has(policy);
}

/**
 * Mirrors the monitor eligibility the scheduler enforces at tick time: a stored
 * `monitorNextCheckAt` only ever fires for an agent-assigned issue with no user
 * assignee that sits in `in_progress` or `in_review`. Arming outside that window
 * would write a timestamp the tick refuses to act on.
 */
function issueCanCarryMonitor(issue: MonitorIssueLike) {
  if (!issue.assigneeAgentId) return false;
  if (issue.assigneeUserId) return false;
  return issue.status === "in_progress" || issue.status === "in_review";
}

function hasArmedMonitor(issue: MonitorIssueLike, policy: IssueExecutionPolicy | null) {
  if (issue.monitorNextCheckAt) return true;
  return Boolean(policy?.monitor?.nextCheckAt);
}

/**
 * Builds the execution policy that arms the default wait monitor for a freshly
 * created interaction, or `null` when the issue needs no server-side floor:
 * the interaction does not wake anyone, the issue cannot carry a monitor, or the
 * agent already armed one itself.
 */
export function buildInteractionWaitMonitorPolicy(input: {
  issue: MonitorIssueLike;
  interaction: MonitorInteractionLike;
  now: Date;
  intervalMs?: number;
}): IssueExecutionPolicy | null {
  if (!isWakeOnResponseContinuationPolicy(input.interaction.continuationPolicy)) return null;
  if (!issueCanCarryMonitor(input.issue)) return null;

  const previousPolicy = normalizeIssueExecutionPolicy(input.issue.executionPolicy ?? null);
  if (hasArmedMonitor(input.issue, previousPolicy)) return null;

  const intervalMs = input.intervalMs ?? DEFAULT_INTERACTION_WAIT_MONITOR_INTERVAL_MS;
  const nextCheckAt = new Date(input.now.getTime() + intervalMs);
  const timeoutAt = new Date(input.now.getTime() + DEFAULT_INTERACTION_WAIT_MONITOR_TIMEOUT_MS);

  return {
    ...(previousPolicy ?? { mode: "normal" as const, commentRequired: true, stages: [] }),
    monitor: {
      nextCheckAt: nextCheckAt.toISOString(),
      // `externalRef` is redacted on normalize, so the interaction id has to live in
      // the notes to stay readable for whoever the monitor wakes.
      notes:
        `Default wait monitor for pending ${input.interaction.kind} interaction ${input.interaction.id}. `
        + "Re-check whether the interaction is still pending and still asks the right question; "
        + "re-arm the monitor in the same heartbeat if the wait continues.",
      scheduledBy: "assignee" as const,
      kind: "external_service" as const,
      serviceName: INTERACTION_WAIT_MONITOR_SERVICE_NAME,
      externalRef: null,
      timeoutAt: timeoutAt.toISOString(),
      maxAttempts: DEFAULT_INTERACTION_WAIT_MONITOR_MAX_ATTEMPTS,
      recoveryPolicy: "wake_owner" as const,
    },
  };
}
