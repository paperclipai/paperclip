import { Flag } from "lucide-react";
import type { Agent } from "@valadrien-os/shared";
import { Button } from "@/components/ui/button";

interface IssueAssignedBacklogNoticeProps {
  issueStatus: string;
  assigneeAgent: Agent | null;
  assigneeUserId?: string | null;
  onResume?: () => void;
  resuming?: boolean;
}

export function IssueAssignedBacklogNotice({
  issueStatus,
  assigneeAgent,
  assigneeUserId,
  onResume,
  resuming,
}: IssueAssignedBacklogNoticeProps) {
  if (issueStatus !== "backlog") return null;
  if (!assigneeAgent && !assigneeUserId) return null;

  const assigneeLabel = assigneeAgent?.name ?? "the assignee";

  return (
    <div
      data-testid="issue-assigned-backlog-notice"
      data-issue-status={issueStatus}
      className="mb-3 rounded-md border border-status-warning/30 bg-status-warning/12 px-3 py-2.5 text-sm text-status-warning"
    >
      <div className="flex items-start gap-2">
        <Flag className="mt-0.5 h-4 w-4 shrink-0 text-status-warning" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="leading-5">
            <span className="font-medium">Parked</span> —{" "}
            <span className="font-medium">{assigneeLabel}</span> will not be woken until status changes to{" "}
            <code className="rounded bg-status-warning/15 px-1 py-0.5 text-[12px]">todo</code> or{" "}
            <code className="rounded bg-status-warning/15 px-1 py-0.5 text-[12px]">in_progress</code>.
          </p>
          {assigneeAgent ? (
            <p className="text-xs leading-5 text-status-warning/85">
              Comments still wake the assignee for questions or triage. Leave this parked only if the work is intentionally on hold.
            </p>
          ) : null}
          {onResume ? (
            <div className="pt-0.5">
              <Button
                size="sm"
                variant="outline"
                className="h-7 border-status-warning/40 bg-background/80 text-status-warning hover:bg-status-warning/12 dark:bg-background/40"
                onClick={onResume}
                disabled={resuming}
                data-testid="issue-assigned-backlog-resume"
              >
                {resuming ? "Resuming…" : "Resume now"}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
