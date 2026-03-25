import type { ReactNode } from "react";
import type { Issue } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { cn } from "../lib/utils";
import { StatusIcon } from "./StatusIcon";

type UnreadState = "hidden" | "visible" | "fading";

interface IssueRowProps {
  issue: Issue;
  issueLinkState?: unknown;
  mobileLeading?: ReactNode;
  desktopMetaLeading?: ReactNode;
  desktopLeadingSpacer?: boolean;
  mobileMeta?: ReactNode;
  desktopTrailing?: ReactNode;
  trailingMeta?: ReactNode;
  unreadState?: UnreadState | null;
  onMarkRead?: () => void;
  className?: string;
}

export function IssueRow({
  issue,
  issueLinkState,
  mobileLeading,
  desktopMetaLeading,
  desktopLeadingSpacer = false,
  mobileMeta,
  desktopTrailing,
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
        "flex items-start gap-2 border-b border-border py-2.5 pl-2 pr-3 text-sm no-underline text-inherit transition-colors hover:bg-accent/50 last:border-b-0 sm:items-center sm:py-2 sm:pl-1",
        className,
      )}
    >
      <span className="shrink-0 pt-px sm:hidden">
        {mobileLeading ?? <StatusIcon status={issue.status} />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1 sm:contents">
        <span className="line-clamp-2 text-sm sm:order-2 sm:min-w-0 sm:flex-1 sm:truncate sm:line-clamp-none">
          {issue.title}
        </span>
        <span className="flex items-center gap-2 sm:order-1 sm:shrink-0">
          {desktopLeadingSpacer ? (
            <span className="hidden w-3.5 shrink-0 sm:block" />
          ) : null}
          {desktopMetaLeading ?? (
            <>
              <span className="hidden shrink-0 sm:inline-flex">
                <StatusIcon status={issue.status} />
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
