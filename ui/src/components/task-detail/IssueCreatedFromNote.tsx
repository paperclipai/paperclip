import { t, useTranslation, Trans } from "@/i18n";
import type { IssueCreationSource } from "@paperclipai/shared";
import { GitBranch } from "lucide-react";
import {
  createIssueDetailPath,
  rememberIssueDetailLocationState,
} from "@/lib/issueDetailBreadcrumb";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";

export interface IssueCreatedFromNoteProps {
  /** Access-checked creation provenance from the issue detail response. */
  createdFrom: IssueCreationSource | null | undefined;
  issueLinkState?: unknown;
  className?: string;
}

/**
 * "Created from PAP-168 by Paperclip QA": the task a run was executing when it
 * created this one. Provenance only; it is not the structural parent and it is
 * not a blocker. Renders nothing when the viewer may not see the source.
 */
export function IssueCreatedFromNote({ createdFrom, issueLinkState, className }: IssueCreatedFromNoteProps) {
  useTranslation("task-components");
  if (!createdFrom) return null;
  const { issue, agent } = createdFrom;
  const ref = issue.identifier ?? issue.id;
  return (
    <p
      data-testid="issue-created-from"
      className={cn("flex min-w-0 items-center gap-1 text-xs text-muted-foreground", className)}
    >
      <GitBranch aria-hidden className="h-3 w-3 shrink-0" />
      <span className="shrink-0">{t("task-components:createdFrom_afe7b2f5")}</span>
      <Link
        to={createIssueDetailPath(ref)}
        state={issueLinkState}
        onClickCapture={() => rememberIssueDetailLocationState(ref, issueLinkState)}
        className="min-w-0 truncate hover:text-foreground transition-colors"
        title={issue.title}
      >
        {issue.identifier ? `${issue.identifier} ${issue.title}` : issue.title}
      </Link>
      {agent && <span className="shrink-0"><Trans ns="task-components" i18nKey="sentence_6835b5d423fc" components={{ part1: <>{agent.name}</> }} /></span>}
    </p>
  );
}
