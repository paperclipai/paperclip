import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { hiringApi, type HiringRequest } from "../api/hiring";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { UserPlus, CheckCircle2, Clock, Users, Briefcase } from "lucide-react";
import { cn } from "../lib/utils";
import { DEPARTMENT_LABELS, AGENT_ROLE_LABELS, type Agent } from "@ironworksai/shared";
import { exportToCSV } from "../lib/exportCSV";

const departmentLabels = DEPARTMENT_LABELS as Record<string, string>;
const roleLabels = AGENT_ROLE_LABELS as Record<string, string>;

/* ---- Pipeline columns ---- */

type PipelineStage = "requested" | "approved" | "created" | "onboarded";

const PIPELINE_STAGES: PipelineStage[] = ["requested", "approved", "created", "onboarded"];
const PIPELINE_LABELS: Record<PipelineStage, string> = {
  requested: "Requested",
  approved: "Approved",
  created: "Created",
  onboarded: "Onboarded",
};
const PIPELINE_COLORS: Record<PipelineStage, string> = {
  requested: "bg-amber-500/10 border-amber-500/30",
  approved: "bg-blue-500/10 border-blue-500/30",
  created: "bg-violet-500/10 border-violet-500/30",
  onboarded: "bg-emerald-500/10 border-emerald-500/30",
};
const PIPELINE_DOT_COLORS: Record<PipelineStage, string> = {
  requested: "bg-amber-500",
  approved: "bg-blue-500",
  created: "bg-violet-500",
  onboarded: "bg-emerald-500",
};

function mapStatusToStage(status: string): PipelineStage {
  switch (status) {
    case "pending":
    case "pending_approval":
      return "requested";
    case "approved":
      return "approved";
    case "fulfilled":
      return "created";
    case "onboarded":
    case "completed":
      return "onboarded";
    default:
      return "requested";
  }
}

/* ---- Onboarding checklist ---- */

interface ChecklistItem {
  id: string;
  label: string;
  done: boolean;
}

function generateOnboardingChecklist(agent: Agent | undefined, request: HiringRequest): ChecklistItem[] {
  const role = request.role || "agent";
  const items: ChecklistItem[] = [
    { id: "soul", label: "Configure SOUL.md personality and directives", done: !!agent },
    { id: "adapter", label: "Set up LLM adapter and model", done: !!agent?.adapterType },
    { id: "channel", label: "Assign to communication channel", done: false },
    { id: "permissions", label: "Grant required permissions", done: false },
    { id: "first-task", label: "Assign first task/issue", done: false },
  ];

  if (role === "engineer" || role === "cto") {
    items.push({ id: "repo", label: "Grant repository access", done: false });
    items.push({ id: "ci", label: "Add to CI/CD pipeline", done: false });
  }
  if (role === "cfo" || role === "accountant") {
    items.push({ id: "budget", label: "Configure budget access", done: false });
  }
  if (role === "cmo" || role === "marketer") {
    items.push({ id: "brand", label: "Upload brand guidelines", done: false });
  }

  return items;
}

/* ---- Component ---- */

export function Hiring() {
  const { selectedCompanyId } = useCompany();
  const { openHireAgent } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Hiring" }]);
  }, [setBreadcrumbs]);

  const { data: hiringRequests, isLoading } = useQuery({
    queryKey: queryKeys.hiring.list(selectedCompanyId!),
    queryFn: () => hiringApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentMap = useMemo(() => {
    const m = new Map<string, Agent>();
    for (const a of agents ?? []) m.set(a.id, a);
    return m;
  }, [agents]);

  // Pipeline data
  const pipeline = useMemo(() => {
    const stages: Record<PipelineStage, HiringRequest[]> = {
      requested: [],
      approved: [],
      created: [],
      onboarded: [],
    };
    for (const req of hiringRequests ?? []) {
      const stage = mapStatusToStage(req.status);
      stages[stage].push(req);
    }
    return stages;
  }, [hiringRequests]);

  // Headcount by department
  const headcountByDept = useMemo(() => {
    const depts = new Map<string, { current: number; planned: number }>();
    for (const a of agents ?? []) {
      const dept = (a as unknown as Record<string, unknown>).department as string | undefined ?? "unassigned";
      if (!depts.has(dept)) depts.set(dept, { current: 0, planned: 0 });
      depts.get(dept)!.current++;
    }
    for (const req of hiringRequests ?? []) {
      if (req.status === "pending" || req.status === "pending_approval" || req.status === "approved") {
        const dept = req.department ?? "unassigned";
        if (!depts.has(dept)) depts.set(dept, { current: 0, planned: 0 });
        depts.get(dept)!.planned++;
      }
    }
    return Array.from(depts.entries())
      .map(([dept, counts]) => ({ dept, ...counts }))
      .sort((a, b) => (b.current + b.planned) - (a.current + a.planned));
  }, [agents, hiringRequests]);

  if (!selectedCompanyId) {
    return <EmptyState icon={UserPlus} message="Select a company to view hiring." />;
  }

  if (isLoading) return <PageSkeleton variant="list" />;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Hiring</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Manage hiring pipeline, onboarding, and headcount planning.
          </p>
        </div>
        <Button size="sm" onClick={() => openHireAgent()}>
          <UserPlus className="mr-1.5 h-3.5 w-3.5" />
          New Hire Request
        </Button>
      </div>

      {/* Pipeline Kanban */}
      <div className="rounded-xl border border-border p-4 space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
          <Briefcase className="h-3.5 w-3.5" />
          Hiring Pipeline
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {PIPELINE_STAGES.map((stage) => (
            <div key={stage} className={cn("rounded-lg border p-3 space-y-2 min-h-[120px]", PIPELINE_COLORS[stage])}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className={cn("h-2 w-2 rounded-full", PIPELINE_DOT_COLORS[stage])} />
                  <span className="text-xs font-semibold uppercase tracking-wide">{PIPELINE_LABELS[stage]}</span>
                </div>
                <span className="text-xs font-bold tabular-nums text-muted-foreground">{pipeline[stage].length}</span>
              </div>
              <div className="space-y-1.5">
                {pipeline[stage].length === 0 ? (
                  <p className="text-xs text-muted-foreground/50 py-2 text-center">No requests</p>
                ) : (
                  pipeline[stage].map((req) => (
                    <div
                      key={req.id}
                      className="bg-card rounded-md border border-border/50 px-2.5 py-2 cursor-pointer hover:border-foreground/20 transition-colors"
                      onClick={() => setExpandedId(expandedId === req.id ? null : req.id)}
                    >
                      <div className="text-sm font-medium truncate">{req.title}</div>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span className="text-[10px] text-muted-foreground">
                          {roleLabels[req.role] ?? req.role}
                        </span>
                        {req.department && (
                          <>
                            <span className="text-[10px] text-muted-foreground/40">-</span>
                            <span className="text-[10px] text-muted-foreground">
                              {departmentLabels[req.department] ?? req.department}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Onboarding Checklist for recently created agents */}
      {(hiringRequests ?? []).filter((r) => mapStatusToStage(r.status) === "created" || mapStatusToStage(r.status) === "onboarded").length > 0 && (
        <div className="rounded-xl border border-border p-4 space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Onboarding Checklists
          </h3>
          <div className="space-y-3">
            {(hiringRequests ?? [])
              .filter((r) => mapStatusToStage(r.status) === "created" || mapStatusToStage(r.status) === "onboarded")
              .slice(0, 5)
              .map((req) => {
                const agent = req.fulfilledAgentId ? agentMap.get(req.fulfilledAgentId) : undefined;
                const checklist = generateOnboardingChecklist(agent, req);
                const doneCount = checklist.filter((c) => c.done).length;
                const isExpanded = expandedId === req.id;
                return (
                  <div key={req.id} className="rounded-lg border border-border bg-muted/20 overflow-hidden">
                    <button
                      className="w-full flex items-center justify-between px-3 py-2.5 text-left hover:bg-accent/10 transition-colors"
                      onClick={() => setExpandedId(isExpanded ? null : req.id)}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-sm font-medium truncate">{req.title}</span>
                        {agent && (
                          <span className="text-xs text-muted-foreground shrink-0">- {agent.name}</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <div className="w-16 h-1.5 bg-muted rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full bg-emerald-500"
                            style={{ width: `${(doneCount / checklist.length) * 100}%` }}
                          />
                        </div>
                        <span className="text-xs text-muted-foreground tabular-nums">{doneCount}/{checklist.length}</span>
                      </div>
                    </button>
                    {isExpanded && (
                      <div className="px-3 pb-3 space-y-1.5 border-t border-border/50 pt-2">
                        {checklist.map((item) => (
                          <div key={item.id} className="flex items-center gap-2 text-sm">
                            <span className={cn(
                              "h-4 w-4 rounded border flex items-center justify-center shrink-0",
                              item.done ? "bg-emerald-500/20 border-emerald-500/40" : "border-border",
                            )}>
                              {item.done && <CheckCircle2 className="h-3 w-3 text-emerald-400" />}
                            </span>
                            <span className={item.done ? "text-muted-foreground line-through" : ""}>{item.label}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        </div>
      )}

      {/* Headcount Planning */}
      <div className="rounded-xl border border-border p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
            <Users className="h-3.5 w-3.5" />
            Headcount Planning
          </h3>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              exportToCSV(
                headcountByDept.map((r) => ({
                  department: departmentLabels[r.dept] ?? r.dept,
                  current: r.current,
                  planned: r.planned,
                  total: r.current + r.planned,
                })),
                "headcount-plan",
                [
                  { key: "department", label: "Department" },
                  { key: "current", label: "Current" },
                  { key: "planned", label: "Planned" },
                  { key: "total", label: "Total" },
                ],
              );
            }}
          >
            Export CSV
          </Button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Department</th>
                <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">Current</th>
                <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">Planned</th>
                <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {headcountByDept.map((row) => (
                <tr key={row.dept} className="hover:bg-accent/30 transition-colors">
                  <td className="px-4 py-2.5 font-medium">{departmentLabels[row.dept] ?? row.dept}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{row.current}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    {row.planned > 0 ? (
                      <span className="text-blue-400">+{row.planned}</span>
                    ) : (
                      <span className="text-muted-foreground/40">0</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-semibold">{row.current + row.planned}</td>
                </tr>
              ))}
              {headcountByDept.length > 0 && (
                <tr className="bg-muted/20 font-semibold">
                  <td className="px-4 py-2.5">Total</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{headcountByDept.reduce((s, r) => s + r.current, 0)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-blue-400">
                    +{headcountByDept.reduce((s, r) => s + r.planned, 0)}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    {headcountByDept.reduce((s, r) => s + r.current + r.planned, 0)}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {headcountByDept.length === 0 && (
          <p className="text-sm text-muted-foreground py-4 text-center">No agents or hiring requests yet.</p>
        )}
      </div>
    </div>
  );
}
