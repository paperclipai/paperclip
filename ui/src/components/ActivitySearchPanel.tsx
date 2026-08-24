import { useCallback, useEffect, useRef, useState } from "react";
import { Search, AlertCircle, Loader2 } from "lucide-react";
import type { BackgroundJobStatus } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StatusCue } from "@/components/ui/StatusCue";
import { IncompleteDataNotice } from "@/components/ui/IncompleteDataNotice";
import { researchApi } from "@/api/background-jobs";
import { useJobStatus } from "@/hooks/useJobStatus";

type SearchScope = "issues" | "activity" | "documents" | "all";

const SCOPE_OPTIONS: { value: SearchScope; label: string }[] = [
  { value: "all", label: "All" },
  { value: "issues", label: "Tasks" },
  { value: "activity", label: "Activity" },
  { value: "documents", label: "Documents" },
];

interface ActivitySearchPanelProps {
  companyId: string;
  /** Called with search results when the job completes. */
  onResults?: (results: Record<string, unknown> | null, error: string | null) => void;
  className?: string;
}

/**
 * Panel for searching activity data asynchronously.
 *
 * Submits a POST /api/companies/:companyId/research/activities
 * request and tracks the background job status via polling/SSE.
 */
export function ActivitySearchPanel({
  companyId,
  onResults,
  className = "",
}: ActivitySearchPanelProps) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<SearchScope>("all");
  const [jobId, setJobId] = useState<string | null>(null);
  const [submittedQuery, setSubmittedQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const jobStatus = useJobStatus(companyId, jobId, { useSSE: true });

  // Notify parent when results land
  useEffect(() => {
    if (jobStatus.isDone && onResults) {
      onResults(jobStatus.result, jobStatus.error);
    }
  }, [jobStatus.isDone, jobStatus.result, jobStatus.error, onResults]);

  const handleSearch = useCallback(async () => {
    const trimmed = query.trim();
    if (!trimmed) return;

    try {
      setSubmittedQuery(trimmed);
      const { jobId: newJobId } = await researchApi.searchActivities(companyId, {
        query: trimmed,
        scope,
        limit: 20,
      });
      setJobId(newJobId);
    } catch (err) {
      if (onResults) {
        onResults(null, err instanceof Error ? err.message : "Search request failed");
      }
    }
  }, [query, scope, companyId, onResults]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSearch();
      }
    },
    [handleSearch],
  );

  const isSearching = jobId !== null && (jobStatus.isRunning || jobStatus.status === "queued");

  return (
    <div className={`space-y-3 ${className}`}>
      {/* Search input row */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            ref={inputRef}
            type="text"
            placeholder="Search activity..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            className="pl-8"
            disabled={isSearching}
          />
        </div>

        {/* Scope selector */}
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value as SearchScope)}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          disabled={isSearching}
        >
          {SCOPE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>

        <Button
          onClick={handleSearch}
          disabled={!query.trim() || isSearching}
          size="sm"
        >
          {isSearching ? (
            <>
              <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
              Searching
            </>
          ) : (
            "Search"
          )}
        </Button>
      </div>

      {/* Job status / progress cue */}
      {jobId && (
        <div className="flex items-center gap-2">
          <StatusCue
            status={jobStatus.status}
            progress={jobStatus.progress}
            progressMessage={jobStatus.progressMessage}
            error={jobStatus.error}
            isRunning={jobStatus.isRunning}
            isDone={jobStatus.isDone}
            label={submittedQuery ? `Searching "${submittedQuery}"` : undefined}
          />
        </div>
      )}

      {/* Incomplete data notice (shown while job runs) */}
      {jobId && !jobStatus.isDone && (
        <IncompleteDataNotice
          jobStatus={jobStatus.status}
          subject="search results"
        />
      )}

      {/* Terminal error */}
      {jobStatus.isDone && jobStatus.error && (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/30 px-3 py-2 text-sm text-red-700 dark:text-red-400">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{jobStatus.error}</span>
        </div>
      )}
    </div>
  );
}