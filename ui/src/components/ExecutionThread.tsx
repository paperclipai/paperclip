import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { activityApi } from "../api/activity";
import { queryKeys } from "../lib/queryKeys";
import { relativeTime, cn } from "../lib/utils";
import { Identity } from "./Identity";
import { StatusBadge } from "./StatusBadge";
import { Badge } from "./ui/badge";
import { ChevronDown, ChevronRight } from "lucide-react";
import type {
  ExecutionThreadEntry,
  Agent,
} from "@paperclipai/shared";

// Deterministic color palette for issue badges
const ISSUE_COLORS = [
  "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
  "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
  "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200",
  "bg-rose-100 text-rose-800 dark:bg-rose-900 dark:text-rose-200",
  "bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-200",
  "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
  "bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200",
];

function issueColorIndex(issueId: string): number {
  let hash = 0;
  for (let i = 0; i < issueId.length; i++) {
    hash = ((hash << 5) - hash + issueId.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % ISSUE_COLORS.length;
}

function IssueBadge({ identifier, issueId }: { identifier: string | null; issueId: string }) {
  const color = ISSUE_COLORS[issueColorIndex(issueId)];
  return (
    <Link to={`/issues/${identifier ?? issueId}`}>
      <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold shrink-0", color)}>
        {identifier ?? issueId.slice(0, 8)}
      </span>
    </Link>
  );
}

function EntryActor({ entry, agentMap }: { entry: ExecutionThreadEntry; agentMap: Map<string, Agent> }) {
  if (entry.actorType === "agent") {
    const agent = agentMap.get(entry.actorId);
    return <Identity name={agent?.name ?? entry.actorId.slice(0, 8)} size="xs" />;
  }
  if (entry.actorType === "system") return <Identity name="System" size="xs" />;
  return <Identity name="Board" size="xs" />;
}

function CommentBody({ body }: { body: string }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = body.length > 280;
  const preview = isLong ? body.slice(0, 280) + "\u2026" : body;

  return (
    <div className="mt-1 text-xs text-foreground/80">
      <pre className="whitespace-pre-wrap font-sans leading-relaxed">
        {expanded ? body : preview}
      </pre>
      {isLong && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-1 inline-flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground"
        >
          {expanded ? (
            <>
              <ChevronDown className="h-3 w-3" /> Show less
            </>
          ) : (
            <>
              <ChevronRight className="h-3 w-3" /> Show more
            </>
          )}
        </button>
      )}
    </div>
  );
}

function EntryDescription({ entry }: { entry: ExecutionThreadEntry }) {
  switch (entry.kind) {
    case "issue_created":
      return <span>created this issue</span>;
    case "status_change":
      return (
        <span className="inline-flex items-center gap-1.5 flex-wrap">
          changed status
          {entry.statusFrom && (
            <>
              {" from "}
              <StatusBadge status={entry.statusFrom} />
            </>
          )}
          {" to "}
          <StatusBadge status={entry.statusTo ?? "unknown"} />
        </span>
      );
    case "assignment_change":
      return (
        <span>
          {entry.assigneeTo ? "assigned the issue" : "unassigned the issue"}
        </span>
      );
    case "comment":
      return <span>commented</span>;
    case "blocker_added":
      return (
        <span className="inline-flex items-center gap-1">
          added blocker
          {entry.blockerIssueIdentifier && (
            <Link to={`/issues/${entry.blockerIssueIdentifier}`} className="font-medium underline">
              {entry.blockerIssueIdentifier}
            </Link>
          )}
        </span>
      );
    case "blocker_removed":
      return (
        <span className="inline-flex items-center gap-1">
          removed blocker
          {entry.blockerIssueIdentifier && (
            <Link to={`/issues/${entry.blockerIssueIdentifier}`} className="font-medium underline">
              {entry.blockerIssueIdentifier}
            </Link>
          )}
        </span>
      );
    case "issue_updated":
      return <span>updated the issue</span>;
    default:
      return <span>performed an action</span>;
  }
}

interface ExecutionThreadProps {
  issueId: string;
  agentMap: Map<string, Agent>;
}

export function ExecutionThread({ issueId, agentMap }: ExecutionThreadProps) {
  return <ThreadTimeline issueId={issueId} agentMap={agentMap} />;
}

function ThreadTimeline({
  issueId,
  agentMap,
}: {
  issueId: string;
  agentMap: Map<string, Agent>;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.issues.executionThread(issueId),
    queryFn: () => activityApi.executionThread(issueId),
    enabled: !!issueId,
    refetchInterval: 5000,
  });

  if (isLoading) {
    return <p className="text-xs text-muted-foreground py-4">Loading thread...</p>;
  }

  if (error) {
    return <p className="text-xs text-destructive py-4">Failed to load execution thread.</p>;
  }

  if (!data || data.entries.length === 0) {
    return <p className="text-xs text-muted-foreground py-4">No activity in this thread yet.</p>;
  }

  return (
    <div className="space-y-3">
      {/* Summary header */}
      <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          {data.issues.length} issue{data.issues.length !== 1 ? "s" : ""}
        </span>
        <span>&middot;</span>
        <span>{data.entries.length} events</span>
        <span>&middot;</span>
        <div className="flex items-center gap-1 flex-wrap">
          {data.issues.map((issue) => (
            <IssueBadge key={issue.id} identifier={issue.identifier} issueId={issue.id} />
          ))}
        </div>
      </div>

      {/* Timeline */}
      <div className="relative space-y-0">
        {/* Vertical line */}
        <div className="absolute left-3 top-2 bottom-2 w-px bg-border" />

        {data.entries.map((entry) => (
          <div key={entry.id} className="relative flex gap-3 py-1.5 pl-7">
            {/* Dot on the line */}
            <div
              className={cn(
                "absolute left-[9px] top-[11px] h-1.5 w-1.5 rounded-full",
                entry.kind === "comment" ? "bg-primary" : "bg-muted-foreground/50",
              )}
            />

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground flex-wrap">
                <IssueBadge identifier={entry.issueIdentifier} issueId={entry.issueId} />
                <EntryActor entry={entry} agentMap={agentMap} />
                <EntryDescription entry={entry} />
                <span className="ml-auto shrink-0 text-[10px]">{relativeTime(entry.timestamp)}</span>
              </div>

              {entry.kind === "comment" && entry.commentBody && (
                <CommentBody body={entry.commentBody} />
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
