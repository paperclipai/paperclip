import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { agentsApi } from "../api/agents";
import { routinesApi } from "../api/routines";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "../lib/utils";

type Tone = "default" | "secondary" | "destructive" | "outline";
function dollars(cents: number): string {
  return `$${Math.round(cents / 100)}`;
}

/**
 * Operability view for the AGNB producer/manager agents: each agent's manager,
 * schedule (cron + next run), last fire + result, budget burn, and a health
 * badge. Built purely from the existing agents + routines APIs (no new backend).
 */
export function Producers() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Producers" }]), [setBreadcrumbs]);
  const { selectedCompanyId, companies } = useCompany();
  // AGNB is single-tenant; the selected company isn't always resolved on a
  // deep-link, so fall back to the only company.
  const companyId = selectedCompanyId ?? companies?.[0]?.id ?? null;

  const agentsQ = useQuery({
    queryKey: queryKeys.agents.list(companyId!),
    queryFn: () => agentsApi.list(companyId!),
    enabled: !!companyId,
  });
  const routinesQ = useQuery({
    queryKey: queryKeys.routines.list(companyId!),
    queryFn: () => routinesApi.list(companyId!),
    enabled: !!companyId,
  });

  const rows = useMemo(() => {
    const agents = agentsQ.data ?? [];
    const routines = routinesQ.data ?? [];
    const nameById = new Map(agents.map((a) => [a.id, a.name]));
    const schedByAgent = new Map<string, (typeof routines)[number]["triggers"][number]>();
    for (const r of routines) {
      const trig = (r.triggers ?? []).find((t) => t.kind === "schedule") ?? (r.triggers ?? [])[0];
      if (r.assigneeAgentId && trig) schedByAgent.set(r.assigneeAgentId, trig);
    }
    return agents
      .filter((a) => a.role !== "ceo")
      .map((a) => {
        const t = schedByAgent.get(a.id);
        const overBudget = a.budgetMonthlyCents > 0 && a.spentMonthlyCents >= a.budgetMonthlyCents;
        const failed = !!t?.lastResult && /error|fail|block/i.test(t.lastResult);
        const paused = !!t && t.enabled === false;
        const noSched = a.role === "researcher" && !t;
        const health: { label: string; tone: Tone } = overBudget
          ? { label: "over budget", tone: "destructive" }
          : failed
            ? { label: "last run failed", tone: "destructive" }
            : paused
              ? { label: "paused", tone: "secondary" }
              : noSched
                ? { label: "no schedule", tone: "outline" }
                : !t || !t.lastFiredAt
                  ? { label: "pending first run", tone: "outline" }
                  : { label: "ok", tone: "default" };
        return { a, manager: a.reportsTo ? nameById.get(a.reportsTo) ?? "—" : "—", t, health, overBudget };
      })
      .sort((x, y) => x.manager.localeCompare(y.manager) || x.a.name.localeCompare(y.a.name));
  }, [agentsQ.data, routinesQ.data]);

  const loading = agentsQ.isLoading || routinesQ.isLoading;
  const err = (agentsQ.error || routinesQ.error) as Error | null;

  return (
    <div className="space-y-4">
      <AgnbSubnav group="ops" />
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Producers</h1>
        <span className="text-xs text-muted-foreground">{rows.length} agents</span>
      </div>
      {err && <p className="text-sm text-destructive">{err.message}</p>}
      {loading ? (
        <PageSkeleton variant="list" />
      ) : rows.length === 0 ? (
        <EmptyState icon={Activity} message="No agents." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="p-2">Agent</th>
                <th className="p-2">Manager</th>
                <th className="p-2">Schedule</th>
                <th className="p-2">Last run</th>
                <th className="p-2">Budget</th>
                <th className="p-2">Health</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ a, manager, t, health, overBudget }) => (
                <tr key={a.id} className="border-b border-border/60">
                  <td className="p-2">
                    <div className="font-medium">{a.name}</div>
                    <div className="text-[11px] text-muted-foreground">{a.role}</div>
                  </td>
                  <td className="p-2">{manager}</td>
                  <td className="p-2">
                    {t ? <span className="font-mono text-xs">{t.cronExpression}</span> : <span className="text-muted-foreground">—</span>}
                    {t?.nextRunAt && (
                      <div className="text-[11px] text-muted-foreground">
                        next {new Date(t.nextRunAt).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}
                      </div>
                    )}
                  </td>
                  <td className="p-2 text-xs">
                    {t?.lastFiredAt ? relativeTime(t.lastFiredAt) : <span className="text-muted-foreground">never</span>}
                    {t?.lastResult && <div className="max-w-[180px] truncate text-[11px] text-muted-foreground">{t.lastResult}</div>}
                  </td>
                  <td className="p-2 text-xs">
                    <span className={overBudget ? "text-destructive" : undefined}>
                      {dollars(a.spentMonthlyCents)}
                      {a.budgetMonthlyCents > 0 ? ` / ${dollars(a.budgetMonthlyCents)}` : ""}
                    </span>
                  </td>
                  <td className="p-2">
                    <Badge variant={health.tone}>{health.label}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
