import { useEffect, useState } from "react";
import { useParams } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { goalsApi } from "../api/goals";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { assetsApi } from "../api/assets";
import { goalProgressApi } from "../api/goalProgress";
import { goalKeyResultsApi, type GoalKeyResult } from "../api/goalKeyResults";
import { usePanel } from "../context/PanelContext";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { GoalProperties } from "../components/GoalProperties";
import { GoalTree } from "../components/GoalTree";
import { StatusBadge } from "../components/StatusBadge";
import { InlineEditor } from "../components/InlineEditor";
import { EntityRow } from "../components/EntityRow";
import { PageSkeleton } from "../components/PageSkeleton";
import { projectUrl } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CheckCircle2, Circle, Loader2, PanelRightClose, PanelRightOpen, Plus, ShieldAlert, Target, Trash2 } from "lucide-react";
import { cn } from "../lib/utils";
import type { Goal, Issue, Project } from "@ironworksai/shared";

/* ── Burndown Chart ── */

function GoalBurndownChart({ issues, targetDate }: { issues: Issue[]; targetDate: string | null }) {
  const total = issues.length;
  if (total === 0) return null;

  // Build completion timeline: sorted list of completion dates
  const completedIssues = issues
    .filter((i) => (i.status === "done" || i.status === "cancelled") && i.completedAt)
    .map((i) => new Date(i.completedAt!).getTime())
    .sort((a, b) => a - b);

  // Determine date range
  const createdDates = issues.map((i) => new Date(i.createdAt).getTime());
  const startDate = Math.min(...createdDates);
  const now = Date.now();
  const endDate = targetDate ? Math.max(new Date(targetDate).getTime(), now) : now;
  const range = endDate - startDate || 1;

  // Build stepped actual burndown points
  const actualPoints: Array<{ x: number; y: number }> = [{ x: 0, y: total }];
  let remaining = total;
  for (const ts of completedIssues) {
    remaining--;
    const x = ((ts - startDate) / range) * 100;
    actualPoints.push({ x: Math.min(100, Math.max(0, x)), y: remaining });
  }
  // Extend to current time
  const nowX = ((now - startDate) / range) * 100;
  actualPoints.push({ x: Math.min(100, nowX), y: remaining });

  // Build SVG path for actual line (stepped)
  const actualPath = actualPoints
    .map((p, i) => {
      if (i === 0) return `M ${p.x * 3.6} ${(1 - p.y / total) * 80 + 10}`;
      const prev = actualPoints[i - 1];
      return `L ${p.x * 3.6} ${(1 - prev.y / total) * 80 + 10} L ${p.x * 3.6} ${(1 - p.y / total) * 80 + 10}`;
    })
    .join(" ");

  // Ideal line: from (0, total) to (100%, 0)
  const idealPath = "M 0 10 L 360 90";

  const startLabel = new Date(startDate).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const endLabel = targetDate
    ? new Date(targetDate).toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : "Now";

  return (
    <div className="rounded-xl border border-border p-4 space-y-2">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Burndown</h4>
      <svg viewBox="0 0 360 110" className="w-full" preserveAspectRatio="xMidYMid meet">
        {/* Grid lines */}
        <line x1="0" y1="10" x2="360" y2="10" className="stroke-muted/30" strokeWidth="0.5" />
        <line x1="0" y1="50" x2="360" y2="50" className="stroke-muted/30" strokeWidth="0.5" />
        <line x1="0" y1="90" x2="360" y2="90" className="stroke-muted/30" strokeWidth="0.5" />

        {/* Y-axis labels */}
        <text x="2" y="8" className="fill-muted-foreground text-[7px]">{total}</text>
        <text x="2" y="94" className="fill-muted-foreground text-[7px]">0</text>

        {/* Ideal line (dashed) */}
        {targetDate && (
          <path d={idealPath} fill="none" className="stroke-muted-foreground/40" strokeWidth="1" strokeDasharray="4 3" />
        )}

        {/* Actual burndown */}
        <path d={actualPath} fill="none" className="stroke-blue-500" strokeWidth="2" />

        {/* X-axis labels */}
        <text x="2" y="106" className="fill-muted-foreground text-[7px]">{startLabel}</text>
        <text x="358" y="106" textAnchor="end" className="fill-muted-foreground text-[7px]">{endLabel}</text>
      </svg>
      <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="h-0.5 w-3 bg-blue-500 shrink-0" />
          Actual
        </span>
        {targetDate && (
          <span className="flex items-center gap-1">
            <span className="h-0.5 w-3 bg-muted-foreground/40 shrink-0" />
            Ideal
          </span>
        )}
        <span className="ml-auto">{total - remaining}/{total} done</span>
      </div>
    </div>
  );
}

export function GoalDetail() {
  const { goalId } = useParams<{ goalId: string }>();
  const { selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { openNewGoal } = useDialog();
  const { openPanel, closePanel } = usePanel();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [twoPane, setTwoPane] = useState(() => {
    try { return localStorage.getItem("ironworks:goal-two-pane") === "true"; } catch { return false; }
  });

  const {
    data: goal,
    isLoading,
    error
  } = useQuery({
    queryKey: queryKeys.goals.detail(goalId!),
    queryFn: () => goalsApi.get(goalId!),
    enabled: !!goalId
  });
  const resolvedCompanyId = goal?.companyId ?? selectedCompanyId;

  const { data: allGoals } = useQuery({
    queryKey: queryKeys.goals.list(resolvedCompanyId!),
    queryFn: () => goalsApi.list(resolvedCompanyId!),
    enabled: !!resolvedCompanyId
  });

  const { data: allProjects } = useQuery({
    queryKey: queryKeys.projects.list(resolvedCompanyId!),
    queryFn: () => projectsApi.list(resolvedCompanyId!),
    enabled: !!resolvedCompanyId
  });

  // Issues linked to this goal
  const { data: allIssues } = useQuery({
    queryKey: queryKeys.issues.list(resolvedCompanyId!),
    queryFn: () => issuesApi.list(resolvedCompanyId!),
    enabled: !!resolvedCompanyId,
  });

  const goalIssues = (allIssues ?? []).filter((i: Issue) => i.goalId === goalId);

  // Key Results
  const { data: keyResults } = useQuery({
    queryKey: queryKeys.goals.keyResults(resolvedCompanyId!, goalId!),
    queryFn: () => goalKeyResultsApi.list(resolvedCompanyId!, goalId!),
    enabled: !!resolvedCompanyId && !!goalId,
  });

  const createKeyResult = useMutation({
    mutationFn: (data: { description: string; targetValue?: string; unit?: string }) =>
      goalKeyResultsApi.create(resolvedCompanyId!, goalId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.goals.keyResults(resolvedCompanyId!, goalId!) });
    },
  });

  const updateKeyResult = useMutation({
    mutationFn: ({ krId, data }: { krId: string; data: { currentValue?: string; description?: string } }) =>
      goalKeyResultsApi.update(resolvedCompanyId!, goalId!, krId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.goals.keyResults(resolvedCompanyId!, goalId!) });
    },
  });

  const deleteKeyResult = useMutation({
    mutationFn: (krId: string) =>
      goalKeyResultsApi.remove(resolvedCompanyId!, goalId!, krId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.goals.keyResults(resolvedCompanyId!, goalId!) });
    },
  });

  const [showKrForm, setShowKrForm] = useState(false);
  const [krDescription, setKrDescription] = useState("");
  const [krTarget, setKrTarget] = useState("100");
  const [krUnit, setKrUnit] = useState("%");
  const [editingKrId, setEditingKrId] = useState<string | null>(null);
  const [editingKrValue, setEditingKrValue] = useState("");

  // Goal progress stats
  const { data: progress } = useQuery({
    queryKey: ["goals", "progress-detail", goalId],
    queryFn: () => goalProgressApi.detail(goalId!),
    enabled: !!goalId,
  });

  useEffect(() => {
    if (!goal?.companyId || goal.companyId === selectedCompanyId) return;
    setSelectedCompanyId(goal.companyId, { source: "route_sync" });
  }, [goal?.companyId, selectedCompanyId, setSelectedCompanyId]);

  const updateGoal = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      goalsApi.update(goalId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.goals.detail(goalId!)
      });
      if (resolvedCompanyId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.goals.list(resolvedCompanyId)
        });
      }
    }
  });

  const uploadImage = useMutation({
    mutationFn: async (file: File) => {
      if (!resolvedCompanyId) throw new Error("No company selected");
      return assetsApi.uploadImage(
        resolvedCompanyId,
        file,
        `goals/${goalId ?? "draft"}`
      );
    }
  });

  const childGoals = (allGoals ?? []).filter((g) => g.parentId === goalId);
  const linkedProjects = (allProjects ?? []).filter((p) => {
    if (!goalId) return false;
    if (p.goalIds.includes(goalId)) return true;
    if (p.goals.some((goalRef) => goalRef.id === goalId)) return true;
    return p.goalId === goalId;
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Goals", href: "/goals" },
      { label: goal?.title ?? goalId ?? "Goal" }
    ]);
  }, [setBreadcrumbs, goal, goalId]);

  useEffect(() => {
    if (twoPane) {
      closePanel();
      return;
    }
    if (goal) {
      openPanel(
        <GoalProperties
          goal={goal}
          onUpdate={(data) => updateGoal.mutate(data)}
        />
      );
    }
    return () => closePanel();
  }, [goal, twoPane]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleTwoPane = () => {
    setTwoPane((prev) => {
      const next = !prev;
      try { localStorage.setItem("ironworks:goal-two-pane", String(next)); } catch {}
      return next;
    });
  };

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!goal) return null;

  return (
    <div className={cn(twoPane ? "grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6" : "")}>
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase text-muted-foreground">
            {goal.level}
          </span>
          <StatusBadge status={goal.status} />
          <button
            onClick={toggleTwoPane}
            className="ml-auto hidden text-muted-foreground hover:text-foreground transition-colors lg:inline-flex"
            title={twoPane ? "Hide properties panel" : "Show properties panel"}
          >
            {twoPane ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
          </button>
        </div>

        <InlineEditor
          value={goal.title}
          onSave={(title) => updateGoal.mutate({ title })}
          as="h2"
          className="text-xl font-bold"
        />

        <InlineEditor
          value={goal.description ?? ""}
          onSave={(description) => updateGoal.mutate({ description })}
          as="p"
          className="text-sm text-muted-foreground"
          placeholder="Add a description..."
          multiline
          imageUploadHandler={async (file) => {
            const asset = await uploadImage.mutateAsync(file);
            return asset.contentPath;
          }}
        />
      </div>

      {/* Burndown Chart */}
      {goalIssues.length > 0 && (
        <GoalBurndownChart issues={goalIssues} targetDate={goal.targetDate ?? null} />
      )}

      {/* Progress bar */}
      {progress && progress.totalIssues > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Progress</span>
            <span className="font-medium">{progress.completedIssues}/{progress.totalIssues} issues done ({progress.progressPercent}%)</span>
          </div>
          <div className="h-2 bg-muted rounded-full overflow-hidden">
            <div
              className={cn(
                "h-full rounded-full transition-[width] duration-300",
                progress.progressPercent === 100 ? "bg-emerald-500" : progress.progressPercent > 50 ? "bg-blue-500" : "bg-amber-500",
              )}
              style={{ width: `${progress.progressPercent}%` }}
            />
          </div>
          <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
            {progress.completedIssues > 0 && (
              <span className="flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-emerald-500" />{progress.completedIssues} done</span>
            )}
            {progress.inProgressIssues > 0 && (
              <span className="flex items-center gap-1"><Loader2 className="h-3 w-3 text-blue-500" />{progress.inProgressIssues} active</span>
            )}
            {progress.blockedIssues > 0 && (
              <span className="flex items-center gap-1"><ShieldAlert className="h-3 w-3 text-red-500" />{progress.blockedIssues} blocked</span>
            )}
            {progress.todoIssues > 0 && (
              <span className="flex items-center gap-1"><Circle className="h-3 w-3" />{progress.todoIssues} pending</span>
            )}
          </div>
        </div>
      )}

      <Tabs defaultValue={goalIssues.length > 0 ? "issues" : "children"}>
        <TabsList>
          <TabsTrigger value="issues">
            Issues ({goalIssues.length})
          </TabsTrigger>
          <TabsTrigger value="key-results">
            Key Results ({(keyResults ?? []).length})
          </TabsTrigger>
          <TabsTrigger value="children">
            Sub-Goals ({childGoals.length})
          </TabsTrigger>
          <TabsTrigger value="projects">
            Projects ({linkedProjects.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="issues" className="mt-4 space-y-3">
          {goalIssues.length === 0 ? (
            <p className="text-sm text-muted-foreground">No issues linked to this goal yet.</p>
          ) : (
            <div className="border border-border rounded-lg divide-y divide-border">
              {goalIssues.map((issue: Issue) => (
                <EntityRow
                  key={issue.id}
                  title={issue.title}
                  subtitle={issue.identifier ?? undefined}
                  to={`/issues/${issue.identifier ?? issue.id}`}
                  trailing={
                    <div className="flex items-center gap-2">
                      <StatusBadge status={issue.status} />
                    </div>
                  }
                />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="key-results" className="mt-4 space-y-3">
          <div className="flex items-center justify-start">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowKrForm(true)}
            >
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              Add Key Result
            </Button>
          </div>

          {showKrForm && (
            <div className="border border-border rounded-lg p-3 space-y-2">
              <Input
                placeholder="Key result description..."
                value={krDescription}
                onChange={(e) => setKrDescription(e.target.value)}
                autoFocus
              />
              <div className="flex items-center gap-2">
                <Input
                  placeholder="Target"
                  type="number"
                  inputMode="decimal"
                  value={krTarget}
                  onChange={(e) => setKrTarget(e.target.value)}
                  className="w-24"
                />
                <Input
                  placeholder="Unit"
                  value={krUnit}
                  onChange={(e) => setKrUnit(e.target.value)}
                  className="w-20"
                />
                <Button
                  size="sm"
                  disabled={!krDescription.trim() || createKeyResult.isPending}
                  onClick={() => {
                    createKeyResult.mutate(
                      { description: krDescription, targetValue: krTarget, unit: krUnit },
                      {
                        onSuccess: () => {
                          setKrDescription("");
                          setKrTarget("100");
                          setKrUnit("%");
                          setShowKrForm(false);
                        },
                      },
                    );
                  }}
                >
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => { setShowKrForm(false); setKrDescription(""); }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {(keyResults ?? []).length === 0 && !showKrForm ? (
            <p className="text-sm text-muted-foreground">No key results defined yet.</p>
          ) : (
            <div className="space-y-2">
              {(keyResults ?? []).map((kr: GoalKeyResult) => {
                const target = Number(kr.targetValue) || 100;
                const current = Number(kr.currentValue) || 0;
                const pct = target > 0 ? Math.min(100, Math.round((current / target) * 100)) : 0;

                return (
                  <div key={kr.id} className="border border-border rounded-lg p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Target className="h-4 w-4 text-muted-foreground" />
                        <span className="text-sm font-medium">{kr.description}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        {editingKrId === kr.id ? (
                          <div className="flex items-center gap-1">
                            <Input
                              type="number"
                              inputMode="decimal"
                              value={editingKrValue}
                              onChange={(e) => setEditingKrValue(e.target.value)}
                              className="w-20 h-7 text-xs"
                              autoFocus
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  updateKeyResult.mutate({ krId: kr.id, data: { currentValue: editingKrValue } });
                                  setEditingKrId(null);
                                }
                                if (e.key === "Escape") setEditingKrId(null);
                              }}
                            />
                            <span className="text-xs text-muted-foreground">/ {kr.targetValue} {kr.unit}</span>
                          </div>
                        ) : (
                          <button
                            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                            onClick={() => { setEditingKrId(kr.id); setEditingKrValue(kr.currentValue); }}
                          >
                            {current} / {kr.targetValue} {kr.unit} ({pct}%)
                          </button>
                        )}
                        <button
                          className="text-muted-foreground hover:text-destructive transition-colors"
                          onClick={() => deleteKeyResult.mutate(kr.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                    <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                      <div
                        className={cn(
                          "h-full rounded-full transition-[width] duration-300",
                          pct === 100 ? "bg-emerald-500" : pct > 50 ? "bg-blue-500" : "bg-amber-500",
                        )}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </TabsContent>

        <TabsContent value="children" className="mt-4 space-y-3">
          <div className="flex items-center justify-start">
            <Button
              size="sm"
              variant="outline"
              onClick={() => openNewGoal({ parentId: goalId })}
            >
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              Sub Goal
            </Button>
          </div>
          {childGoals.length === 0 ? (
            <p className="text-sm text-muted-foreground">No sub-goals.</p>
          ) : (
            <GoalTree goals={childGoals} goalLink={(g) => `/goals/${g.id}`} />
          )}
        </TabsContent>

        <TabsContent value="projects" className="mt-4">
          {linkedProjects.length === 0 ? (
            <p className="text-sm text-muted-foreground">No linked projects.</p>
          ) : (
            <div className="border border-border">
              {linkedProjects.map((project) => (
                <EntityRow
                  key={project.id}
                  title={project.name}
                  subtitle={project.description ?? undefined}
                  to={projectUrl(project)}
                  trailing={<StatusBadge status={project.status} />}
                />
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
    {twoPane && (
      <div className="hidden lg:block border border-border rounded-lg p-4 h-fit sticky top-4">
        <GoalProperties
          goal={goal}
          onUpdate={(data) => updateGoal.mutate(data)}
        />
      </div>
    )}
    </div>
  );
}
