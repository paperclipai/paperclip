import { useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { Issue, IssueComment, IssueDocument } from "@paperclipai/shared";
import { AlertTriangle, ChevronDown, ChevronRight, FileText, MessageSquare } from "lucide-react";
import { issuesApi } from "../api/issues";
import { createIssueDetailPath, withIssueDetailHeaderSeed } from "../lib/issueDetailBreadcrumb";
import { queryKeys } from "../lib/queryKeys";
import { cn, relativeTime } from "../lib/utils";
import { Link } from "@/lib/router";
import { StatusIcon } from "./StatusIcon";

type MissionSubtasksLogsSectionProps = {
  issueId: string;
  companyId: string;
};

type LogSignal = {
  hasLogDocument: boolean;
  hasClosureComment: boolean;
  noLogExpected: boolean;
  latestClosureComment: IssueComment | null;
  logDocuments: IssueDocument[];
};

const LOG_LOOKUP_LIMIT = 10;
const QUERY_STALE_TIME_MS = 60_000;
const LOG_DOCUMENT_PATTERN = /(^|_)log[_\[]/i;
const LOG_KEYWORDS_PATTERN = /\b(log|rapport|retex)\b/i;
const NO_LOG_EXPECTED_PATTERN = /\bno-log-expected\b/i;

function isMissionSubtasksViewEnabled() {
  const env = import.meta.env as ImportMetaEnv & Record<string, string | boolean | undefined>;
  const raw = env.VITE_ENABLE_MISSION_SUBTASKS_VIEW ?? env.ENABLE_MISSION_SUBTASKS_VIEW;
  return raw === true || raw === "true" || raw === "1";
}

function matchesLogDocument(document: IssueDocument) {
  const key = document.key.trim();
  const title = document.title?.trim() ?? "";
  return LOG_DOCUMENT_PATTERN.test(key) || LOG_DOCUMENT_PATTERN.test(title) || /Log_\[/i.test(key) || /Log_\[/i.test(title);
}

function matchesClosureComment(comment: IssueComment) {
  return !comment.deletedAt && LOG_KEYWORDS_PATTERN.test(comment.body);
}

function hasNoLogExpectedMarker(documents: IssueDocument[], comments: IssueComment[]) {
  return documents.some((document) =>
    NO_LOG_EXPECTED_PATTERN.test(document.key)
    || NO_LOG_EXPECTED_PATTERN.test(document.title ?? "")
    || NO_LOG_EXPECTED_PATTERN.test(document.body),
  ) || comments.some((comment) => !comment.deletedAt && NO_LOG_EXPECTED_PATTERN.test(comment.body));
}

function buildLogSignal(documents: IssueDocument[] | undefined, comments: IssueComment[] | undefined): LogSignal {
  const resolvedDocuments = documents ?? [];
  const resolvedComments = comments ?? [];
  const logDocuments = resolvedDocuments.filter(matchesLogDocument);
  const closureComments = resolvedComments.filter(matchesClosureComment);
  return {
    hasLogDocument: logDocuments.length > 0,
    hasClosureComment: closureComments.length > 0,
    noLogExpected: hasNoLogExpectedMarker(resolvedDocuments, resolvedComments),
    latestClosureComment: closureComments[0] ?? null,
    logDocuments,
  };
}

function issueLabel(issue: Issue) {
  return issue.identifier ?? issue.id.slice(0, 8);
}

function needsLog(signal: LogSignal, issue: Issue) {
  return issue.status === "done" && !signal.noLogExpected && !signal.hasLogDocument && !signal.hasClosureComment;
}

export function MissionSubtasksLogsSection({ issueId, companyId }: MissionSubtasksLogsSectionProps) {
  const [expanded, setExpanded] = useState(false);
  const { data: subtasks = [], isLoading, isError, error } = useQuery({
    queryKey: queryKeys.issues.listByParent(companyId, issueId),
    queryFn: () => issuesApi.list(companyId, { parentId: issueId, includeBlockedBy: true }),
    enabled: isMissionSubtasksViewEnabled() && Boolean(companyId && issueId),
    staleTime: QUERY_STALE_TIME_MS,
  });

  const directSubtasks = useMemo(
    () => subtasks.filter((subtask) => subtask.parentId === issueId),
    [issueId, subtasks],
  );
  const lookupSubtasks = directSubtasks.slice(0, LOG_LOOKUP_LIMIT);

  const documentQueries = useQueries({
    queries: lookupSubtasks.map((subtask) => ({
      queryKey: queryKeys.issues.documents(subtask.id),
      queryFn: () => issuesApi.listDocuments(subtask.id),
      enabled: isMissionSubtasksViewEnabled() && directSubtasks.length > 0,
      staleTime: QUERY_STALE_TIME_MS,
    })),
  });

  const commentQueries = useQueries({
    queries: lookupSubtasks.map((subtask) => ({
      queryKey: queryKeys.issues.comments(subtask.id),
      queryFn: () => issuesApi.listComments(subtask.id, { order: "desc", limit: 10 }),
      enabled: isMissionSubtasksViewEnabled() && directSubtasks.length > 0,
      staleTime: QUERY_STALE_TIME_MS,
    })),
  });

  const rows = lookupSubtasks.map((subtask, index) => {
    const documents = documentQueries[index]?.data;
    const comments = commentQueries[index]?.data;
    const signal = buildLogSignal(documents, comments);
    return {
      subtask,
      signal,
      missingLog: needsLog(signal, subtask),
      documentsLoading: documentQueries[index]?.isLoading ?? false,
      commentsLoading: commentQueries[index]?.isLoading ?? false,
    };
  });
  const missingLogCount = rows.filter((row) => row.missingLog).length;

  if (!isMissionSubtasksViewEnabled()) return null;
  if (!isLoading && directSubtasks.length === 0) return null;

  return (
    <section className="rounded-lg border border-border bg-card">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
      >
        <span className="flex min-w-0 items-center gap-2">
          {expanded ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
          <span className="min-w-0">
            <span className="block text-sm font-medium">Mission logs</span>
            <span className="block text-xs text-muted-foreground">
              {isLoading ? "Loading sub-tasks..." : `${directSubtasks.length} direct sub-task${directSubtasks.length === 1 ? "" : "s"}`}
            </span>
          </span>
        </span>
        {missingLogCount > 0 ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
            <AlertTriangle className="h-3 w-3" />
            Logs manquants {missingLogCount}
          </span>
        ) : null}
      </button>

      {expanded ? (
        <div className="border-t border-border px-3 py-3">
          {isError ? (
            <p className="text-sm text-destructive">
              {error instanceof Error ? error.message : "Unable to load mission logs."}
            </p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">Loading sub-tasks...</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[620px] text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="py-2 pr-3 text-left font-medium">Task</th>
                    <th className="px-3 py-2 text-left font-medium">Status</th>
                    <th className="px-3 py-2 text-left font-medium">Logs</th>
                    <th className="py-2 pl-3 text-left font-medium">Last signal</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ subtask, signal, missingLog, documentsLoading, commentsLoading }) => (
                    <tr key={subtask.id} className="border-b border-border/70 last:border-0">
                      <td className="max-w-[280px] py-2 pr-3">
                        <Link
                          to={createIssueDetailPath(subtask.identifier ?? subtask.id)}
                          state={withIssueDetailHeaderSeed(undefined, subtask)}
                          issuePrefetch={subtask}
                          className="block min-w-0 no-underline hover:text-foreground"
                        >
                          <span className="block font-mono text-xs text-muted-foreground">{issueLabel(subtask)}</span>
                          <span className="block truncate text-foreground">{subtask.title}</span>
                        </Link>
                      </td>
                      <td className="px-3 py-2">
                        <span className="inline-flex items-center gap-1.5">
                          <StatusIcon status={subtask.status} blockerAttention={subtask.blockerAttention} />
                          <span className="text-xs capitalize text-muted-foreground">{subtask.status.replaceAll("_", " ")}</span>
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        {documentsLoading || commentsLoading ? (
                          <span className="text-xs text-muted-foreground">Checking...</span>
                        ) : signal.noLogExpected ? (
                          <LogPill tone="muted">no-log-expected</LogPill>
                        ) : missingLog ? (
                          <LogPill tone="danger">Logs manquants</LogPill>
                        ) : signal.hasLogDocument || signal.hasClosureComment ? (
                          <LogPill tone="success">OK</LogPill>
                        ) : (
                          <LogPill tone="muted">Pending</LogPill>
                        )}
                      </td>
                      <td className="py-2 pl-3 text-xs text-muted-foreground">
                        <LogSignalSummary signal={signal} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {directSubtasks.length > LOG_LOOKUP_LIMIT ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Log lookup is capped at {LOG_LOOKUP_LIMIT} direct sub-tasks to keep this view lightweight.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function LogPill({ tone, children }: { tone: "success" | "danger" | "muted"; children: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        tone === "success" && "border-green-600/30 bg-green-600/10 text-green-700 dark:text-green-400",
        tone === "danger" && "border-destructive/40 bg-destructive/10 text-destructive",
        tone === "muted" && "border-border bg-muted text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

function LogSignalSummary({ signal }: { signal: LogSignal }) {
  if (signal.logDocuments.length > 0) {
    const document = signal.logDocuments[0];
    return (
      <span className="inline-flex items-center gap-1">
        <FileText className="h-3.5 w-3.5" />
        {document.title || document.key}
      </span>
    );
  }
  if (signal.latestClosureComment) {
    return (
      <a href={`#comment-${signal.latestClosureComment.id}`} className="inline-flex items-center gap-1 underline-offset-2 hover:underline">
        <MessageSquare className="h-3.5 w-3.5" />
        {relativeTime(signal.latestClosureComment.createdAt)}
      </a>
    );
  }
  return <span>No log signal</span>;
}
