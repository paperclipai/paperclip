import { useQuery } from "@tanstack/react-query";
import { fetchRecentBbaRuns, fetchBbaStats, type BbaMemoryRun } from "../../api/bbaMemory";

// TODO(tests): Add unit tests in ui/src/components/bba-memory/__tests__/ when
// @testing-library/react is added to ui/package.json devDependencies.
// Target: 5 unit tests + 1 snapshot covering loading/empty/populated/error/stats-card.

export interface BbaMemoryRecentRunsPanelProps {
  companyId: string;
  className?: string;
}

const OUTCOME_CLASSES: Record<string, string> = {
  success: "text-green-700 bg-green-50",
  failure: "text-red-700 bg-red-50",
  partial: "text-yellow-700 bg-yellow-50",
};

function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString();
}

export default function BbaMemoryRecentRunsPanel({
  companyId,
  className,
}: BbaMemoryRecentRunsPanelProps) {
  const runsQuery = useQuery({
    queryKey: ["bba-memory", "recent-runs", companyId],
    queryFn: ({ signal }) => fetchRecentBbaRuns(companyId, { limit: 20, signal }),
    refetchInterval: 30_000,
  });

  const statsQuery = useQuery({
    queryKey: ["bba-memory", "stats-summary", companyId],
    queryFn: ({ signal }) => fetchBbaStats(companyId, { windowDays: 7, signal }),
    refetchInterval: 60_000,
  });

  const isLoading = runsQuery.isLoading || statsQuery.isLoading;
  const runs: BbaMemoryRun[] = runsQuery.data?.runs ?? [];
  const stats = statsQuery.data;

  if (isLoading) {
    return (
      <div className={className} aria-busy="true" data-testid="bba-panel-loading">
        <div className="h-6 w-48 bg-gray-200 rounded animate-pulse mb-4" />
        <div className="h-32 bg-gray-100 rounded animate-pulse" />
      </div>
    );
  }

  if (runsQuery.isError || statsQuery.isError) {
    const msg =
      runsQuery.error instanceof Error
        ? runsQuery.error.message
        : statsQuery.error instanceof Error
          ? statsQuery.error.message
          : "Unknown error";
    return (
      <div className={className} role="alert" data-testid="bba-panel-error">
        <p className="text-sm text-red-700">Failed to load BBA runs — {msg}</p>
      </div>
    );
  }

  return (
    <section className={className} data-testid="bba-panel">
      <h2 className="text-lg font-semibold mb-3">BBA Memory — Recent Runs</h2>

      <div className="grid grid-cols-3 gap-3 mb-4" data-testid="bba-stats-cards">
        <div className="border rounded p-3">
          <div className="text-xs text-gray-500">Success rate (7d)</div>
          <div className="text-2xl font-semibold">
            {stats?.successRatePct == null ? "—" : `${stats.successRatePct}%`}
          </div>
        </div>
        <div className="border rounded p-3">
          <div className="text-xs text-gray-500">Total runs (7d)</div>
          <div className="text-2xl font-semibold">{stats?.totalRuns ?? 0}</div>
        </div>
        <div className="border rounded p-3">
          <div className="text-xs text-gray-500">Top failure</div>
          <div className="text-2xl font-semibold">
            {stats?.topFailureClasses?.[0]?.class ?? "—"}
          </div>
        </div>
      </div>

      {runs.length === 0 ? (
        <p className="text-sm text-gray-500" data-testid="bba-panel-empty">
          No BBA runs recorded yet.
        </p>
      ) : (
        <table className="w-full text-sm" data-testid="bba-panel-table">
          <thead className="text-left text-xs text-gray-500 border-b">
            <tr>
              <th className="py-2">Started</th>
              <th>Source</th>
              <th>Trigger</th>
              <th>Outcome</th>
              <th>Failure class</th>
              <th className="text-right">Duration</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} className="border-b last:border-0">
                <td className="py-2" title={r.startedAt}>
                  {formatTimestamp(r.startedAt)}
                </td>
                <td>{r.source}</td>
                <td className="text-gray-600">{r.trigger ?? "—"}</td>
                <td>
                  <span
                    className={`inline-block px-2 py-0.5 rounded text-xs ${
                      OUTCOME_CLASSES[r.outcome ?? ""] ?? "text-gray-500"
                    }`}
                  >
                    {r.outcome ?? "—"}
                  </span>
                </td>
                <td className="text-gray-600">{r.failureClass ?? "—"}</td>
                <td className="text-right tabular-nums">{formatDuration(r.durationMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
