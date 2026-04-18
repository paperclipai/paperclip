import type { ReactNode } from "react";
import type { Issue } from "@paperclipai/shared";
import { Archive } from "lucide-react";
import { Link } from "@/lib/router";
import { createIssueDetailPath, rememberIssueDetailLocationState } from "../lib/issueDetailBreadcrumb";
import { cn } from "../lib/utils";
import { InboxRowActionButton } from "./InboxRowActionButton";
import { InboxUnreadIndicator } from "./InboxUnreadIndicator";
import { StatusIcon } from "./StatusIcon";

type UnreadState = "hidden" | "visible" | "fading";

interface IssueRowProps {
  issue: Issue;
  issueLinkState?: unknown;
  selected?: boolean;
  mobileLeading?: ReactNode;
  desktopMetaLeading?: ReactNode;
  desktopLeadingSpacer?: boolean;
  mobileMeta?: ReactNode;
  desktopTrailing?: ReactNode;
  trailingMeta?: ReactNode;
  titleSuffix?: ReactNode;
  unreadState?: UnreadState | null;
  onArchive?: () => void;
  archiveDisabled?: boolean;
  className?: string;
}

export function IssueRow({
  issue,
  issueLinkState,
  selected = false,
  mobileLeading,
  desktopMetaLeading,
  desktopLeadingSpacer = false,
  mobileMeta,
  desktopTrailing,
  trailingMeta,
  titleSuffix,
  unreadState = null,
  onArchive,
  archiveDisabled,
  className,
}: IssueRowProps) {
  const issuePathId = issue.identifier ?? issue.id;
  const identifier = issue.identifier ?? issue.id.slice(0, 8);
  const showUnreadSlot = unreadState !== null;
  const selectedStatusClass = selected ? "!text-muted-foreground !border-muted-foreground" : undefined;

  return (
    <Link
      to={createIssueDetailPath(issuePathId)}
      state={issueLinkState}
      data-inbox-issue-link
      onClickCapture={() => rememberIssueDetailLocationState(issuePathId, issueLinkState)}
      className={cn(
        "group flex items-start gap-2 border-b border-border py-2.5 pl-2 pr-3 text-sm no-underline text-inherit transition-colors last:border-b-0 sm:items-center sm:py-2 sm:pl-1",
        selected ? "hover:bg-transparent" : "hover:bg-accent/50",
        className,
      )}
    >
      <span className="shrink-0 pt-px sm:hidden">
        {mobileLeading ?? <StatusIcon status={issue.status} className={selectedStatusClass} />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1 sm:contents">
        <span className="line-clamp-2 text-sm sm:order-2 sm:min-w-0 sm:flex-1 sm:truncate sm:line-clamp-none">
          {issue.title}{titleSuffix}
        </span>
        <span className="flex items-center gap-2 sm:order-1 sm:shrink-0">
          {desktopLeadingSpacer ? (
            <span className="hidden w-3.5 shrink-0 sm:block" />
          ) : null}
          {desktopMetaLeading ?? (
            <>
              <span className="hidden shrink-0 sm:inline-flex">
                <StatusIcon status={issue.status} className={selectedStatusClass} />
              </span>
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                {identifier}
              </span>
            </>
          )}
          {mobileMeta ? (
            <>
              <span className="text-xs text-muted-foreground sm:hidden" aria-hidden="true">
                &middot;
              </span>
              <span className="text-xs text-muted-foreground sm:hidden">{mobileMeta}</span>
            </>
          ) : null}
        </span>
      </span>
      {(desktopTrailing || trailingMeta) ? (
        <span className="ml-auto hidden shrink-0 items-center gap-2 sm:order-3 sm:flex sm:gap-3">
          {desktopTrailing}
          {trailingMeta ? (
            <span className="text-xs text-muted-foreground">{trailingMeta}</span>
          ) : null}
        </span>
      ) : null}
      {showUnreadSlot ? (
        <InboxUnreadIndicator state={unreadState} selected={selected} />
      ) : null}
      {onArchive ? (
        <InboxRowActionButton
          label="Archive"
          icon={<Archive className="h-3.5 w-3.5" />}
          disabled={archiveDisabled}
          selected={selected}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onArchive();
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            onArchive();
          }}
        />
      ) : null}
    </Link>
  );
}
