import { t, useTranslation } from "@/i18n";
import type {
  IssueBlockerAttentionIssueSummary,
  IssueRelationIssueSummary,
} from "@paperclipai/shared";
import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { ISSUE_SUMMARIES_MAX_IDS } from "@paperclipai/shared";
import { issuesApi } from "@/api/issues";
import { useCoordinatorWorkspaceEnabled } from "@/hooks/useCoordinatorWorkspaceEnabled";
import { createIssueDetailPath } from "@/lib/issueDetailBreadcrumb";
import { queryKeys } from "@/lib/queryKeys";
import { taskStatusIconProps, type TaskStatusPresentationInput } from "@/lib/task-status-presentation";
import { StatusIcon } from "../StatusIcon";
import {
  orderWaitingBlockers,
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
  useTranslation("task-components");
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

type LiveWorkBlocker = IssueRelationIssueSummary | IssueBlockerAttentionIssueSummary;

/**
 * The strip shows tasks, so it draws the shared task status glyph. Relation
 * summaries do not carry blocker attention or the waiting-conversation state,
 * so the same `/issues/summaries` projection that the sidebar and created-task
 * cards use supplies them; until it loads, the relation status is used.
 */
function useLiveWorkStatusPresentation(
  companyId: string | null | undefined,
  blockers: LiveWorkBlocker[],
): (blocker: LiveWorkBlocker) => TaskStatusPresentationInput {
  const { userId } = useCoordinatorWorkspaceEnabled();
  // The summaries endpoint accepts at most ISSUE_SUMMARIES_MAX_IDS per request.
  const batches = useMemo(() => {
    const ids = [...new Set(blockers.map((blocker) => blocker.id))].sort();
    const chunks: string[][] = [];
    for (let index = 0; index < ids.length; index += ISSUE_SUMMARIES_MAX_IDS) {
      chunks.push(ids.slice(index, index + ISSUE_SUMMARIES_MAX_IDS));
    }
    return chunks;
  }, [blockers]);
  const results = useQueries({
    queries: batches.map((ids) => ({
      queryKey: queryKeys.issues.summaryBatch(companyId ?? "__none__", userId, ids),
      queryFn: ({ signal }: { signal: AbortSignal }) => issuesApi.summaries(companyId!, ids, { signal }),
      enabled: Boolean(companyId),
    })),
  });
  const summaries = results.flatMap((result) => result.data ?? []);
  return (blocker) => {
    const summary = summaries.find((candidate) => candidate.id === blocker.id);
    if (summary) return taskStatusIconProps(summary);
    if ("status" in blocker) return taskStatusIconProps(blocker);
    // A sampled terminal blocker carries no status; it is only listed while live.
    return { status: "in_progress" };
  };
}

function LiveWorkGlyph({ presentation }: { presentation: TaskStatusPresentationInput }) {
  return <StatusIcon {...presentation} size="sm" />;
}

function LiveWorkLink({
  blocker,
  presentation,
  label,
}: {
  blocker: LiveWorkBlocker;
  presentation: TaskStatusPresentationInput;
  label?: string;
}) {
  useTranslation("task-components");
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
      {streamlined ? <LiveWorkGlyph presentation={presentation} /> : null}
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
  useTranslation("task-components");
  const streamlined = useStreamlinedTaskChatPresentation();
  const directLabel = streamlined && placement === "bottom" ? t("task-components:stillBlockedBy_4f3b07f8") : t("task-components:blockedBy_36931a94");
  const rootLabel = streamlined
    ? placement === "bottom" ? t("task-chat-ui:rootBlockerRemains") : t("task-components:rootBlocker_9c1c8ef5")
    : t("task-chat-ui:ultimatelyBlockedBy");
  return (
    <div
      aria-label={t("task-components:taskBlockers_036bb651")}
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
  companyId,
}: {
  liveWork: ResolvedTaskChatLiveWork;
  placement: "top" | "bottom";
  companyId?: string | null;
}) {
  useTranslation("task-components");
  const streamlined = useStreamlinedTaskChatPresentation();
  const listedBlockers = useMemo(
    () => [...liveWork.steps.map((step) => step.blocker), ...liveWork.nowRunning],
    [liveWork],
  );
  const presentationFor = useLiveWorkStatusPresentation(companyId, listedBlockers);
  const heading = streamlined && placement === "bottom" ? t("task-chat-ui:stillWaiting") : t("task-components:waitingOnLiveWork_54a2de10");
  return (
    <div
      aria-label={t("task-components:tasksWaitingOnLiveWork_1d80e4a7")}
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
        {liveWork.steps.map(({ blocker }, index) => (
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
                <LiveWorkGlyph presentation={presentationFor(blocker)} />
              </>
            ) : null}
            <LiveWorkLink blocker={blocker} presentation={presentationFor(blocker)} />
          </li>
        ))}
      </ol>
      {liveWork.nowRunning.map((blocker) => streamlined ? (
        <LiveWorkLink key={blocker.id} blocker={blocker} presentation={presentationFor(blocker)} label={t("task-components:nowRunning_44cdf357")} />
      ) : (
        <div key={blocker.id} className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
          <span className="shrink-0 font-medium">{t("task-components:nowRunning_44cdf357")}</span>
          <LiveWorkGlyph presentation={presentationFor(blocker)} />
          <LiveWorkLink blocker={blocker} presentation={presentationFor(blocker)} />
        </div>
      ))}
    </div>
  );
}
