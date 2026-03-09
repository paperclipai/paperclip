import { useState, useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { companiesApi } from "../api/companies";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatCents, relativeTime } from "../lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Pencil,
  Check,
  X,
  Plus,
  MoreHorizontal,
  Trash2,
  Users,
  CircleDot,
  DollarSign,
  Calendar,
  FolderOpen,
} from "lucide-react";

function systemStatusClasses(status?: string): string {
  if (status === "active") {
    return "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300";
  }
  if (status === "paused") {
    return "bg-amber-500/12 text-amber-700 dark:text-amber-300";
  }
  return "bg-muted text-muted-foreground";
}

export function Companies() {
  const {
    companies,
    selectedCompanyId,
    setSelectedCompanyId,
    loading,
    error,
  } = useCompany();
  const { openOnboarding } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  const { data: stats } = useQuery({
    queryKey: queryKeys.companies.stats,
    queryFn: () => companiesApi.stats(),
  });

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const editMutation = useMutation({
    mutationFn: ({ id, newName }: { id: string; newName: string }) =>
      companiesApi.update(id, { name: newName }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      setEditingId(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => companiesApi.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.stats });
      setConfirmDeleteId(null);
    },
  });

  useEffect(() => {
    setBreadcrumbs([{ label: "Systems" }]);
  }, [setBreadcrumbs]);

  const summary = useMemo(() => {
    const totalSystems = companies.length;
    const activeSystems = companies.filter((company) => company.status === "active").length;
    const totalAgents = companies.reduce(
      (sum, company) => sum + (stats?.[company.id]?.agentCount ?? 0),
      0,
    );
    const totalIssues = companies.reduce(
      (sum, company) => sum + (stats?.[company.id]?.issueCount ?? 0),
      0,
    );
    const trackedBudget = companies.reduce(
      (sum, company) => sum + company.budgetMonthlyCents,
      0,
    );

    return { totalSystems, activeSystems, totalAgents, totalIssues, trackedBudget };
  }, [companies, stats]);

  function startEdit(companyId: string, currentName: string) {
    setEditingId(companyId);
    setEditName(currentName);
  }

  function saveEdit() {
    if (!editingId || !editName.trim()) return;
    editMutation.mutate({ id: editingId, newName: editName.trim() });
  }

  function cancelEdit() {
    setEditingId(null);
    setEditName("");
  }

  return (
    <div className="space-y-6">
      <section className="command-card rounded-[1.7rem] px-5 py-5 sm:px-6 sm:py-6">
        <div className="grid gap-5 xl:grid-cols-[1.2fr_0.95fr]">
          <div>
            <p className="section-kicker">System registry</p>
            <h2 className="editorial-title mt-3 text-[2.25rem] leading-none text-foreground sm:text-[3rem]">
              Systems, prefixes, and budgets on one board.
            </h2>
            <p className="mt-4 max-w-2xl text-sm leading-6 text-muted-foreground">
              Keep the operational map clean here: pick the active system, rename prefixes before they leak into work, and watch whether each environment still has real agent capacity behind it.
            </p>

            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              <div className="command-metric rounded-[1.2rem] px-4 py-4">
                <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Systems</p>
                <p className="mt-2 text-2xl font-semibold text-foreground">{summary.totalSystems}</p>
                <p className="mt-1 text-xs text-muted-foreground">{summary.activeSystems} active</p>
              </div>
              <div className="command-metric rounded-[1.2rem] px-4 py-4">
                <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Fleet</p>
                <p className="mt-2 text-2xl font-semibold text-foreground">{summary.totalAgents}</p>
                <p className="mt-1 text-xs text-muted-foreground">{summary.totalIssues} open issues</p>
              </div>
              <div className="command-metric rounded-[1.2rem] px-4 py-4">
                <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Tracked budget</p>
                <p className="mt-2 text-2xl font-semibold text-foreground">
                  {summary.trackedBudget > 0 ? formatCents(summary.trackedBudget) : "Flexible"}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">Monthly cap across configured systems</p>
              </div>
            </div>
          </div>

          <div className="page-frame rounded-[1.4rem] px-5 py-5">
            <p className="section-kicker">Control notes</p>
            <div className="mt-4 space-y-4 text-sm text-muted-foreground">
              <div className="flex items-start gap-3">
                <Users className="mt-0.5 h-4 w-4 shrink-0 text-[var(--surface-highlight)]" />
                <p>Selecting a system switches the whole board context, including agents, projects, and folder paths.</p>
              </div>
              <div className="flex items-start gap-3">
                <FolderOpen className="mt-0.5 h-4 w-4 shrink-0 text-[var(--surface-highlight)]" />
                <p>Use stable prefixes and names here so routes and linked folders stay readable across every page.</p>
              </div>
            </div>
            <Button size="sm" onClick={() => openOnboarding()} className="mt-5 rounded-full">
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              New System
            </Button>
          </div>
        </div>
      </section>

      <div className="space-y-2">
        {loading && <p className="text-sm text-muted-foreground">Loading systems...</p>}
        {error && <p className="text-sm text-destructive">{error.message}</p>}
      </div>

      <div className="grid gap-4">
        {companies.map((company) => {
          const selected = company.id === selectedCompanyId;
          const isEditing = editingId === company.id;
          const isConfirmingDelete = confirmDeleteId === company.id;
          const companyStats = stats?.[company.id];
          const agentCount = companyStats?.agentCount ?? 0;
          const issueCount = companyStats?.issueCount ?? 0;
          const budgetPct =
            company.budgetMonthlyCents > 0
              ? Math.round((company.spentMonthlyCents / company.budgetMonthlyCents) * 100)
              : 0;

          return (
            <div
              key={company.id}
              role="button"
              tabIndex={0}
              onClick={() => setSelectedCompanyId(company.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setSelectedCompanyId(company.id);
                }
              }}
              className={cn(
                "group page-frame rounded-[1.35rem] p-5 text-left transition-all cursor-pointer",
                selected
                  ? "border-[color:var(--surface-highlight)] shadow-[0_20px_60px_-36px_rgba(178,111,62,0.85)]"
                  : "hover:-translate-y-0.5 hover:border-[color:var(--surface-highlight)]/40",
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  {isEditing ? (
                    <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                      <Input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="h-8 text-sm"
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveEdit();
                          if (e.key === "Escape") cancelEdit();
                        }}
                      />
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={saveEdit}
                        disabled={editMutation.isPending}
                      >
                        <Check className="h-3.5 w-3.5 text-green-500" />
                      </Button>
                      <Button variant="ghost" size="icon-xs" onClick={cancelEdit}>
                        <X className="h-3.5 w-3.5 text-muted-foreground" />
                      </Button>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full border border-border bg-background/60 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                        {company.issuePrefix}
                      </span>
                      <h3 className="text-lg font-semibold text-foreground">{company.name}</h3>
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em]",
                          systemStatusClasses(company.status),
                        )}
                      >
                        {company.status}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="text-muted-foreground opacity-0 group-hover:opacity-100"
                        onClick={(e) => {
                          e.stopPropagation();
                          startEdit(company.id, company.name);
                        }}
                      >
                        <Pencil className="h-3 w-3" />
                      </Button>
                    </div>
                  )}
                  {company.description && !isEditing && (
                    <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground line-clamp-2">
                      {company.description}
                    </p>
                  )}
                </div>

                <div onClick={(e) => e.stopPropagation()}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="text-muted-foreground opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => startEdit(company.id, company.name)}>
                        <Pencil className="h-3.5 w-3.5" />
                        Rename
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => setConfirmDeleteId(company.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Delete System
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>

              <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <div className="command-card-soft rounded-[1rem] px-3 py-3">
                  <div className="flex items-center gap-1.5 text-xs uppercase tracking-[0.16em] text-muted-foreground">
                    <Users className="h-3.5 w-3.5" />
                    Fleet
                  </div>
                  <p className="mt-2 text-sm font-semibold text-foreground">
                    {agentCount} {agentCount === 1 ? "agent" : "agents"}
                  </p>
                </div>
                <div className="command-card-soft rounded-[1rem] px-3 py-3">
                  <div className="flex items-center gap-1.5 text-xs uppercase tracking-[0.16em] text-muted-foreground">
                    <CircleDot className="h-3.5 w-3.5" />
                    Issues
                  </div>
                  <p className="mt-2 text-sm font-semibold text-foreground">
                    {issueCount} {issueCount === 1 ? "issue" : "issues"}
                  </p>
                </div>
                <div className="command-card-soft rounded-[1rem] px-3 py-3">
                  <div className="flex items-center gap-1.5 text-xs uppercase tracking-[0.16em] text-muted-foreground">
                    <DollarSign className="h-3.5 w-3.5" />
                    Spend
                  </div>
                  <p className="mt-2 text-sm font-semibold text-foreground">
                    {formatCents(company.spentMonthlyCents)}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {company.budgetMonthlyCents > 0
                      ? `${formatCents(company.budgetMonthlyCents)} cap · ${budgetPct}% used`
                      : "Unlimited budget"}
                  </p>
                </div>
                <div className="command-card-soft rounded-[1rem] px-3 py-3">
                  <div className="flex items-center gap-1.5 text-xs uppercase tracking-[0.16em] text-muted-foreground">
                    <Calendar className="h-3.5 w-3.5" />
                    Started
                  </div>
                  <p className="mt-2 text-sm font-semibold text-foreground">
                    {relativeTime(company.createdAt)}
                  </p>
                </div>
              </div>

              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border/70 pt-4 text-sm text-muted-foreground">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "h-2.5 w-2.5 rounded-full",
                      selected ? "bg-[var(--surface-highlight)]" : "bg-muted-foreground/40",
                    )}
                  />
                  <span>{selected ? "Current board context" : "Click to make active"}</span>
                </div>
                <span className="text-foreground">{selected ? "Active system" : "Make active"}</span>
              </div>

              {isConfirmingDelete && (
                <div
                  className="mt-4 flex flex-col gap-3 rounded-[1rem] border border-destructive/20 bg-destructive/5 px-4 py-4 sm:flex-row sm:items-center sm:justify-between"
                  onClick={(e) => e.stopPropagation()}
                >
                  <p className="text-sm font-medium text-destructive">
                    Delete this system and all of its data? This cannot be undone.
                  </p>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setConfirmDeleteId(null)}
                      disabled={deleteMutation.isPending}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => deleteMutation.mutate(company.id)}
                      disabled={deleteMutation.isPending}
                    >
                      {deleteMutation.isPending ? "Deleting…" : "Delete"}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
