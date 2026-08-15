import type { IssueRelationIssueSummary } from "@paperclipai/shared";
import { createIssueDetailPath } from "@/lib/issueDetailBreadcrumb";
import { Link } from "@/lib/router";

function isUnresolved(blocker: IssueRelationIssueSummary): boolean {
  return blocker.status !== "done" && blocker.status !== "cancelled";
}

export function resolveTaskChatBlockers(
  blockers: IssueRelationIssueSummary[],
  terminalBlockerIssueId?: string | null,
): {
  directBlocker: IssueRelationIssueSummary;
  ultimateBlocker: IssueRelationIssueSummary | null;
} | null {
  const unresolvedBlockers = blockers.filter(isUnresolved);
  if (unresolvedBlockers.length === 0) return null;

  const directBlocker = terminalBlockerIssueId
    ? unresolvedBlockers.find((blocker) => (
        blocker.id === terminalBlockerIssueId
        || blocker.terminalBlockers?.some((terminal) => terminal.id === terminalBlockerIssueId)
      )) ?? unresolvedBlockers[0]
    : unresolvedBlockers[0];

  const terminalBlockers = directBlocker.terminalBlockers?.filter(isUnresolved) ?? [];
  const ultimateBlocker = terminalBlockerIssueId
    ? terminalBlockers.find((blocker) => blocker.id === terminalBlockerIssueId) ?? null
    : terminalBlockers[0] ?? null;

  return {
    directBlocker,
    ultimateBlocker: ultimateBlocker?.id === directBlocker.id ? null : ultimateBlocker,
  };
}

function BlockerRow({
  label,
  blocker,
}: {
  label: string;
  blocker: IssueRelationIssueSummary;
}) {
  const issuePathId = blocker.identifier ?? blocker.id;

  return (
    <div className="flex min-w-0 items-baseline gap-1.5 whitespace-nowrap">
      <span className="shrink-0 font-medium">{label}</span>
      <Link
        to={createIssueDetailPath(issuePathId)}
        className="flex min-w-0 items-baseline gap-1 text-amber-800 underline-offset-2 hover:underline dark:text-amber-200"
        title={`${blocker.identifier ?? blocker.id.slice(0, 8)} — ${blocker.title}`}
      >
        <span className="shrink-0 font-mono">{blocker.identifier ?? blocker.id.slice(0, 8)}</span>
        <span className="truncate text-amber-700/80 dark:text-amber-300/80">{blocker.title}</span>
      </Link>
    </div>
  );
}

export function TaskChatBlockerLinks({
  directBlocker,
  ultimateBlocker,
  placement,
}: {
  directBlocker: IssueRelationIssueSummary;
  ultimateBlocker: IssueRelationIssueSummary | null;
  placement: "top" | "bottom";
}) {
  return (
    <div
      aria-label="Task blockers"
      data-placement={placement}
      data-testid="task-chat-blocker-links"
      className="flex min-w-0 flex-col gap-1 overflow-hidden text-(length:--text-micro) leading-4 text-amber-700 dark:text-amber-300"
    >
      <BlockerRow label="Blocked by" blocker={directBlocker} />
      {ultimateBlocker ? (
        <BlockerRow label="Ultimately blocked by" blocker={ultimateBlocker} />
      ) : null}
    </div>
  );
}
