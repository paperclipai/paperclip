import { useState, useEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { youtubeApi, type YoutubeExtraction } from "../api/youtube";
import {
  Youtube,
  Loader2,
  ChevronDown,
  ChevronRight,
  Trash2,
  ExternalLink,
  CheckCircle2,
  XCircle,
} from "lucide-react";

function formatDuration(sec: number | null): string {
  if (!sec) return "";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatViews(n: number | null): string {
  if (!n) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M views`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K views`;
  return `${n} views`;
}

function StatusBadge({ status }: { status: string }) {
  if (status === "completed") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
        <CheckCircle2 className="h-3 w-3" />
        Done
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/30 dark:text-red-400">
        <XCircle className="h-3 w-3" />
        Failed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400">
      <Loader2 className="h-3 w-3 animate-spin" />
      Processing
    </span>
  );
}

function VerdictBadge({ report }: { report: string | null }) {
  if (!report) return null;
  if (report.includes("HIGHLY RECOMMENDED")) {
    return (
      <span className="rounded bg-green-100 px-1.5 py-0.5 text-xs font-semibold text-green-700 dark:bg-green-900/30 dark:text-green-400">
        HIGHLY RECOMMENDED
      </span>
    );
  }
  if (report.includes("WORTH EXPLORING")) {
    return (
      <span className="rounded bg-blue-100 px-1.5 py-0.5 text-xs font-semibold text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
        WORTH EXPLORING
      </span>
    );
  }
  if (report.includes("NOT RELEVANT")) {
    return (
      <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-semibold text-gray-600 dark:bg-gray-700 dark:text-gray-300">
        NOT RELEVANT
      </span>
    );
  }
  return null;
}

function ExtractionRow({
  extraction,
  onDelete,
}: {
  extraction: YoutubeExtraction;
  onDelete: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <tr
        className="border-b border-gray-100 dark:border-gray-800 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
        onClick={() => setExpanded((e) => !e)}
      >
        <td className="py-3 pl-4 pr-2 w-6">
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-gray-400" />
          ) : (
            <ChevronRight className="h-4 w-4 text-gray-400" />
          )}
        </td>
        <td className="py-3 pr-4 min-w-0">
          <div className="flex items-center gap-2.5">
            {extraction.thumbnailUrl && (
              <img
                src={extraction.thumbnailUrl}
                alt=""
                className="h-9 w-16 rounded object-cover flex-shrink-0"
              />
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-sm text-gray-900 dark:text-gray-100 truncate max-w-xs">
                  {extraction.title ?? extraction.url}
                </span>
                <VerdictBadge report={extraction.report} />
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-2 mt-0.5 flex-wrap">
                {extraction.channel && <span>{extraction.channel}</span>}
                {extraction.durationSec != null && (
                  <span>{formatDuration(extraction.durationSec)}</span>
                )}
                {extraction.viewCount != null && <span>{formatViews(extraction.viewCount)}</span>}
              </div>
            </div>
          </div>
        </td>
        <td className="py-3 pr-4 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
          {new Date(extraction.createdAt).toLocaleDateString()}
        </td>
        <td className="py-3 pr-4">
          <StatusBadge status={extraction.status} />
        </td>
        <td className="py-3 pr-4">
          <div className="flex items-center gap-2">
            <a
              href={extraction.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
              title="Open on YouTube"
            >
              <ExternalLink className="h-4 w-4" />
            </a>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete(extraction.id);
              }}
              className="text-gray-400 hover:text-red-500 transition-colors"
              title="Delete"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-gray-100 dark:border-gray-800">
          <td colSpan={5} className="px-4 pb-4 pt-1">
            {extraction.status === "processing" && (
              <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 py-3">
                <Loader2 className="h-4 w-4 animate-spin flex-shrink-0" />
                Extracting metadata and transcript, then analyzing with Claude… this may take 1-2
                minutes.
              </div>
            )}
            {extraction.status === "failed" && (
              <div className="rounded-lg bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-700 dark:text-red-400">
                <strong>Error:</strong> {extraction.errorMessage ?? "Unknown error"}
              </div>
            )}
            {extraction.status === "completed" && extraction.report && (
              <div className="rounded-lg bg-gray-50 dark:bg-gray-800/50 p-4 text-sm">
                <pre className="whitespace-pre-wrap font-sans text-gray-800 dark:text-gray-200 leading-relaxed">
                  {extraction.report}
                </pre>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

export function YouTube() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  const [url, setUrl] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "YouTube Extractor" }]);
  }, [setBreadcrumbs]);

  const { data: extractions = [], isLoading } = useQuery({
    queryKey: queryKeys.youtube.list(selectedCompanyId ?? ""),
    queryFn: () => youtubeApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 5_000,
  });

  const hasProcessing = extractions.some((e) => e.status === "processing");

  const submitMutation = useMutation({
    mutationFn: (videoUrl: string) => youtubeApi.create(selectedCompanyId!, { url: videoUrl }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.youtube.list(selectedCompanyId!) });
      setUrl("");
      setUrlError(null);
    },
    onError: (err: Error) => {
      setUrlError(err.message);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => youtubeApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.youtube.list(selectedCompanyId!) });
    },
  });

  const handleSubmit = useCallback(() => {
    const trimmed = url.trim();
    if (!trimmed) {
      setUrlError("Please enter a YouTube URL");
      return;
    }
    if (!trimmed.includes("youtube.com") && !trimmed.includes("youtu.be")) {
      setUrlError("Must be a YouTube URL (youtube.com or youtu.be)");
      return;
    }
    setUrlError(null);
    submitMutation.mutate(trimmed);
  }, [url, submitMutation]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") handleSubmit();
    },
    [handleSubmit],
  );

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      {/* Header */}
      <div className="mb-6 flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-red-100 dark:bg-red-900/30">
          <Youtube className="h-5 w-5 text-red-600 dark:text-red-400" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            YouTube Extractor
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Paste a YouTube URL to extract metadata, transcript, and get a research report.
          </p>
        </div>
      </div>

      {/* Input form */}
      <div className="mb-8 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
        <label className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300">
          YouTube URL
        </label>
        <div className="flex gap-2">
          <input
            type="url"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setUrlError(null);
            }}
            onKeyDown={handleKeyDown}
            placeholder="https://www.youtube.com/watch?v=..."
            className="flex-1 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-500"
          />
          <button
            onClick={handleSubmit}
            disabled={submitMutation.isPending || !url.trim()}
            className="flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50 transition-colors"
          >
            {submitMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Youtube className="h-4 w-4" />
            )}
            Extract
          </button>
        </div>
        {urlError && <p className="mt-1.5 text-xs text-red-600 dark:text-red-400">{urlError}</p>}
        {hasProcessing && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-yellow-600 dark:text-yellow-400">
            <Loader2 className="h-3 w-3 animate-spin" />
            Extraction in progress — results appear automatically when done.
          </p>
        )}
      </div>

      {/* History table */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12 text-gray-400">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : extractions.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-gray-400 dark:text-gray-600">
          <Youtube className="mb-3 h-10 w-10" />
          <p className="text-sm">No extractions yet. Paste a YouTube URL above to get started.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50 dark:border-gray-800 dark:bg-gray-800/50">
                <th className="w-6 py-2.5 pl-4 pr-2" />
                <th className="py-2.5 pr-4 text-left font-medium text-gray-600 dark:text-gray-400">
                  Video
                </th>
                <th className="py-2.5 pr-4 text-left font-medium text-gray-600 dark:text-gray-400 whitespace-nowrap">
                  Submitted
                </th>
                <th className="py-2.5 pr-4 text-left font-medium text-gray-600 dark:text-gray-400">
                  Status
                </th>
                <th className="py-2.5 pr-4 text-left font-medium text-gray-600 dark:text-gray-400">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {extractions.map((extraction) => (
                <ExtractionRow
                  key={extraction.id}
                  extraction={extraction}
                  onDelete={(id) => deleteMutation.mutate(id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
