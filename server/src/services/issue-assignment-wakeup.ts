import { logger } from "../middleware/logger.js";

type WakeupTriggerDetail = "manual" | "ping" | "callback" | "system";
type WakeupSource = "timer" | "assignment" | "on_demand" | "automation";

export interface IssueAssignmentWakeupDeps {
  wakeup: (
    agentId: string,
    opts: {
      source?: WakeupSource;
      triggerDetail?: WakeupTriggerDetail;
      reason?: string | null;
      payload?: Record<string, unknown> | null;
      requestedByActorType?: "user" | "agent" | "system";
      requestedByActorId?: string | null;
      contextSnapshot?: Record<string, unknown>;
    },
  ) => Promise<unknown>;
}

// Debounce window for assignment wakeups. Multiple assignments within this
// window (e.g. bulk sprint planning) collapse into a single heartbeat so the
// agent picks up its full assignment list in one run rather than N parallel
// runs.
const ASSIGNMENT_WAKEUP_DEBOUNCE_MS = 5_000;

interface PendingWakeup {
  timer: ReturnType<typeof setTimeout>;
  heartbeat: IssueAssignmentWakeupDeps;
  reason: string;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  issueIds: string[];
}

// Keyed by agentId.
const pendingWakeups = new Map<string, PendingWakeup>();

export function queueIssueAssignmentWakeup(input: {
  heartbeat: IssueAssignmentWakeupDeps;
  issue: { id: string; assigneeAgentId: string | null; status: string };
  reason: string;
  mutation: string;
  contextSource: string;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  rethrowOnError?: boolean;
}) {
  if (!input.issue.assigneeAgentId || input.issue.status === "backlog") return;

  const agentId = input.issue.assigneeAgentId;
  const existing = pendingWakeups.get(agentId);

  if (existing) {
    // Extend the debounce window and accumulate issue ids.
    clearTimeout(existing.timer);
    existing.issueIds.push(input.issue.id);
    existing.timer = setTimeout(() => fireWakeup(agentId), ASSIGNMENT_WAKEUP_DEBOUNCE_MS);
    return;
  }

  const pending: PendingWakeup = {
    timer: setTimeout(() => fireWakeup(agentId), ASSIGNMENT_WAKEUP_DEBOUNCE_MS),
    heartbeat: input.heartbeat,
    reason: input.reason,
    requestedByActorType: input.requestedByActorType,
    requestedByActorId: input.requestedByActorId ?? null,
    issueIds: [input.issue.id],
  };
  pendingWakeups.set(agentId, pending);
}

function fireWakeup(agentId: string) {
  const pending = pendingWakeups.get(agentId);
  if (!pending) return;
  pendingWakeups.delete(agentId);

  // Keep `issueId` (first in batch) for backwards compatibility with existing
  // payload ->> 'issueId' queries throughout the codebase.
  const primaryIssueId = pending.issueIds[0]!;
  pending.heartbeat
    .wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: pending.reason,
      payload: { issueId: primaryIssueId, issueIds: pending.issueIds },
      requestedByActorType: pending.requestedByActorType,
      requestedByActorId: pending.requestedByActorId ?? null,
      contextSnapshot: { issueId: primaryIssueId, issueIds: pending.issueIds, source: "issue-assignment-wakeup" },
    })
    .catch((err) => {
      logger.warn({ err, agentId, issueIds: pending.issueIds }, "failed to wake assignee on issue assignment");
    });
}
