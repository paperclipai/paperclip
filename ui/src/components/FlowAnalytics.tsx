import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  BarChart,
  Bar,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { useCompany } from "../context/CompanyContext";
import { analyticsApi } from "../api/analytics";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import type { Issue } from "@paperclipai/shared";

const DAY_PRESETS = [
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
] as const;

interface FlowAnalyticsProps {
  issues: Issue[];
}

export function FlowAnalytics({ issues }: FlowAnalyticsProps) {
  const { selectedCompanyId } = useCompany();
  const [days, setDays] = useState(30);
  const [deptLabelId, setDeptLabelId] = useState<string>("");
  const [initiativeId, setInitiativeId] = useState<string>("");

  const { data: labelsList } = useQuery({
    queryKey: queryKeys.issues.labels(selectedCompanyId!),
    queryFn: () => issuesApi.listLabels(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const deptLabels = useMemo(
    () => (labelsList ?? []).filter((l) => l.name.startsWith("dept:")),
    [labelsList],
  );

  const initiatives = useMemo(
    () => issues.filter((i) => i.issueType === "initiative"),
    [issues],
  );

  const queryParams = { days, deptLabelId: deptLabelId || undefined, initiativeId: initiativeId || undefined };

  const { data: throughputData = [], isLoading: throughputLoading } = useQuery({
    queryKey: ["analytics", "throughput", selectedCompanyId, queryParams],
    queryFn: () => analyticsApi.throughput(selectedCompanyId!, queryParams),
    enabled: !!selectedCompanyId,
  });

  const { data: flowData = [], isLoading: flowLoading } = useQuery({
    queryKey: ["analytics", "flow", selectedCompanyId, queryParams],
    queryFn: () => analyticsApi.flow(selectedCompanyId!, queryParams),
    enabled: !!selectedCompanyId,
  });

  const throughputSummary = useMemo(() => {
    const totalDone = throughputData.reduce((s, r) => s + r.done, 0);
    const totalCancelled = throughputData.reduce((s, r) => s + r.cancelled, 0);
    const avgPerDay = throughputData.length > 0 ? totalDone / throughputData.length : 0;
    return { totalDone, totalCancelled, avgPerDay };
  }, [throughputData]);

  const flowSummary = useMemo(() => {
    if (flowData.length === 0) return { backlog: 0, active: 0, review: 0, blocked: 0, terminal: 0 };
    const latest = flowData[flowData.length - 1]!;
    return latest;
  }, [flowData]);

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1 border border-border rounded-md overflow-hidden">
          {DAY_PRESETS.map((preset) => (
            <button
              key={preset.days}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                days === preset.days
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setDays(preset.days)}
            >
              {preset.label}
            </button>
          ))}
        </div>

        {deptLabels.length > 0 && (
          <select
            className="text-xs border border-border rounded-md px-2 py-1.5 bg-transparent text-foreground"
            value={deptLabelId}
            onChange={(e) => setDeptLabelId(e.target.value)}
          >
            <option value="">All departments</option>
            {deptLabels.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        )}

        {initiatives.length > 0 && (
          <select
            className="text-xs border border-border rounded-md px-2 py-1.5 bg-transparent text-foreground"
            value={initiativeId}
            onChange={(e) => setInitiativeId(e.target.value)}
          >
            <option value="">All initiatives</option>
            {initiatives.map((i) => (
              <option key={i.id} value={i.id}>
                {i.identifier ?? i.id.slice(0, 8)}: {i.title}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Throughput Chart */}
      <div className="space-y-3">
        <div className="flex items-baseline gap-4">
          <h3 className="text-sm font-semibold">Throughput</h3>
          <div className="flex gap-4 text-xs text-muted-foreground">
            <span>
              {throughputSummary.totalDone} done
            </span>
            <span>
              {throughputSummary.totalCancelled} cancelled
            </span>
            <span>
              {throughputSummary.avgPerDay.toFixed(1)}/day avg
            </span>
          </div>
        </div>

        <div className="h-48 w-full">
          {throughputLoading ? (
            <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
              Loading...
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={throughputData} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 10 }}
                  tickFormatter={(v: string) => v.slice(5)}
                  className="text-muted-foreground"
                />
                <YAxis tick={{ fontSize: 10 }} allowDecimals={false} className="text-muted-foreground" />
                <Tooltip
                  contentStyle={{ fontSize: 12, borderRadius: 6, border: "1px solid hsl(var(--border))" }}
                  labelFormatter={(v) => String(v)}
                />
                <Bar dataKey="done" name="Done" fill="#22c55e" radius={[2, 2, 0, 0]} />
                <Bar dataKey="cancelled" name="Cancelled" fill="#a1a1aa" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* CFD-lite (Cumulative Flow) */}
      <div className="space-y-3">
        <div className="flex items-baseline gap-4">
          <h3 className="text-sm font-semibold">Cumulative Flow</h3>
          <div className="flex gap-4 text-xs text-muted-foreground">
            <span>{flowSummary.backlog} backlog</span>
            <span>{flowSummary.active} active</span>
            <span>{flowSummary.review} review</span>
            <span>{flowSummary.blocked} blocked</span>
            <span>{flowSummary.terminal} terminal</span>
          </div>
        </div>

        <div className="h-48 w-full">
          {flowLoading ? (
            <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
              Loading...
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={flowData} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 10 }}
                  tickFormatter={(v: string) => v.slice(5)}
                  className="text-muted-foreground"
                />
                <YAxis tick={{ fontSize: 10 }} allowDecimals={false} className="text-muted-foreground" />
                <Tooltip
                  contentStyle={{ fontSize: 12, borderRadius: 6, border: "1px solid hsl(var(--border))" }}
                  labelFormatter={(v) => String(v)}
                />
                <Area type="monotone" dataKey="terminal" name="Terminal" stackId="1" fill="#22c55e" stroke="#22c55e" fillOpacity={0.6} />
                <Area type="monotone" dataKey="review" name="In Review" stackId="1" fill="#8b5cf6" stroke="#8b5cf6" fillOpacity={0.6} />
                <Area type="monotone" dataKey="active" name="Active" stackId="1" fill="#3b82f6" stroke="#3b82f6" fillOpacity={0.6} />
                <Area type="monotone" dataKey="blocked" name="Blocked" stackId="1" fill="#ef4444" stroke="#ef4444" fillOpacity={0.6} />
                <Area type="monotone" dataKey="backlog" name="Backlog" stackId="1" fill="#a1a1aa" stroke="#a1a1aa" fillOpacity={0.6} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>
  );
}
