import { useState } from "react";
import { Link, useNavigate } from "@/lib/router";
import { Identity } from "./Identity";
import { timeAgo } from "../lib/timeAgo";
import type { DashboardRun } from "../api/dashboard";

const STATUS_COLORS: Record<string, string> = {
  succeeded: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  failed: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  timed_out: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300",
  cancelled: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
  running: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  queued: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400",
};

const SOURCE_LABELS: Record<string, string> = {
  timer: "Timer",
  assignment: "Assigned",
  on_demand: "On Demand",
  automation: "Auto",
};

function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

function formatTokens(n: number | null): string {
  if (n == null) return "—";
  return n.toLocaleString();
}

export function RunsTable({ runs }: { runs: DashboardRun[] }) {
  const navigate = useNavigate();
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? runs : runs.slice(0, 20);

  if (runs.length === 0) {
    return (
      <div className="border border-border rounded-md p-4">
        <p className="text-sm text-muted-foreground">No recent runs.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="border border-border rounded-md overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Agent</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Task</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Status</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground">Tokens In</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground">Tokens Out</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground">Duration</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground">Source</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground">When</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((run) => (
              <tr
                key={run.id}
                className="border-b border-border last:border-b-0 hover:bg-accent/50 transition-colors cursor-pointer"
                onClick={() => navigate(`/agents/${run.agentId}/runs`)}
              >
                <td className="px-3 py-2">
                  {run.agentName ? (
                    <Identity name={run.agentName} size="sm" />
                  ) : (
                    <span className="text-muted-foreground text-xs font-mono">{run.agentId.slice(0, 8)}</span>
                  )}
                </td>
                <td className="px-3 py-2 max-w-[200px] truncate">
                  {run.issueIdentifier ? (
                    <Link
                      to={`/issues/${run.issueIdentifier}`}
                      className="text-foreground hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {run.issueTitle ?? run.issueIdentifier}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <span
                    className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${STATUS_COLORS[run.status] ?? STATUS_COLORS.queued}`}
                  >
                    {run.status}
                  </span>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{formatTokens(run.inputTokens)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatTokens(run.outputTokens)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatDuration(run.durationMs)}</td>
                <td className="px-3 py-2">
                  <span className="text-xs text-muted-foreground">
                    {SOURCE_LABELS[run.invocationSource] ?? run.invocationSource}
                  </span>
                </td>
                <td className="px-3 py-2 text-right text-muted-foreground">
                  {run.startedAt ? timeAgo(run.startedAt) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!showAll && runs.length > 20 && (
        <button
          onClick={() => setShowAll(true)}
          className="mt-2 text-sm text-muted-foreground hover:text-foreground underline underline-offset-2"
        >
          Show {runs.length - 20} more runs
        </button>
      )}
    </div>
  );
}
