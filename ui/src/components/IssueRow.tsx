import type { ReactNode } from "react";
import type { Issue } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { cn } from "../lib/utils";
import { PriorityIcon } from "./PriorityIcon";
import { StatusIcon } from "./StatusIcon";

type UnreadState = "hidden" | "visible" | "fading";

interface IssueRowProps {
  issue: Issue;
  issueLinkState?: unknown;
  statusControl?: ReactNode;
  mobileMeta?: ReactNode;
  trailingContent?: ReactNode;
  trailingMeta?: ReactNode;
  unreadState?: UnreadState | null;
  onMarkRead?: () => void;
  className?: string;
}

export function IssueRow({
  issue,
  issueLinkState,
  statusControl,
  mobileMeta,
  trailingContent,
  trailingMeta,
  unreadState = null,
  onMarkRead,
  className,
}: IssueRowProps) {
  const issuePathId = issue.identifier ?? issue.id;
  const identifier = issue.identifier ?? issue.id.slice(0, 8);
  const showUnreadSlot = unreadState !== null;
  const showUnreadDot = unreadState === "visible" || unreadState === "fading";

  return (
    <Link
      to={`/issues/${issuePathId}`}
      state={issueLinkState}
      className={cn(
        "flex min-w-0 cursor-pointer items-start gap-2 px-3 py-3 no-underline text-inherit transition-colors hover:bg-accent/50 sm:items-center sm:gap-3 sm:px-4",
        className,
      )}
    >
      <span className="hidden shrink-0 self-center sm:inline-flex">
        <PriorityIcon priority={issue.priority} />
      </span>
      <span className="inline-flex shrink-0 self-center">
        {statusControl ?? <StatusIcon status={issue.status} />}
      </span>
      <span className="hidden shrink-0 self-center text-xs font-mono text-muted-foreground sm:inline">
        {identifier}
      </span>
      <span className="min-w-0 flex-1 text-sm">
        <span className="line-clamp-2 min-w-0 sm:line-clamp-1 sm:block sm:truncate">
          {issue.title}
        </span>
        <span className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground sm:hidden">
          <span className="font-mono">{identifier}</span>
          {mobileMeta ? (
            <>
              <span aria-hidden="true">&middot;</span>
              <span>{mobileMeta}</span>
            </>
          ) : null}
        </span>
      </span>
      {trailingContent ? (
        <span className="hidden shrink-0 items-center gap-2 sm:flex">{trailingContent}</span>
      ) : null}
      {trailingMeta ? (
        <span className="hidden shrink-0 self-center text-xs text-muted-foreground sm:block">
          {trailingMeta}
        </span>
      ) : null}
      {showUnreadSlot ? (
        <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center self-center">
          {showUnreadDot ? (
            <button
              type="button"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onMarkRead?.();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  event.stopPropagation();
                  onMarkRead?.();
                }
              }}
              className="inline-flex h-4 w-4 items-center justify-center rounded-full transition-colors hover:bg-blue-500/20"
              aria-label="Mark as read"
            >
              <span
                className={cn(
                  "block h-2 w-2 rounded-full bg-blue-600 transition-opacity duration-300 dark:bg-blue-400",
                  unreadState === "fading" ? "opacity-0" : "opacity-100",
                )}
              />
            </button>
          ) : (
            <span className="inline-flex h-4 w-4" aria-hidden="true" />
          )}
        </span>
      ) : null}
    </Link>
  );
}
