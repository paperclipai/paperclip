/**
 * THESIS: Today is a work desk, not a control-plane dashboard.
 * OWN-WORLD: Inherit Paperclip's neutral operational system, status language, and token-only styling.
 * STORY: Nate opens one page, sees what needs him, reviews submitted work, and understands what runs next.
 * FIRST VIEWPORT: A compact date heading followed immediately by Needs you and Ready to review, then live work.
 * FORM: An ordered desk of separated rows. Information hierarchy replaces nested cards and technical chrome.
 */
import { useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Check, Circle, Clock3, ListTodo, Play, SquarePen } from "lucide-react";
import type { Issue } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { issuesApi } from "@/api/issues";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useDialogActions } from "@/context/DialogContext";
import { useToastActions } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { DelegateBrowserNotificationControl } from "@/components/DelegateBrowserNotifications";

type TodayGroup = "needsYou" | "ready" | "working" | "upNext" | "done";

const GROUPS: Array<{
  key: TodayGroup;
  title: string;
  description: string;
  Icon: typeof AlertCircle;
}> = [
  { key: "needsYou", title: "Needs you", description: "Blocked work waiting for your input", Icon: AlertCircle },
  { key: "ready", title: "Ready to review", description: "Submitted work waiting for your verdict", Icon: Check },
  { key: "working", title: "Working", description: "Work in progress", Icon: Play },
  { key: "upNext", title: "Up next", description: "Approved work waiting to start", Icon: ListTodo },
  { key: "done", title: "Done today", description: "Work you accepted today", Icon: Circle },
];

function timestamp(value: Date | string | null | undefined) {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function sameLocalDay(value: Date | string | null | undefined, now = new Date()) {
  if (!value) return false;
  const date = new Date(value);
  return date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
}

export function groupTodayIssues(issues: Issue[], now = new Date()): Record<TodayGroup, Issue[]> {
  const actionableIssues = issues.filter((issue) => issue.workMode !== "planning");
  const byReviewTime = (a: Issue, b: Issue) => (
    (timestamp(a.reviewBy) || timestamp(a.neededAt) || Number.MAX_SAFE_INTEGER)
    - (timestamp(b.reviewBy) || timestamp(b.neededAt) || Number.MAX_SAFE_INTEGER)
  );
  return {
    needsYou: actionableIssues.filter((issue) => issue.status === "blocked").sort(byReviewTime),
    ready: actionableIssues.filter((issue) => issue.status === "in_review").sort(byReviewTime),
    working: actionableIssues.filter((issue) => issue.status === "in_progress").sort(byReviewTime),
    upNext: actionableIssues.filter((issue) => issue.status === "todo" || issue.status === "backlog").sort(byReviewTime),
    done: actionableIssues
      .filter((issue) => issue.status === "done" && sameLocalDay(issue.completedAt, now))
      .sort((a, b) => timestamp(b.completedAt) - timestamp(a.completedAt)),
  };
}

function dateLabel(value: Date | string | null | undefined, prefix: string) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return `${prefix} ${new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(date)}`;
}

function TaskRow({ issue, group, onAccept, accepting }: {
  issue: Issue;
  group: TodayGroup;
  onAccept: (issue: Issue) => void;
  accepting: boolean;
}) {
  const timing = dateLabel(issue.reviewBy, "Review by") ?? dateLabel(issue.neededAt, "Needed");
  return (
    <div className="grid gap-3 border-t border-border/60 py-4 first:border-t-0 md:grid-cols-(--gtc-delegate-task-row) md:items-center">
      <div className="min-w-0">
        <Link
          to={`/issues/${issue.identifier ?? issue.id}`}
          issuePrefetch={issue}
          className="font-medium text-foreground hover:underline"
        >
          {issue.title}
        </Link>
        {issue.description ? (
          <p className="mt-1 line-clamp-2 max-w-3xl text-sm text-muted-foreground">{issue.description}</p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 md:justify-end">
        {timing ? (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Clock3 className="size-3.5" aria-hidden="true" />
            {timing}
          </span>
        ) : null}
        {issue.estimatedReviewMinutes ? (
          <span className="text-xs text-muted-foreground">{issue.estimatedReviewMinutes} min review</span>
        ) : null}
        {group === "ready" ? (
          <Button size="sm" onClick={() => onAccept(issue)} disabled={accepting}>
            {accepting ? "Accepting…" : "Accept"}
          </Button>
        ) : null}
        <Button asChild variant="outline" size="sm">
          <Link to={`/issues/${issue.identifier ?? issue.id}`} issuePrefetch={issue}>
            {group === "ready" ? "Review" : "Open"}
          </Link>
        </Button>
      </div>
    </div>
  );
}

export function Today() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { openNewIssue } = useDialogActions();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();

  useEffect(() => setBreadcrumbs([{ label: "Today" }]), [setBreadcrumbs]);

  const issuesQuery = useQuery({
    queryKey: [...queryKeys.issues.list(selectedCompanyId!), "delegate-today"],
    queryFn: () => issuesApi.list(selectedCompanyId!, { includeRoutineExecutions: false }),
    enabled: Boolean(selectedCompanyId),
    refetchOnWindowFocus: true,
  });
  const groups = useMemo(() => groupTodayIssues(issuesQuery.data ?? []), [issuesQuery.data]);
  const visibleCount = GROUPS.reduce((count, group) => count + groups[group.key].length, 0);

  const acceptTask = useMutation({
    mutationFn: (issue: Issue) => issuesApi.update(issue.id, { status: "done" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId!) });
      pushToast({ title: "Task accepted", body: "The result is now marked done." });
    },
    onError: (error) => pushToast({
      title: "Could not accept task",
      body: error instanceof Error ? error.message : "Try again from the task page.",
      tone: "error",
    }),
  });

  if (issuesQuery.isLoading) return <PageSkeleton />;

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-6 md:px-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm text-muted-foreground">
            {new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(new Date())}
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">Today</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Check what needs your input, review submitted work, and see what is running next.
          </p>
        </div>
        <Button onClick={() => openNewIssue()}>
          <SquarePen aria-hidden="true" />
          New task
        </Button>
      </header>

      <DelegateBrowserNotificationControl />

      {issuesQuery.isError ? (
        <div className="border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          Could not load today’s work. Refresh the page or check that Paperclip is running.
        </div>
      ) : visibleCount === 0 ? (
        <EmptyState
          icon={ListTodo}
          title="Nothing planned yet"
          message="Ask Claude Code or Codex to plan your day, or create a task here."
          action="New task"
          onAction={() => openNewIssue()}
        />
      ) : (
        <div className="flex flex-col gap-8">
          {GROUPS.map(({ key, title, description, Icon }) => {
            const rows = groups[key];
            if (rows.length === 0) return null;
            return (
              <section key={key} aria-labelledby={`today-${key}`}>
                <div className="mb-2 flex items-start justify-between gap-4">
                  <div className="flex items-start gap-2">
                    <Icon className="mt-0.5 size-4 text-muted-foreground" aria-hidden="true" />
                    <div>
                      <h2 id={`today-${key}`} className="text-sm font-semibold text-foreground">{title}</h2>
                      <p className="text-xs text-muted-foreground">{description}</p>
                    </div>
                  </div>
                  <span className="text-xs tabular-nums text-muted-foreground">{rows.length}</span>
                </div>
                <div>
                  {rows.map((issue) => (
                    <TaskRow
                      key={issue.id}
                      issue={issue}
                      group={key}
                      onAccept={(nextIssue) => acceptTask.mutate(nextIssue)}
                      accepting={acceptTask.isPending && acceptTask.variables?.id === issue.id}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </main>
  );
}
