import type { Issue } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";
import {
  describeIssueBoardState,
  getIssueBoardStateTone,
  resolveIssueBoardStateActionHref,
} from "../lib/issue-board-state-presentation";
import { createIssueDetailPath } from "../lib/issueDetailBreadcrumb";

function renderIssueNodeLabel(identifier: string | null, title: string) {
  return identifier ?? title;
}

export function IssueBoardStatePanel({
  issue,
  issueLinkState,
}: {
  issue: Issue;
  issueLinkState?: unknown;
}) {
  const boardState = issue.boardState;
  if (!boardState) return null;

  const tone = getIssueBoardStateTone(boardState.kind);
  const description = describeIssueBoardState(issue);
  const actionHref = resolveIssueBoardStateActionHref(issue);
  const blockerPath = issue.blockerPath ?? [];
  const extraRootBlockers = (issue.rootBlockers ?? []).filter(
    (blocker) => blocker.issueId !== issue.primaryBlocker?.issueId,
  );

  return (
    <section
      data-testid="issue-board-state-panel"
      className={cn("rounded-xl border px-4 py-4 shadow-xs", tone.panelClassName)}
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 space-y-1.5">
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {tone.eyebrow}
          </div>
          <h3 className="text-base font-semibold leading-tight">{boardState.headline}</h3>
          {description ? (
            <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actionHref && boardState.primaryAction ? (
          <Button asChild size="sm" variant="outline" className="shrink-0">
            <Link to={actionHref} state={issueLinkState}>
              {boardState.primaryAction.label}
            </Link>
          </Button>
        ) : null}
      </div>

      {blockerPath.length > 0 ? (
        <div className="mt-4 space-y-1.5">
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Blocker chain
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {blockerPath.map((node, index) => (
              <span key={node.issueId} className="contents">
                {index > 0 ? (
                  <span className="text-xs text-muted-foreground" aria-hidden="true">
                    →
                  </span>
                ) : null}
                <Link
                  to={createIssueDetailPath(node.identifier ?? node.issueId)}
                  state={issueLinkState}
                  className="inline-flex max-w-full items-center rounded-full border border-border bg-background/70 px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent/60"
                >
                  <span className="truncate">{renderIssueNodeLabel(node.identifier, node.title)}</span>
                </Link>
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {extraRootBlockers.length > 0 ? (
        <div className="mt-4 space-y-1.5">
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Other root blockers
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {extraRootBlockers.map((blocker) => (
              <Link
                key={blocker.issueId}
                to={createIssueDetailPath(blocker.identifier ?? blocker.issueId)}
                state={issueLinkState}
                className="inline-flex max-w-full items-center rounded-full border border-border bg-background/70 px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent/60"
              >
                <span className="truncate">{renderIssueNodeLabel(blocker.identifier, blocker.title)}</span>
              </Link>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
