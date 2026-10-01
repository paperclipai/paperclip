import type { ExecutionProjection, IssueRecoveryAction } from "@paperclipai/shared";
import type { IssueChatComment } from "@/lib/issue-chat-messages";
import { isTerminalIssueStatus } from "@/lib/liveIssueIds";
import type { TaskChatItem } from "./task-chat-model";

interface StatusRun {
  id: string;
  agentId: string;
  status: string;
  errorCode?: string | null;
  createdAt: Date | string;
  startedAt?: Date | string | null;
  execution?: ExecutionProjection | null;
  resultJson?: Record<string, unknown> | null;
}

function timestamp(value: Date | string | null | undefined): number {
  return value == null ? NaN : new Date(value).getTime();
}

function isAdmissionWait(run: StatusRun): boolean {
  return run.status === "cancelled" && !run.startedAt
    && ["execution_reconciliation_required", "workspace_busy", "issue_not_in_progress", "issue_terminal_status"].includes(run.errorCode ?? "");
}

/** Presentation only: retain every run and comment in the underlying history. */
export function taskChatStatusRelevance(
  issueStatus: string | null | undefined,
  runs: readonly StatusRun[],
  recoveryAction?: Pick<IssueRecoveryAction, "id" | "status"> | null,
) {
  const terminal = isTerminalIssueStatus(issueStatus);
  const byId = new Map<string, StatusRun>();
  for (const run of runs) {
    const previous = byId.get(run.id);
    byId.set(run.id, { ...previous, ...run, execution: run.execution ?? previous?.execution });
  }
  const latestByAgent = new Map<string, number>();
  const latestAttemptByAgent = new Map<string, number>();
  let latestStart = -Infinity;
  for (const run of byId.values()) {
    // Admission order, not finish order: an old attempt can finish late.
    const createdAt = timestamp(run.createdAt);
    const order = Number.isFinite(createdAt) ? createdAt : timestamp(run.startedAt);
    if (Number.isFinite(order)) {
      latestByAgent.set(run.agentId, Math.max(latestByAgent.get(run.agentId) ?? -Infinity, order));
      if (!isAdmissionWait(run)) {
        latestAttemptByAgent.set(run.agentId, Math.max(latestAttemptByAgent.get(run.agentId) ?? -Infinity, order));
      }
    }
    const startedAt = timestamp(run.startedAt);
    if (Number.isFinite(startedAt)) latestStart = Math.max(latestStart, startedAt);
  }

  const isHistoricalRun = (runId: string): boolean => {
    if (terminal) return true;
    const run = byId.get(runId);
    if (!run) return false;
    if (run.execution?.successorRunId || run.execution?.phase === "completed") return true;
    const wait = run.resultJson?.executionWait;
    if (recoveryAction && wait && typeof wait === "object" && "recoveryActionId" in wait
      && wait.recoveryActionId === recoveryAction.id) {
      return recoveryAction.status === "resolved" || recoveryAction.status === "cancelled";
    }
    // A newer admission attempt does not resolve an explicit execution hold.
    if (run.execution?.phase === "recovery_needed") return false;
    const createdAt = timestamp(run.createdAt);
    const order = Number.isFinite(createdAt) ? createdAt : timestamp(run.startedAt);
    const latest = isAdmissionWait(run) ? latestByAgent : latestAttemptByAgent;
    return order < (latest.get(run.agentId) ?? -Infinity);
  };

  const isHistoricalNotice = (comment: IssueChatComment): boolean => {
    // Session resets are durable conversation boundaries, not execution status.
    if (comment.conversationSessionGeneration != null) return false;
    if (comment.authorType !== "system" && comment.presentation?.kind !== "system_notice") return false;
    if (terminal) return true;
    if (comment.metadata?.recovery?.actionId === recoveryAction?.id && recoveryAction) {
      return recoveryAction.status === "resolved" || recoveryAction.status === "cancelled";
    }
    const sourceRunId = comment.metadata?.sourceRunId ?? comment.createdByRunId
      ?? comment.runId ?? comment.derivedCreatedByRunId;
    if (sourceRunId) return isHistoricalRun(sourceRunId);
    if (recoveryAction?.status === "active" || recoveryAction?.status === "escalated") return false;
    // Older notices without run provenance are superseded only by actual work,
    // never by a new human comment or the passage of time.
    return timestamp(comment.createdAt) < latestStart;
  };

  return { isHistoricalRun, isHistoricalNotice };
}

/** Remove obsolete lifecycle diagnostics, preserving responses, tools and inputs. */
export function withoutHistoricalRunStatus(items: readonly TaskChatItem[]): TaskChatItem[] {
  return items.filter((item) => {
    if (item.kind === "marker" || item.kind === "status") return false;
    if (item.kind === "message") return item.author !== "system";
    if (item.kind !== "protocol") return true;
    if (item.surface === "run_terminal" || item.surface === "run_result") return false;
    return item.surface !== "provider_activity"
      || !["terminal", "wait", "provider_notice"].includes(item.family);
  });
}
