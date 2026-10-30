import type {
  IssueBlockerAttentionIssueSummary,
  IssueRelationIssueSummary,
} from "@paperclipai/shared";
import { CheckCircle2, Circle } from "lucide-react";
import { createIssueDetailPath } from "@/lib/issueDetailBreadcrumb";
import {
  orderWaitingBlockers,
  type WaitingBlockerStatus,
  type WaitingBlockerStep,
} from "@/lib/issue-blockers";
import { Link } from "@/lib/router";
import { useStreamlinedTaskChatPresentation } from "./presentation-mode";

function isUnresolved(blocker: IssueRelationIssueSummary): boolean {
  return blocker.status !== "done" && blocker.status !== "cancelled";
}

export function resolveTaskChatBlockers(
  blockers: IssueRelationIssueSummary[],
  terminalBlockerIssueId?: string | null,
  directBlockerIssueId?: string | null,
  terminalBlocker?: IssueBlockerAttentionIssueSummary | null,
): {
  directBlocker: IssueRelationIssueSummary | IssueBlockerAttentionIssueSummary;
  ultimateBlocker: IssueRelationIssueSummary | IssueBlockerAttentionIssueSummary | null;
} | null {
  const unresolvedBlockers = blockers.filter(isUnresolved);
  if (unresolvedBlockers.length === 0) return null;

  const directBlocker = directBlockerIssueId
    ? unresolvedBlockers.find((blocker) => blocker.id === directBlockerIssueId)
    : terminalBlockerIssueId
      ? unresolvedBlockers.find((blocker) => (
          blocker.id === terminalBlockerIssueId
          || blocker.terminalBlockers?.some((terminal) => terminal.id === terminalBlockerIssueId)
        ))
      : unresolvedBlockers[0];

  // A selected intermediate blocker is not part of `terminalBlockers`, which
  // intentionally contains only structural leaves. If its direct path is not
  // in this payload (for example a child-derived attention path), show the
  // selected task itself instead of falling back to an unrelated blocker.
  if (!directBlocker) {
    if (!terminalBlocker) return null;
    return {
      directBlocker: terminalBlocker,
      ultimateBlocker: null,
    };
  }

  const terminalBlockers = directBlocker.terminalBlockers?.filter(isUnresolved) ?? [];
  const ultimateBlocker = terminalBlockerIssueId
    ? terminalBlocker?.id === terminalBlockerIssueId
      ? terminalBlocker
      : terminalBlockers.find((blocker) => blocker.id === terminalBlockerIssueId) ?? null
    : terminalBlockers[0] ?? null;

  return {
    directBlocker,
    ultimateBlocker: ultimateBlocker?.id === directBlocker.id ? null : ultimateBlocker,
  };
}

export interface ResolvedTaskChatLiveWork {
  steps: WaitingBlockerStep[];
  nowRunning: Array<IssueRelationIssueSummary | IssueBlockerAttentionIssueSummary>;
}

export function resolveTaskChatLiveWork(
  blockers: IssueRelationIssueSummary[],
  liveIssueIds: ReadonlySet<string>,
  selectedTerminalBlocker?: IssueBlockerAttentionIssueSummary | null,
): ResolvedTaskChatLiveWork | null {
  if (blockers.length === 0) return null;

  const steps = orderWaitingBlockers(blockers, liveIssueIds);
  const stepIds = new Set(steps.map((step) => step.blocker.id));
  const terminalCandidates: Array<IssueRelationIssueSummary | IssueBlockerAttentionIssueSummary> = [];
  for (const blocker of blockers) terminalCandidates.push(...(blocker.terminalBlockers ?? []));
  if (selectedTerminalBlocker) terminalCandidates.push(selectedTerminalBlocker);

  const nowRunning: Array<IssueRelationIssueSummary | IssueBlockerAttentionIssueSummary> = [];
  const seen = new Set<string>();
  for (const blocker of terminalCandidates) {
    if (!liveIssueIds.has(blocker.id) || stepIds.has(blocker.id) || seen.has(blocker.id)) continue;
    seen.add(blocker.id);
    nowRunning.push(blocker);
  }

  const hasLiveStep = steps.some((step) => step.status === "running");
  if (!hasLiveStep && nowRunning.length === 0) return null;

  return { steps, nowRunning };
}

function BlockerRow({
  label,
  blocker,
}: {
  label: string;
  blocker: IssueRelationIssueSummary | IssueBlockerAttentionIssueSummary;
}) {
  const streamlined = useStreamlinedTaskChatPresentation();
  const issuePathId = blocker.identifier ?? blocker.id;

  return streamlined ? (
    <Link
      to={createIssueDetailPath(issuePathId)}
      className="flex min-w-0 items-baseline gap-1.5 rounded px-1 py-0.5 text-amber-800 underline-offset-2 transition-colors hover:bg-accent/50 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-amber-200"
      title={`${blocker.identifier ?? blocker.id.slice(0, 8)} — ${blocker.title}`}
    >
      <span className="shrink-0 font-medium">{label}</span>
      <span className="shrink-0 font-mono">{blocker.identifier ?? blocker.id.slice(0, 8)}</span>
      <span className="truncate text-amber-700/80 dark:text-amber-300/80">{blocker.title}</span>
    </Link>
  ) : (
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

function LiveWorkGlyph({ status }: { status: WaitingBlockerStatus }) {
  const label = status === "done" ? "Done" : status === "running" ? "Running" : "Waiting";
  if (status === "done") {
    return (
      <CheckCircle2
        className="h-3.5 w-3.5 text-blue-500 dark:text-blue-400"
        role="img"
        aria-label={label}
      />
    );
  }
  if (status === "running") {
    return (
      <span className="flex h-3.5 w-3.5 items-center justify-center" role="img" aria-label={label}>
        <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-blue-400" aria-hidden />
      </span>
    );
  }
  return (
    <Circle
      className="h-3.5 w-3.5 text-blue-300 dark:text-blue-500/50"
      role="img"
      aria-label={label}
    />
  );
}

function LiveWorkLink({
  blocker,
  status,
  label,
}: {
  blocker: IssueRelationIssueSummary | IssueBlockerAttentionIssueSummary;
  status: WaitingBlockerStatus;
  label?: string;
}) {
  const streamlined = useStreamlinedTaskChatPresentation();
  const issuePathId = blocker.identifier ?? blocker.id;
  return (
    <Link
      to={createIssueDetailPath(issuePathId)}
      className={streamlined
        ? "flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-blue-800 underline-offset-2 transition-colors hover:bg-accent/50 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-blue-200"
        : "flex min-w-0 items-baseline gap-1 text-blue-800 underline-offset-2 hover:underline dark:text-blue-200"}
      title={`${blocker.identifier ?? blocker.id.slice(0, 8)} — ${blocker.title}`}
    >
      {streamlined && label ? <span className="shrink-0 font-medium">{label}</span> : null}
      {streamlined ? <LiveWorkGlyph status={status} /> : null}
      <span className="shrink-0 font-mono">{blocker.identifier ?? blocker.id.slice(0, 8)}</span>
      <span className="truncate text-blue-700/80 dark:text-blue-300/80">{blocker.title}</span>
    </Link>
  );
}

export function TaskChatBlockerLinks({
  directBlocker,
  ultimateBlocker,
  placement,
}: {
  directBlocker: IssueRelationIssueSummary | IssueBlockerAttentionIssueSummary;
  ultimateBlocker: IssueRelationIssueSummary | IssueBlockerAttentionIssueSummary | null;
  placement: "top" | "bottom";
}) {
  const streamlined = useStreamlinedTaskChatPresentation();
  const directLabel = streamlined && placement === "bottom" ? "Still blocked by" : "Blocked by";
  const rootLabel = streamlined
    ? placement === "bottom" ? "Root blocker remains" : "Root blocker"
    : "Ultimately blocked by";
  return (
    <div
      aria-label="Task blockers"
      data-placement={placement}
      data-testid="task-chat-blocker-links"
      className="flex min-w-0 flex-col gap-1 overflow-hidden text-(length:--text-micro) leading-4 text-amber-700 dark:text-amber-300"
    >
      <BlockerRow label={directLabel} blocker={directBlocker} />
      {ultimateBlocker ? (
        <BlockerRow label={rootLabel} blocker={ultimateBlocker} />
      ) : null}
    </div>
  );
}

export function TaskChatLiveWorkLinks({
  liveWork,
  placement,
}: {
  liveWork: ResolvedTaskChatLiveWork;
  placement: "top" | "bottom";
}) {
  const streamlined = useStreamlinedTaskChatPresentation();
  const heading = streamlined && placement === "bottom" ? "Still waiting on live work" : "Waiting on live work";
  return (
    <div
      aria-label="Tasks waiting on live work"
      data-placement={placement}
      data-testid="task-chat-live-work-links"
      className="flex min-w-0 flex-col gap-1.5 overflow-hidden text-(length:--text-micro) leading-4 text-blue-700 dark:text-blue-300"
    >
      <div className="flex items-center gap-1.5 font-medium">
        <span className="flex h-3.5 w-3.5 items-center justify-center" aria-hidden>
          <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-blue-400" />
        </span>
        {heading}
      </div>
      <ol className="flex min-w-0 flex-col gap-1">
        {liveWork.steps.map(({ blocker, status }, index) => (
          <li
            key={blocker.id}
            data-testid="task-chat-live-work-step"
            className={streamlined ? "min-w-0 whitespace-nowrap" : "flex min-w-0 items-center gap-1.5 whitespace-nowrap"}
          >
            {!streamlined ? (
              <>
                <span className="w-4 shrink-0 text-right font-mono text-blue-500/80" aria-hidden>
                  {index + 1}.
                </span>
                <LiveWorkGlyph status={status} />
              </>
            ) : null}
            <LiveWorkLink blocker={blocker} status={status} />
          </li>
        ))}
      </ol>
      {liveWork.nowRunning.map((blocker) => streamlined ? (
        <LiveWorkLink key={blocker.id} blocker={blocker} status="running" label="Now running" />
      ) : (
        <div key={blocker.id} className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
          <span className="shrink-0 font-medium">Now running</span>
          <LiveWorkLink blocker={blocker} status="running" />
        </div>
      ))}
    </div>
  );
}
