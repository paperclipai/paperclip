import { AlertTriangle, PauseCircle } from "lucide-react";
import type { IssueAssigneeAttention } from "@paperclipai/shared";
import { Link } from "@/lib/router";

interface IssueAssigneeAttentionNoticeProps {
  attention: IssueAssigneeAttention | null;
}

/**
 * Execution notice for an active issue whose assigned agent is dormant.
 * `agent_error` is a fault: destructive severity, cleared by an operator or a
 * later successful run. `agent_paused` is a deliberate stop: warning severity,
 * because the issue still cannot execute until the agent is resumed or the
 * issue is reassigned. Both surface the remedy on the issue instead of hiding
 * it on the agent page.
 */
export function IssueAssigneeAttentionNotice({ attention }: IssueAssigneeAttentionNoticeProps) {
  if (!attention) return null;

  const agentLabel = attention.agentName ?? "The assigned agent";
  const agentLink = (
    <Link
      to={`/agents/${attention.agentId}`}
      className="font-medium underline underline-offset-2"
      data-testid="issue-assignee-attention-agent-link"
    >
      {agentLabel}
    </Link>
  );

  if (attention.state === "agent_error") {
    return (
      <div
        data-testid="issue-assignee-error-notice"
        className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-foreground shadow-sm"
      >
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
          <div className="min-w-0 flex-1 space-y-1.5">
            <p className="leading-5">
              <span className="font-medium text-destructive">Execution blocked</span> — {agentLink}{" "}
              is in error status and will not be woken to work on this issue.
            </p>
            {attention.errorReasonExcerpt ? (
              <p className="text-xs leading-5 text-muted-foreground" data-testid="issue-assignee-error-reason">
                {attention.errorReasonExcerpt}
              </p>
            ) : null}
            <p className="text-xs leading-5 text-muted-foreground">
              Use <span className="font-medium">Clear error</span> on the agent page to return the agent to idle,
              or reassign this issue to another owner. The issue status itself is unchanged.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="issue-assignee-paused-notice"
      className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm text-foreground shadow-sm"
    >
      <div className="flex items-start gap-2">
        <PauseCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="leading-5">
            <span className="font-medium text-amber-700 dark:text-amber-300">Execution paused</span> — {agentLink}{" "}
            is paused and will not be woken to work on this issue.
          </p>
          {attention.pauseReasonExcerpt ? (
            <p className="text-xs leading-5 text-muted-foreground" data-testid="issue-assignee-paused-reason">
              Pause reason: {attention.pauseReasonExcerpt}
            </p>
          ) : null}
          <p className="text-xs leading-5 text-muted-foreground">
            The pause is deliberate, so it is not undone automatically. When it no longer applies,{" "}
            <span className="font-medium">Resume</span> the agent on its page, or reassign this issue to another
            owner. The issue status itself is unchanged.
          </p>
        </div>
      </div>
    </div>
  );
}
