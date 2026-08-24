import { useCallback, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Clock,
  Loader2,
  AlertCircle,
  CheckCircle2,
  XCircle,
  Ban,
  Database,
  RefreshCw,
  FileText,
  MessageSquare,
  Terminal,
} from "lucide-react";
import { memoryApi, type MemoryExtractionJob } from "../api/memory";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "./EmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// ─── Constants ──────────────────────────────────────────────────────────────

const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "queued", label: "Queued" },
  { value: "running", label: "Running" },
  { value: "succeeded", label: "Succeeded" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
] as const;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function statusIcon(status: string) {
  switch (status) {
    case "queued": return <Clock className="h-3.5 w-3.5 text-muted-foreground" />;
    case "running": return <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />;
    case "succeeded": return <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />;
    case "failed": return <XCircle className="h-3.5 w-3.5 text-destructive" />;
    case "cancelled": return <Ban className="h-3.5 w-3.5 text-muted-foreground" />;
    default: return <Clock className="h-3.5 w-3.5 text-muted-foreground" />;
  }
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case "queued":
      return "bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-300";
    case "running":
      return "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300";
    case "succeeded":
      return "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300";
    case "failed":
      return "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300";
    case "cancelled":
      return "bg-gray-100 text-gray-500 dark:bg-gray-900/30 dark:text-gray-400";
    default:
      return "bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-300";
  }
}

function hookKindIcon(kind?: string) {
  switch (kind) {
    case "post_run_capture": return <Terminal className="h-3.5 w-3.5" />;
    case "issue_comment_capture": return <MessageSquare className="h-3.5 w-3.5" />;
    case "issue_document_capture": return <FileText className="h-3.5 w-3.5" />;
    default: return <Database className="h-3.5 w-3.5" />;
  }
}

function hookKindLabel(kind?: string): string {
  switch (kind) {
    case "post_run_capture": return "Run Capture";
    case "issue_comment_capture": return "Comment Capture";
    case "issue_document_capture": return "Document Capture";
    default: return kind ?? "Unknown";
  }
}

function formatRelativeTime(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
}

function formatDuration(startedAt: string | null | undefined, finishedAt: string | null | undefined): string {
  if (!startedAt) return "—";
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  const ms = end - start;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

// ─── Status Summary Bar ──────────────────────────────────────────────────────

function StatusSummaryBar({ jobs }: { jobs: MemoryExtractionJob[] }) {
  const counts = {
    queued: jobs.filter((j) => j.status === "queued").length,
    running: jobs.filter((j) => j.status === "running").length,
    succeeded: jobs.filter((j) => j.status === "succeeded").length,
    failed: jobs.filter((j) => j.status === "failed").length,
    cancelled: jobs.filter((j) => j.status === "cancelled").length,
  };

  return (
    <div className="flex flex-wrap items-center gap-3 text-xs">
      <span className="flex items-center gap-1 text-muted-foreground">
        <Clock className="h-3 w-3" />
        {counts.queued} queued
      </span>
      <span className="flex items-center gap-1 text-blue-500">
        <Loader2 className="h-3 w-3 animate-spin" />
        {counts.running} running
      </span>
      <span className="flex items-center gap-1 text-green-500">
        <CheckCircle2 className="h-3 w-3" />
        {counts.succeeded} succeeded
      </span>
      <span className="flex items-center gap-1 text-destructive">
        <XCircle className="h-3 w-3" />
        {counts.failed} failed
      </span>
      <span className="flex items-center gap-1 text-muted-foreground">
        <Ban className="h-3 w-3" />
        {counts.cancelled} cancelled
      </span>
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export function ExtractionJobsDashboard({
  companyId,
}: {
  companyId: string;
}) {
  const [statusFilter, setStatusFilter] = useState("");
  const effectiveStatus = statusFilter || undefined;

  const { data, isLoading, error, refetch, isRefetching } = useQuery({
    queryKey: queryKeys.memory.extractionJobs(companyId, effectiveStatus),
    queryFn: () => memoryApi.extractionJobs(companyId, { status: effectiveStatus }),
    enabled: !!companyId,
    refetchInterval: 15_000, // poll every 15s for near-real-time updates
  });

  const handleRefresh = useCallback(() => {
    void refetch();
  }, [refetch]);

  // ── Retry Mutation ──────────────────────────────────────────────────────

  const queryClient = useQueryClient();

  const retryMutation = useMutation({
    mutationFn: (jobId: string) =>
      memoryApi.retryExtractionJob(companyId, jobId),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.memory.extractionJobs(companyId),
      });
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border p-4 text-sm text-destructive">
        <AlertCircle className="h-4 w-4" />
        {(error as Error).message}
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">No extraction jobs found.</p>
          <Button variant="ghost" size="sm" onClick={handleRefresh} disabled={isRefetching}>
            <RefreshCw className={cn("h-3.5 w-3.5 mr-1.5", isRefetching && "animate-spin")} />
            Refresh
          </Button>
        </div>
        <EmptyState
          icon={Database}
          message="No extraction jobs have been submitted yet."
        />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Summary + Controls */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <StatusSummaryBar jobs={data} />
        <div className="flex items-center gap-2">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[140px] h-8 text-xs">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value} className="text-xs">
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="ghost" size="sm" onClick={handleRefresh} disabled={isRefetching}>
            <RefreshCw className={cn("h-3.5 w-3.5", isRefetching && "animate-spin")} />
          </Button>
        </div>
      </div>

      {/* Job list */}
      <div className="border border-border rounded-lg divide-y divide-border">
        {data.map((job) => (
          <div key={job.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
            <div className="flex items-center gap-3 min-w-0 flex-1">
              {/* Status icon */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="shrink-0">{statusIcon(job.status)}</span>
                </TooltipTrigger>
                <TooltipContent side="top">
                  Status: {job.status}
                </TooltipContent>
              </Tooltip>

              {/* Job info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className={cn(
                    "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium",
                    statusBadgeClass(job.status),
                  )}>
                    {job.status}
                  </span>
                  <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                    {hookKindIcon(job.hookKind)}
                    {hookKindLabel(job.hookKind)}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-mono truncate">{job.providerJobId}</span>
                  <span>·</span>
                  <span>Submitted {formatRelativeTime(job.submittedAt)}</span>
                  {job.startedAt && (
                    <>
                      <span>·</span>
                      <span>Duration: {formatDuration(job.startedAt, job.finishedAt)}</span>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Error tooltip */}
            {job.errorMessage && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <AlertCircle className="h-3.5 w-3.5 text-destructive shrink-0" />
                </TooltipTrigger>
                <TooltipContent side="left" className="max-w-xs">
                  <p className="text-xs">{job.errorMessage}</p>
                </TooltipContent>
              </Tooltip>
            )}

            {/* Retry button for failed jobs */}
            {job.status === "failed" && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 shrink-0"
                disabled={retryMutation.isPending && retryMutation.variables === job.id}
                onClick={() => retryMutation.mutate(job.id)}
              >
                <RefreshCw
                  className={cn(
                    "h-3 w-3 mr-1",
                    retryMutation.isPending && retryMutation.variables === job.id && "animate-spin",
                  )}
                />
                Retry
              </Button>
            )}

            {/* Finished time */}
            <span className="text-[10px] text-muted-foreground whitespace-nowrap shrink-0">
              {job.finishedAt ? formatRelativeTime(job.finishedAt) : "—"}
            </span>
          </div>
        ))}
      </div>

      {/* Bottom refresh indicator */}
      <div className="flex items-center justify-between">
        <p className="text-[10px] text-muted-foreground">
          {data.length} job{data.length !== 1 ? "s" : ""} · Auto-refreshes every 15s
        </p>
        {isRefetching && (
          <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <Loader2 className="h-2.5 w-2.5 animate-spin" />
            Refreshing...
          </span>
        )}
      </div>
    </div>
  );
}
