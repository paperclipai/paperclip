import { Fragment, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { CircleAlert } from "lucide-react";
import { ISSUE_PRIORITIES, type AttentionHeldUpTask, type AttentionItem, type IssueLockedStub, type IssueRelationIssueSummary } from "@paperclipai/shared";
import { describeError } from "@/api/errors";
import { issuesApi } from "@/api/issues";
import { IssueReferencePill } from "@/components/IssueReferencePill";
import { isLockedIssueStub } from "@/components/LockedIssueChip";
import { MarkdownBody } from "@/components/MarkdownBody";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ANALYTICS_MASK_CLASS } from "@/lib/analytics/privacy";
import { unblockHeldUp } from "@/lib/coordinator-attention";
import { cn } from "@/lib/utils";
import { queryKeys } from "@/lib/queryKeys";

type BlockerDetail = Extract<NonNullable<AttentionItem["detail"]>, { kind: "blocker" }>;

/** "A", "A and B", "A, B and C": the shape of a short list in a sentence. */
function inSentence(parts: ReactNode[]): ReactNode {
  return parts.map((part, index) => (
    <Fragment key={index}>
      {index === 0 ? null : index === parts.length - 1 ? " and " : ", "}
      {part}
    </Fragment>
  ));
}

const isOpen = (status: string | null | undefined) => status !== "done" && status !== "cancelled";

const priorityRank = (priority: string | null | undefined) => {
  const index = (ISSUE_PRIORITIES as readonly string[]).indexOf(priority ?? "");
  return index === -1 ? ISSUE_PRIORITIES.length : index;
};
const identifierNumber = (identifier: string | null) => Number(identifier?.match(/(\d+)$/)?.[1] ?? Number.MAX_SAFE_INTEGER);

/**
 * The held-up tasks to list: open ones the viewer can read, in the card's
 * order (highest priority first, then the oldest, lowest-numbered task).
 * A private task comes back as a locked reference with no status; it is
 * left out, as the card's own count leaves it out. Each task's sort keys are
 * read once, before sorting, so a task holding up hundreds stays cheap.
 */
export function openHeldUpTasks(tasks: ReadonlyArray<IssueRelationIssueSummary | IssueLockedStub>): IssueRelationIssueSummary[] {
  const keyed: Array<{ task: IssueRelationIssueSummary; rank: number; number: number }> = [];
  for (const entry of tasks) {
    if (isLockedIssueStub(entry) || !isOpen(entry.status)) continue;
    keyed.push({ task: entry, rank: priorityRank(entry.priority), number: identifierNumber(entry.identifier) });
  }
  keyed.sort((left, right) => left.rank - right.rank || left.number - right.number);
  return keyed.map((entry) => entry.task);
}

/**
 * Every open task the blocked task holds up, loaded when the list opens. The
 * card names only the first few; the same list lives in the task's
 * Properties under Blocking.
 */
function HeldUpMore({ issueId, issueLabel, moreCount, behindCount }: { issueId: string; issueLabel: string; moreCount: number; behindCount: number }) {
  const [open, setOpen] = useState(false);
  const issue = useQuery({ queryKey: queryKeys.issues.detail(issueId), queryFn: () => issuesApi.get(issueId), enabled: open });
  const loadedBlocks = issue.data?.blocks;
  // Query data is structurally shared, so this sorts again only when the list changes.
  const blocks = useMemo(() => openHeldUpTasks(loadedBlocks ?? []), [loadedBlocks]);
  const heldUpCount = issue.data ? blocks.length : moreCount;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-unblock-held-up-more
          className="text-foreground underline decoration-muted-foreground/50 underline-offset-2 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {moreCount} more
        </button>
      </PopoverTrigger>
      {/* The popover renders outside the card, so it carries its own replay mask. */}
      <PopoverContent align="start" className={cn("w-80 p-0", ANALYTICS_MASK_CLASS)} data-unblock-held-up-list>
        {/* Once the list has loaded, its own count wins, zero included; the card's count only fills in while it loads. */}
        <p data-unblock-held-up-heading className="border-b border-border px-3 py-2 text-sm font-medium">
          {issueLabel} holds up {heldUpCount} {heldUpCount === 1 ? "task" : "tasks"}
        </p>
        <div className="max-h-64 overflow-y-auto py-1">
          {issue.isLoading ? <p className="px-3 py-2 text-xs text-muted-foreground">Loading…</p> : null}
          {issue.data && blocks.length === 0 ? <p className="px-3 py-2 text-xs text-muted-foreground">None of them are open now.</p> : null}
          {blocks.map((entry) => (
            <div key={entry.id} data-unblock-held-up-row className="flex min-w-0 items-center gap-2 px-3 py-1.5 text-sm">
              <IssueReferencePill issue={entry} />
              <span className="min-w-0 truncate">{entry.title}</span>
            </div>
          ))}
        </div>
        {/* A failed refresh is always shown; any rows loaded before stay visible above it. */}
        {issue.error ? (
          <p role="alert" className="border-t border-border px-3 py-2 text-xs text-destructive">
            {issue.data ? "Couldn't refresh this list, so it may be out of date. " : "Couldn't load the list. "}
            {describeError(issue.error, { action: issue.data ? "refresh the list" : "load the list" }).body} Open {issueLabel} to see it.
          </p>
        ) : null}
        {behindCount > 0 ? (
          <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
            {behindCount} more {behindCount === 1 ? "task is" : "tasks are"} waiting behind these (tasks they block, and their subtasks).
          </p>
        ) : null}
        <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">The same list is in {issueLabel} → Properties → Blocking.</p>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The ask on a human unblock card: what the assignee needs from a person, in a
 * destructive-tinted notice (DESIGN.md's notice recipe), with who asked, in
 * which task, and what the task holds up in a strip attached below it.
 */
export function UnblockAskNotice({ item, detail, askedBy }: { item: AttentionItem; detail: BlockerDetail; askedBy: string | null }) {
  const task = {
    id: item.subject.id,
    identifier: item.subject.identifier ?? null,
    title: item.subject.title ?? item.subject.identifier ?? "Task",
    status: item.subject.status ?? undefined,
  };
  const taskLabel = task.identifier ?? "this task";
  const { named, moreCount, behindCount } = unblockHeldUp(detail);
  const heldUp: ReactNode[] = named.map((entry: AttentionHeldUpTask) => <IssueReferencePill key={entry.id} issue={entry} />);
  if (moreCount > 0) {
    heldUp.push(<HeldUpMore key="more" issueId={task.id} issueLabel={taskLabel} moreCount={moreCount} behindCount={behindCount} />);
  }
  return (
    // The ask and task titles are customer text: keep them out of session replay.
    <div className={cn("overflow-hidden rounded-md border border-destructive/20", ANALYTICS_MASK_CLASS)}>
      <div className="flex gap-2.5 bg-destructive/10 px-3.5 py-3 text-sm text-foreground">
        <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
        <div data-unblock-ask className="min-w-0 flex-1">
          <span className="font-semibold">Needed from you:</span>{" "}
          <MarkdownBody>{detail.unblockAction ?? ""}</MarkdownBody>
        </div>
      </div>
      <p data-unblock-ask-context className="border-t border-destructive/15 bg-background py-2 pl-10 pr-3.5 text-xs leading-6 text-muted-foreground">
        {askedBy ? `Asked by ${askedBy} in ` : "Asked in "}
        <IssueReferencePill issue={task} />
        {heldUp.length > 0 ? <> · holds up {inSentence(heldUp)}</> : null}
        {heldUp.length > 0 && behindCount > 0 ? ` · ${behindCount} more waiting behind ${(detail.heldUpDirectCount ?? 0) === 1 ? "it" : "those"}` : null}
      </p>
    </div>
  );
}
