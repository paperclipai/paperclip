import { useEffect, useMemo, useState } from "react";

const DEFAULT_TYPE_ORDER = [
  "memory-integrity",
  "nightly-dive",
  "nightly-improvement",
  "sprint-checkin",
  "daily-notes",
  "content-run",
  "watchdog",
  "publish",
  "reminder",
  "other",
] as const;
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { heartbeatsApi } from "../api/heartbeats";
import { pluginsApi } from "../api/plugins";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { PageSkeleton } from "../components/PageSkeleton";
import { EmptyState } from "../components/EmptyState";
import { ShieldCheck } from "lucide-react";

function ragForJob(status: string, nextRunAt: Date | null, lastRunAt: Date | null) {
  if (status === "failed") return { label: "Red", className: "text-rose-600" };
  if (!nextRunAt && !lastRunAt) return { label: "Amber", className: "text-amber-600" };
  if (nextRunAt && nextRunAt.getTime() < Date.now() - 5 * 60_000) return { label: "Amber", className: "text-amber-600" };
  return { label: "Green", className: "text-emerald-600" };
}

function ragForCronJob(status: string | null, consecutiveErrors: number, enabled: boolean, nextRunAtMs: number | null, lastRunAtMs: number | null) {
  if (!enabled) return { label: "Off", className: "text-muted-foreground" };
  if (consecutiveErrors >= 2 || status === "error" || status === "failed") return { label: "Red", className: "text-rose-600" };
  if (!nextRunAtMs && !lastRunAtMs) return { label: "Amber", className: "text-amber-600" };
  if (nextRunAtMs && nextRunAtMs < Date.now() - 10 * 60_000) return { label: "Amber", className: "text-amber-600" };
  return { label: "Green", className: "text-emerald-600" };
}

function topicFromSessionKey(sessionKey: string | null) {
  if (!sessionKey) return "—";
  const match = sessionKey.match(/:topic:(\d+)/);
  return match ? `topic ${match[1]}` : "—";
}

function scheduleLabel(kind: string | null, expr: string | null, everyMs: number | null) {
  if (kind === "cron" && expr) return expr;
  if (kind === "every" && everyMs) return `every ${Math.round(everyMs / 60000)}m`;
  return kind ?? "—";
}

function ragEmoji(label: string) {
  if (label === "Red") return "🔴";
  if (label === "Amber") return "🟠";
  if (label === "Green") return "🟢";
  return "⚪";
}

function agentEmoji(agentId: string | null) {
  if (agentId === "main") return "🧠";
  if (agentId === "katya") return "🧵";
  return "🤖";
}

function jobTypeMeta(name: string) {
  const n = name.toLowerCase();
  if (n === "memory-integrity" || n.includes("memory-integrity")) return { key: "memory-integrity", label: "Memory Integrity", emoji: "🧠" };
  if (n === "nightly-dive" || n.includes("nightly-memory-dive") || n.includes("nightly deep dive")) return { key: "nightly-dive", label: "Nightly Deep Dive", emoji: "🌙" };
  if (n === "nightly-improvement" || n.includes("nightly-improvement")) return { key: "nightly-improvement", label: "Nightly Improvement", emoji: "🛠️" };
  if (n === "sprint-checkin" || n.includes("sprint-checkin")) return { key: "sprint-checkin", label: "Sprint Check-in", emoji: "📋" };
  if (n === "daily-notes" || n.includes("daily-notes")) return { key: "daily-notes", label: "Daily Notes", emoji: "📝" };
  if (n === "watchdog" || n.includes("cron-watchdog") || n.includes("watchdog")) return { key: "watchdog", label: "Watchdog", emoji: "🚨" };
  if (n === "content-run" || n.includes("content-calendar") || n.includes("marketing")) return { key: "content-run", label: "Content Run", emoji: "📣" };
  if (n === "publish" || n.includes("publish") || n.includes("promote") || n.includes("preflight")) return { key: "publish", label: "Publish/Promote", emoji: "🚀" };
  if (n === "reminder" || n.includes("reminder")) return { key: "reminder", label: "Reminder", emoji: "⏰" };
  return { key: "other", label: "Other", emoji: "⚙️" };
}

function jobTypeRank(typeKey: string, typeOrder: string[]) {
  const idx = typeOrder.indexOf(typeKey);
  return idx === -1 ? 999 : idx;
}

function architectureType(typeKey: string) {
  return ["memory-integrity", "nightly-dive", "nightly-improvement", "sprint-checkin", "daily-notes", "watchdog", "reminder"].includes(typeKey);
}

export function OpsHealth() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [agentFilter, setAgentFilter] = useState<"all" | "main" | "katya">("all");
  const [showRedOnly, setShowRedOnly] = useState(false);
  const [showArchitectureOnly, setShowArchitectureOnly] = useState(false);
  const [showCronTable, setShowCronTable] = useState(false);
  const [dragTypeKey, setDragTypeKey] = useState<string | null>(null);
  const [typeOrder, setTypeOrder] = useState<string[]>([...DEFAULT_TYPE_ORDER]);

  useEffect(() => {
    setBreadcrumbs([{ label: "Ops Health" }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("ops-health:type-order:v1");
      if (!saved) return;
      const parsed = JSON.parse(saved) as string[];
      if (!Array.isArray(parsed) || parsed.length === 0) return;
      const merged = [...parsed, ...DEFAULT_TYPE_ORDER.filter((k) => !parsed.includes(k))];
      setTypeOrder(merged);
    } catch {
      // ignore corrupted local preference
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem("ops-health:type-order:v1", JSON.stringify(typeOrder));
  }, [typeOrder]);

  const { data: schedulerAgents, isLoading, error } = useQuery({
    queryKey: ["ops-health", "scheduler-agents"],
    queryFn: () => heartbeatsApi.listInstanceSchedulerAgents(),
    refetchInterval: 30_000,
  });

  const { data: plugins } = useQuery({
    queryKey: ["ops-health", "plugins"],
    queryFn: () => pluginsApi.list(),
    refetchInterval: 30_000,
  });

  const { data: openclawCronJobs } = useQuery({
    queryKey: ["ops-health", "openclaw-cron-jobs"],
    queryFn: () => heartbeatsApi.listOpenclawCronJobs(),
    refetchInterval: 30_000,
  });

  const readyPlugins = useMemo(() => (plugins ?? []).filter((plugin) => plugin.status === "ready"), [plugins]);

  const pluginJobsQueries = useQueries({
    queries: readyPlugins.map((plugin) => ({
      queryKey: ["ops-health", "plugin-jobs", plugin.id],
      queryFn: () => pluginsApi.listJobs(plugin.id),
      refetchInterval: 30_000,
    })),
  });

  const dashboardQueries = useQueries({
    queries: readyPlugins.map((plugin) => ({
      queryKey: ["ops-health", "plugin-dashboard", plugin.id],
      queryFn: () => pluginsApi.dashboard(plugin.id),
      refetchInterval: 30_000,
    })),
  });

  const runNow = useMutation({
    mutationFn: ({ pluginId, jobId }: { pluginId: string; jobId: string }) => pluginsApi.triggerJob(pluginId, jobId),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ["ops-health", "plugin-jobs", vars.pluginId] });
      queryClient.invalidateQueries({ queryKey: ["ops-health", "plugin-dashboard", vars.pluginId] });
    },
  });

  const companyAgents = useMemo(() => {
    if (!selectedCompanyId) return [];
    return (schedulerAgents ?? []).filter((agent) => agent.companyId === selectedCompanyId);
  }, [schedulerAgents, selectedCompanyId]);

  const ragRows = useMemo(() => {
    return readyPlugins.flatMap((plugin, idx) => {
      const jobs = pluginJobsQueries[idx]?.data ?? [];
      const dashboard = dashboardQueries[idx]?.data;
      return jobs.map((job) => {
        const lastRunAt = job.lastRunAt ? new Date(job.lastRunAt) : null;
        const nextRunAt = job.nextRunAt ? new Date(job.nextRunAt) : null;
        const latestFailure = dashboard?.recentJobRuns?.find((run) => run.jobId === job.id && run.status === "failed");
        const rag = ragForJob(job.status, nextRunAt, lastRunAt);
        const blocker = latestFailure?.error ?? (job.status === "failed" ? "Job flagged failed" : null);
        const nextAction = blocker ? "Run now + inspect plugin logs" : "No action";
        return { plugin, job, rag, blocker, nextAction, lastRunAt, nextRunAt };
      });
    });
  }, [dashboardQueries, pluginJobsQueries, readyPlugins]);

  const cronRows = useMemo(() => {
    return (openclawCronJobs ?? []).map((job) => {
      const rag = ragForCronJob(job.lastRunStatus, job.consecutiveErrors, job.enabled, job.nextRunAtMs, job.lastRunAtMs);
      const type = jobTypeMeta(job.name);
      return {
        ...job,
        rag,
        type,
        topic: topicFromSessionKey(job.sessionKey),
      };
    });
  }, [openclawCronJobs]);

  const filteredCronRows = useMemo(() => {
    return cronRows
      .filter((row) => (agentFilter === "all" ? true : row.agentId === agentFilter))
      .filter((row) => (showRedOnly ? row.rag.label === "Red" : true))
      .filter((row) => (showArchitectureOnly ? architectureType(row.type.key) : true));
  }, [agentFilter, cronRows, showRedOnly, showArchitectureOnly]);

  const cronSummary = useMemo(() => {
    const total = cronRows.length;
    const green = cronRows.filter((row) => row.rag.label === "Green").length;
    const red = cronRows.filter((row) => row.rag.label === "Red").length;
    const lastChecked = cronRows.reduce<number | null>((max, row) => {
      const candidate = row.lastRunAtMs ?? row.nextRunAtMs ?? null;
      if (candidate === null) return max;
      if (max === null || candidate > max) return candidate;
      return max;
    }, null);
    return { total, green, red, lastChecked };
  }, [cronRows]);

  const cronGroups = useMemo(() => {
    const sortRows = (rows: typeof filteredCronRows) => [...rows].sort((a, b) => {
      const rankDelta = jobTypeRank(a.type.key, typeOrder) - jobTypeRank(b.type.key, typeOrder);
      if (rankDelta !== 0) return rankDelta;
      return a.name.localeCompare(b.name);
    });
    return {
      main: sortRows(filteredCronRows.filter((row) => row.agentId === "main")),
      katya: sortRows(filteredCronRows.filter((row) => row.agentId === "katya")),
      other: sortRows(filteredCronRows.filter((row) => row.agentId !== "main" && row.agentId !== "katya")),
    };
  }, [filteredCronRows, typeOrder]);

  if (isLoading) return <PageSkeleton variant="dashboard" />;
  if (error) return <p className="text-sm text-destructive">{error instanceof Error ? error.message : "Failed to load ops health"}</p>;

  return (
    <div className="space-y-4">
      {companyAgents.length === 0 ? (
        <EmptyState icon={ShieldCheck} message="No scheduler heartbeat agents found for this company." />
      ) : (
        <section className="rounded-lg border bg-card overflow-hidden">
          <div className="border-b px-3 py-2 text-sm font-semibold">Scheduler Heartbeats</div>
          <div className="divide-y">
            {companyAgents.map((agent) => (
              <div key={agent.id} className="grid grid-cols-12 gap-2 px-3 py-2 text-sm items-center">
                <div className="col-span-4 font-medium">{agent.agentName}</div>
                <div className="col-span-3 text-muted-foreground">{agent.adapterType}</div>
                <div className="col-span-2">{agent.schedulerActive ? "On" : "Off"}</div>
                <div className="col-span-3 text-right text-xs text-muted-foreground">{agent.lastHeartbeatAt ? new Date(agent.lastHeartbeatAt).toLocaleString() : "never"}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="rounded-lg border bg-card overflow-hidden">
        <button
          type="button"
          className="w-full border-b px-3 py-2 text-left text-sm font-semibold flex items-center justify-between"
          onClick={() => setShowCronTable((v) => !v)}
        >
          <span>OpenClaw cron jobs (cross-topic automation)</span>
          <span className="text-xs text-muted-foreground">{showCronTable ? "▲" : "▼"}</span>
        </button>
        <div className="px-3 py-2 text-xs text-muted-foreground border-b bg-muted/10">
          {cronSummary.total} total · {cronSummary.green} green · {cronSummary.red} red · last checked {cronSummary.lastChecked ? new Date(cronSummary.lastChecked).toLocaleString() : "n/a"}
        </div>
        {showCronTable && (
        <>
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-xs">
          <span className="text-muted-foreground">Filter:</span>
          <button className={`rounded border px-2 py-1 ${agentFilter === "all" ? "bg-muted" : ""}`} onClick={() => setAgentFilter("all")}>All</button>
          <button className={`rounded border px-2 py-1 ${agentFilter === "main" ? "bg-muted" : ""}`} onClick={() => setAgentFilter("main")}>🧠 Felix</button>
          <button className={`rounded border px-2 py-1 ${agentFilter === "katya" ? "bg-muted" : ""}`} onClick={() => setAgentFilter("katya")}>🧵 Katya</button>
          <button className={`rounded border px-2 py-1 ${showRedOnly ? "bg-muted" : ""}`} onClick={() => setShowRedOnly((v) => !v)}>{showRedOnly ? "Showing 🔴 only" : "Show 🔴 only"}</button>
          <button className={`rounded border px-2 py-1 ${showArchitectureOnly ? "bg-muted" : ""}`} onClick={() => setShowArchitectureOnly((v) => !v)}>{showArchitectureOnly ? "Architecture only 🏗️" : "Show architecture only 🏗️"}</button>
          <button
            className="rounded border px-2 py-1"
            onClick={() => {
              setAgentFilter("all");
              setShowRedOnly(false);
              setShowArchitectureOnly(false);
            }}
          >
            Reset filters
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-xs">
          <span className="text-muted-foreground">Type order (drag):</span>
          {typeOrder.map((typeKey) => {
            const meta = jobTypeMeta(typeKey);
            return (
              <button
                key={typeKey}
                draggable
                onDragStart={() => setDragTypeKey(typeKey)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => {
                  if (!dragTypeKey || dragTypeKey === typeKey) return;
                  setTypeOrder((current) => {
                    const next = current.filter((k) => k !== dragTypeKey);
                    const targetIndex = next.indexOf(typeKey);
                    next.splice(targetIndex, 0, dragTypeKey);
                    return next;
                  });
                  setDragTypeKey(null);
                }}
                onDragEnd={() => setDragTypeKey(null)}
                className="rounded border px-2 py-1"
                title="Drag to reorder"
              >
                {meta.emoji} {meta.label}
              </button>
            );
          })}
        </div>
        <div className="grid grid-cols-12 gap-2 px-3 py-2 text-[11px] uppercase tracking-wide text-muted-foreground border-b bg-muted/20">
          <div className="col-span-1">RAG</div><div className="col-span-2">Job</div><div className="col-span-2">Type</div><div className="col-span-1">Agent</div><div className="col-span-1">Topic</div><div className="col-span-2">Schedule</div><div className="col-span-1">Last run</div><div className="col-span-2">Next run</div>
        </div>
        <div className="divide-y">
          {filteredCronRows.length === 0 ? <div className="px-3 py-3 text-sm text-muted-foreground">No OpenClaw cron jobs match this filter.</div> : (
            <>
              {(["main", "katya", "other"] as const).map((groupKey) => {
                const rows = cronGroups[groupKey];
                if (rows.length === 0) return null;
                const title = groupKey === "main" ? "🧠 Felix jobs" : groupKey === "katya" ? "🧵 Katya jobs" : "🤖 Other jobs";
                return (
                  <div key={groupKey} className="border-t first:border-t-0">
                    <div className="px-3 py-2 text-xs font-semibold text-muted-foreground bg-muted/10">{title} ({rows.length})</div>
                    {rows.map((row) => (
                      <div key={row.id} className="grid grid-cols-12 gap-2 px-3 py-2 text-xs items-center">
                        <div className={`col-span-1 font-semibold ${row.rag.className}`}>{ragEmoji(row.rag.label)} {row.rag.label}</div>
                        <div className="col-span-2 truncate" title={row.name}>{row.name}</div>
                        <div className="col-span-2 text-muted-foreground truncate" title={row.type.label}>{row.type.emoji} {row.type.label}</div>
                        <div className="col-span-1 text-muted-foreground">{agentEmoji(row.agentId)} {row.agentId ?? "—"}</div>
                        <div className="col-span-1 text-muted-foreground">{row.topic}</div>
                        <div className="col-span-2 text-muted-foreground truncate" title={scheduleLabel(row.scheduleKind, row.scheduleExpr, row.everyMs)}>{scheduleLabel(row.scheduleKind, row.scheduleExpr, row.everyMs)}</div>
                        <div className="col-span-1 text-muted-foreground">{row.lastRunAtMs ? new Date(row.lastRunAtMs).toLocaleString() : "never"}</div>
                        <div className="col-span-2 text-muted-foreground">{row.nextRunAtMs ? new Date(row.nextRunAtMs).toLocaleString() : "n/a"}</div>
                      </div>
                    ))}
                  </div>
                );
              })}
            </>
          )}
        </div>
        </>
        )}
      </section>

      <section className="rounded-lg border bg-card overflow-hidden">
        <div className="border-b px-3 py-2 text-sm font-semibold">RAG Ops control panel</div>
        <div className="grid grid-cols-12 gap-2 px-3 py-2 text-[11px] uppercase tracking-wide text-muted-foreground border-b bg-muted/20">
          <div className="col-span-2">RAG</div><div className="col-span-2">Plugin</div><div className="col-span-2">Job</div><div className="col-span-2">Last run</div><div className="col-span-2">Next run</div><div className="col-span-1">Blocker</div><div className="col-span-1">Action</div>
        </div>
        <div className="divide-y">
          {ragRows.length === 0 ? <div className="px-3 py-3 text-sm text-muted-foreground">No scheduled plugin jobs found.</div> : ragRows.map((row) => (
            <div key={row.job.id} className="grid grid-cols-12 gap-2 px-3 py-2 text-xs items-center">
              <div className={`col-span-2 font-semibold ${row.rag.className}`}>{ragEmoji(row.rag.label)} {row.rag.label}</div>
              <div className="col-span-2 truncate" title={row.plugin.pluginKey}>{row.plugin.pluginKey}</div>
              <div className="col-span-2 font-mono truncate" title={row.job.jobKey}>{row.job.jobKey}</div>
              <div className="col-span-2 text-muted-foreground">{row.lastRunAt ? row.lastRunAt.toLocaleString() : "never"}</div>
              <div className="col-span-2 text-muted-foreground">{row.nextRunAt ? row.nextRunAt.toLocaleString() : "n/a"}</div>
              <div className="col-span-1 truncate" title={row.blocker ?? ""}>{row.blocker ?? "—"}</div>
              <div className="col-span-1 text-right">
                <button className="text-[11px] underline disabled:no-underline disabled:text-muted-foreground" onClick={() => runNow.mutate({ pluginId: row.plugin.id, jobId: row.job.id })} disabled={runNow.isPending}>Run now</button>
              </div>
            </div>
          ))}
        </div>
        <div className="border-t px-3 py-2 text-[11px] text-muted-foreground">If run-now is not permitted for a specific job, wire endpoint: POST /api/plugins/:pluginId/jobs/:jobId/trigger.</div>
      </section>
    </div>
  );
}
