import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { PlanDocumentRevision, PlanRevisionDiff, PlanBodyDiffLine } from "@paperclipai/shared";
import {
  AlertCircle,
  FileDiff,
  ChevronDown,
  ChevronRight,
  Loader2,
  GitCompare,
  ArrowLeft,
  RefreshCw,
  User,
  Bot,
} from "lucide-react";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatDateTime, relativeTime } from "../lib/utils";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// ─── PlanRevisionSummary: single revision row ─────────────────────────────────

function RevisionRow({
  revision,
  selected,
  onSelect,
  hasPlanMetadata,
}: {
  revision: PlanDocumentRevision;
  selected: boolean;
  onSelect: () => void;
  hasPlanMetadata: boolean;
}) {
  const actorLabel = revision.createdByUserId
    ? "board"
    : revision.createdByAgentId
      ? "agent"
      : "system";

  const actorIcon = revision.createdByAgentId
    ? <Bot className="h-3 w-3" />
    : <User className="h-3 w-3" />;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-2 text-left rounded-md border p-2.5 transition-colors",
        selected
          ? "border-primary/50 bg-accent"
          : "border-border/60 bg-card/30 hover:bg-accent/50",
      )}
    >
      <div className="shrink-0 pt-0.5">
        {selected ? (
          <ChevronDown className="h-3.5 w-3.5 text-primary" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs font-semibold text-foreground">
            rev {revision.revisionNumber}
          </span>
          {hasPlanMetadata && (
            <span className="rounded-sm bg-sky-500/10 px-1 py-0.5 text-[9px] font-medium text-sky-600 dark:text-sky-400">
              metadata
            </span>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground/70">
          <span className="inline-flex items-center gap-1">
            {actorIcon}
            {actorLabel}
          </span>
          <span title={formatDateTime(revision.createdAt)}>
            {relativeTime(revision.createdAt)}
          </span>
          {revision.changeSummary && (
            <span className="text-foreground/80 max-w-[300px] truncate" title={revision.changeSummary}>
              "{revision.changeSummary}"
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

// ─── InlineDiffViewer: renders the diff output ────────────────────────────────

interface InlineDiffViewerProps {
  diff: PlanBodyDiffLine[];
  className?: string;
}

const lineClassByType: Record<PlanBodyDiffLine["type"], string> = {
  added: "bg-emerald-500/10 text-emerald-100",
  removed: "bg-red-500/10 text-red-100",
  unchanged: "bg-transparent",
};

const markerByType: Record<PlanBodyDiffLine["type"], string> = {
  added: "+",
  removed: "-",
  unchanged: " ",
};

function InlineDiffViewer({ diff, className }: InlineDiffViewerProps) {
  if (diff.length === 0) {
    return (
      <div className="flex items-center justify-center rounded-md bg-muted/30 px-4 py-8 text-xs text-muted-foreground">
        No differences
      </div>
    );
  }

  return (
    <div className={cn("overflow-x-auto rounded-md border border-border/60 bg-card/30 font-mono text-xs leading-5", className)}>
      <table className="w-full border-collapse">
        <tbody>
          {diff.map((line, i) => (
            <tr
              key={i}
              className={cn(lineClassByType[line.type], "transition-colors")}
            >
              <td className="w-10 select-none text-right text-[10px] text-muted-foreground/50 pr-1">
                {line.oldLineNumber ?? ""}
              </td>
              <td className="w-10 select-none text-right text-[10px] text-muted-foreground/50 pr-2">
                {line.newLineNumber ?? ""}
              </td>
              <td className="w-4 select-none text-center text-muted-foreground/40 shrink-0">
                {markerByType[line.type]}
              </td>
              <td className="whitespace-pre-wrap break-all px-2">
                {line.value}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex items-center gap-3 border-t border-border/40 px-3 py-1 text-[10px] text-muted-foreground/60">
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-2 rounded-sm bg-emerald-500/40" />
          {diff.filter((d) => d.type === "added").length} additions
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-2 rounded-sm bg-red-500/40" />
          {diff.filter((d) => d.type === "removed").length} deletions
        </span>
      </div>
    </div>
  );
}

// ─── Props ───────────────────────────────────────────────────────────────────

interface PlanRevisionBrowserProps {
  issueId: string;
  initialOpen?: boolean;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function PlanRevisionBrowser({
  issueId,
  initialOpen = false,
}: PlanRevisionBrowserProps) {
  const [expanded, setExpanded] = useState(initialOpen);
  const [selectedRevisionId, setSelectedRevisionId] = useState<string | null>(null);

  // Fetch plan revisions
  const { data: revisions, isLoading: revisionsLoading } = useQuery({
    queryKey: queryKeys.issues.planRevisions(issueId),
    queryFn: () => issuesApi.listPlanRevisions(issueId),
    enabled: expanded,
  });

  const sortedRevisions = useMemo<PlanDocumentRevision[]>(() => {
    if (!revisions) return [];
    return [...revisions].sort((a, b) => b.revisionNumber - a.revisionNumber);
  }, [revisions]);

  // Default: select latest revision
  const effectiveRevisionId = selectedRevisionId ?? sortedRevisions[0]?.id ?? null;
  const selectedRevision = sortedRevisions.find((r) => r.id === effectiveRevisionId) ?? null;

  // Diff — fetch when a revision is selected and the panel is expanded
  const {
    data: diffResult,
    isLoading: diffLoading,
    isError: diffError,
    error: diffErrorObj,
    refetch: refetchDiff,
  } = useQuery({
    queryKey: queryKeys.issues.planRevisionDiff(
      issueId,
      effectiveRevisionId ?? "__none__",
      null,
    ),
    queryFn: () => issuesApi.getPlanRevisionDiff(issueId, effectiveRevisionId!),
    enabled: expanded && !!effectiveRevisionId,
  });

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between gap-2"
      >
        <h3 className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
          <GitCompare className="h-4 w-4" />
          Revision history
        </h3>
        <ChevronDown
          className={cn(
            "h-4 w-4 text-muted-foreground/60 transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>

      {expanded && (
        <div className="space-y-3">
          {/* Revision list */}
          {revisionsLoading ? (
            <div className="flex items-center gap-2 rounded-lg border border-border p-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading revisions...
            </div>
          ) : sortedRevisions.length === 0 ? (
            <div className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
              No revisions found
            </div>
          ) : (
            <div className="space-y-1.5">
              {sortedRevisions.slice(0, 20).map((rev) => (
                <RevisionRow
                  key={rev.id}
                  revision={rev}
                  selected={rev.id === effectiveRevisionId}
                  onSelect={() => setSelectedRevisionId(rev.id)}
                  hasPlanMetadata={!!rev.planMetadata}
                />
              ))}
              {sortedRevisions.length > 20 && (
                <p className="text-[10px] text-muted-foreground/60 px-1">
                  + {sortedRevisions.length - 20} more revisions
                </p>
              )}
            </div>
          )}

          {/* Selected revision info + diff */}
          {selectedRevision && (
            <div className="rounded-md border border-border/60 bg-card/30 p-3">
              <div className="flex items-center justify-between gap-2">
                <h4 className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                  <FileDiff className="h-3.5 w-3.5 text-muted-foreground" />
                  Revision {selectedRevision.revisionNumber}
                  {diffResult?.previousRevision && (
                    <span className="text-muted-foreground/60 font-normal">
                      vs rev {diffResult.previousRevision.revisionNumber}
                    </span>
                  )}
                </h4>
                {diffResult?.previousRevision && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 gap-1 text-[10px]"
                    onClick={() => {
                      // Select the previous revision to compare
                      setSelectedRevisionId(diffResult.previousRevision!.id);
                    }}
                  >
                    <ArrowLeft className="h-3 w-3" />
                    View older
                  </Button>
                )}
              </div>

              {diffLoading ? (
                <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Loading diff...
                </div>
              ) : diffError ? (
                <div className="mt-2 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">Failed to load diff</p>
                    <p className="mt-0.5 text-destructive/80">
                      {(diffErrorObj as Error)?.message ?? "An unexpected error occurred"}
                    </p>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => refetchDiff()}
                      className="mt-1.5 h-auto gap-1 px-2 py-0.5 text-[10px]"
                    >
                      <RefreshCw className="h-3 w-3" />
                      Retry
                    </Button>
                  </div>
                </div>
              ) : diffResult ? (
                <div className="mt-2">
                  <InlineDiffViewer diff={diffResult.bodyDiff} />
                </div>
              ) : null}

              {/* Plan metadata changes indicator */}
              {selectedRevision.planMetadata && (
                <div className="mt-2 rounded-sm bg-sky-500/10 px-2 py-1 text-[10px] text-sky-600 dark:text-sky-400">
                  This revision includes structured plan metadata (sections, milestones).
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}