import { createHash } from "node:crypto";

/** This contract deliberately has no narrative, liveness label or progress count. */
export interface LegacyContinuationInput {
  run: { id: string; companyId: string; agentId: string; status: string; runtimeMode?: string | null };
  issue: { id: string; companyId: string; status: string; assigneeAgentId: string | null; assigneeUserId?: string | null } | null;
  agent: { id: string; companyId: string; status: string } | null;
  episode: LegacyDispositionEpisode;
  gates: {
    stopped: boolean;
    paused: boolean;
    budgetBlocked: boolean;
    pendingWait: boolean;
    activeExecution: boolean;
    ownedLifecycle: boolean;
    conversation: boolean;
    agentInvokable: boolean;
  };
}
export interface LegacyDispositionEpisode {
  id: string;
  attempt: number;
  maxAttempts: number;
}
export const LEGACY_DISPOSITION_REPAIR_MAX_ATTEMPTS = 2;
export const LEGACY_DISPOSITION_REPAIR_INSTRUCTION =
  "The previous task run ended without a recorded disposition or an owned next execution path. " +
  "Re-read the current task state. If the original owner still has authorized unfinished work and no Stop, pause, budget, approval, dependency, pending interaction, or active execution gate applies, " +
  "PATCH /api/issues/{id} with status: todo, resume: true, and an explanatory comment. Confirm the returned status and queued successor run. " +
  "An agent-owned bounded_owner_disposition_repair action cannot use POST /api/issues/{id}/recovery-actions/resolve to retry. " +
  "That retry is for a board-owned board_escalation action and an authorized board actor. " +
  "Record a real blocker, pending question or approval, or still-valid monitor when waiting. A monitor cleared by max_attempts_exhausted cannot be reset to create another wake. " +
  "If no legal continuation or waiting path exists, let the bounded repair escalate to the board. " +
  "A final message alone does not record disposition.";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function count(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
export function legacyDispositionEpisode(run: {
  id: string;
  contextSnapshot?: unknown;
  continuationAttempt?: number | null;
}): LegacyDispositionEpisode {
  const context = record(run.contextSnapshot);
  const episode = record(context.legacyDispositionEpisode);
  if (typeof episode.id === "string" && episode.id) {
    return { id: episode.id, attempt: count(episode.attempt), maxAttempts: Math.max(1, Math.min(LEGACY_DISPOSITION_REPAIR_MAX_ATTEMPTS, count(episode.maxAttempts) || LEGACY_DISPOSITION_REPAIR_MAX_ATTEMPTS)) };
  }
  // Pre-upgrade repairs have already consumed their old (possibly tighter)
  // allowance. A classifier/key migration must not grant them a fresh budget.
  const handoff = context.wakeReason === "finish_successful_run_handoff" || context.handoffRequired === true;
  const oldRecovery = context.source === "issue.productive_terminal_continuation_recovery";
  const attempt = Math.max(count(run.continuationAttempt), count(context.livenessContinuationAttempt), count(context.dispositionRepairAttempt), handoff ? count(context.handoffAttempt) || 1 : 0, oldRecovery ? 1 : 0);
  return {
    id: typeof context.dispositionRepairFingerprint === "string" ? context.dispositionRepairFingerprint : typeof context.livenessContinuationSourceRunId === "string" ? context.livenessContinuationSourceRunId : run.id,
    attempt,
    maxAttempts: handoff || oldRecovery ? 1 : LEGACY_DISPOSITION_REPAIR_MAX_ATTEMPTS,
  };
}
export function legacyDispositionFingerprint(companyId: string, issueId: string, agentId: string, episodeId: string) {
  return `legacy_disposition:v1:${createHash("sha256").update(JSON.stringify([companyId, issueId, agentId, episodeId])).digest("hex")}`;
}
export function decideLegacyContinuation(input: LegacyContinuationInput):
  | { kind: "skip"; reason: string }
  | { kind: "exhausted"; attempt: number; maxAttempts: number }
  | { kind: "enqueue"; nextAttempt: number; idempotencyKey: string; instruction: string } {
  const { run, issue, agent, gates, episode } = input;
  if (run.runtimeMode === "native") return { kind: "skip", reason: "native_finalization" };
  if (run.status !== "succeeded") return { kind: "skip", reason: "run_not_successful" };
  if (!issue || !agent || issue.companyId !== run.companyId || agent.companyId !== run.companyId || agent.id !== run.agentId) return { kind: "skip", reason: "invalid_binding" };
  if (issue.assigneeAgentId !== run.agentId || issue.assigneeUserId) return { kind: "skip", reason: "owner_changed" };
  if (!["todo", "in_progress"].includes(issue.status)) return { kind: "skip", reason: "recorded_disposition" };
  for (const [blocked, reason] of [
    [gates.stopped, "stopped"], [gates.paused, "paused"],
    [gates.budgetBlocked, "budget_blocked"], [gates.pendingWait, "durable_wait"],
    [gates.activeExecution, "existing_execution"], [gates.ownedLifecycle, "owned_lifecycle"],
    [gates.conversation, "conversation"],
    [!gates.agentInvokable || ["paused", "terminated", "pending_approval"].includes(agent.status), "agent_not_invokable"],
  ] as const) if (blocked) return { kind: "skip", reason };
  if (episode.attempt >= episode.maxAttempts) return { kind: "exhausted", attempt: episode.attempt, maxAttempts: episode.maxAttempts };
  const nextAttempt = episode.attempt + 1;
  return {
    kind: "enqueue", nextAttempt,
    idempotencyKey: `issue_disposition_repair:${issue.id}:${legacyDispositionFingerprint(run.companyId, issue.id, run.agentId, episode.id)}:${nextAttempt}`,
    instruction: LEGACY_DISPOSITION_REPAIR_INSTRUCTION,
  };
}
