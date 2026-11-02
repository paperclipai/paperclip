import { useTranslation } from "@/i18n";
import { Trans } from "react-i18next";
import { Flag } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
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
  const { t } = useTranslation();
  if (issueStatus !== "backlog") return null;
  if (!assigneeAgent && !assigneeUserId) return null;

  const assigneeLabel = assigneeAgent?.name ?? t("localizationIssueChrome.assignee");

  return (
    <div
      data-testid="issue-assigned-backlog-notice"
      data-issue-status={issueStatus}
      className="mb-3 rounded-md border border-amber-300/70 bg-amber-50/90 px-3 py-2.5 text-sm text-amber-950 shadow-sm dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100"
    >
      <div className="flex items-start gap-2">
        <Flag className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="leading-5">
            <Trans i18nKey="localizationIssueChrome.parkedDescription" values={{ assignee: assigneeLabel }} components={{ parked: <span className="font-medium" />, assignee: <span className="font-medium" /> }} />
          </p>
          {assigneeAgent ? (
            <p className="text-xs leading-5 text-amber-800 dark:text-amber-200">
              {t("localizationIssueChrome.parkedCommentHint")}
            </p>
          ) : null}
          {onResume ? (
            <div className="pt-0.5">
              <Button
                size="sm"
                variant="outline"
                className="h-7 border-amber-400/70 bg-background/80 text-amber-950 hover:bg-amber-100 dark:border-amber-500/40 dark:bg-background/40 dark:text-amber-100 dark:hover:bg-amber-500/15"
                onClick={onResume}
                disabled={resuming}
                data-testid="issue-assigned-backlog-resume"
              >
                {resuming ? t("localizationIssueChrome.resuming") : t("localizationIssueChrome.resumeNow")}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
