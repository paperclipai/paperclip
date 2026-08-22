import { AlertTriangle } from "lucide-react";
import type { IssueAssigneeAttention } from "@paperclipai/shared";
import { Link } from "@/lib/router";

interface IssueAssigneeErrorNoticeProps {
  attention: IssueAssigneeAttention | null;
}

/**
 * Blocking execution notice for an active issue whose assigned agent is in
 * error status. The agent will not pick up new runs until an operator clears
 * the error or the issue is reassigned, so this surfaces that path directly
 * on the issue instead of hiding it on the agent page.
 */
export function IssueAssigneeErrorNotice({ attention }: IssueAssigneeErrorNoticeProps) {
  if (!attention || attention.state !== "agent_error") return null;

  const agentLabel = attention.agentName ?? "The assigned agent";

  return (
    <div
      data-testid="issue-assignee-error-notice"
      className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-foreground shadow-sm"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="leading-5">
            <span className="font-medium text-destructive">Execution blocked</span> —{" "}
            <Link
              to={`/agents/${attention.agentId}`}
              className="font-medium underline underline-offset-2"
              data-testid="issue-assignee-error-agent-link"
            >
              {agentLabel}
            </Link>{" "}
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
