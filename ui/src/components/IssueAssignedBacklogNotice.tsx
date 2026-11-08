import { t, useTranslation, Trans } from "@/i18n";
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
  useTranslation("task-components");
  if (issueStatus !== "backlog") return null;
  if (!assigneeAgent && !assigneeUserId) return null;

  const assigneeLabel = assigneeAgent?.name ?? t("task-components:theAssignee_f584ae3a");

  return (
    <div
      data-testid="issue-assigned-backlog-notice"
      data-issue-status={issueStatus}
      className="mb-3 rounded-md border border-amber-300/70 bg-amber-50/90 px-3 py-2.5 text-sm text-amber-950 shadow-sm dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100"
    >
      <div className="flex items-start gap-2">
        <Flag className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="leading-5"><Trans ns="task-components" i18nKey="sentence_384e9e25cf0e" components={{ part1: <>{<span className="font-medium">{t("task-components:parked_f32a2c33")}</span>}</>, part2: <>{<span className="font-medium">{assigneeLabel}</span>}</> }} /></p>
          {assigneeAgent ? (
            <p className="text-xs leading-5 text-amber-800 dark:text-amber-200">{t("task-components:commentsStillNotifyTheAssigneeForQuestions_e9afc815")}</p>
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
                {resuming ? t("task-components:resuming_c494e3ca") : t("task-components:resumeNow_6eddb459")}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
