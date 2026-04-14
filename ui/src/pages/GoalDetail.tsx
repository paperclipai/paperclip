import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { goalsApi } from "../api/goals";
import { activityApi } from "../api/activity";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { assetsApi } from "../api/assets";
import { goalProgressApi } from "../api/goalProgress";
import { goalKeyResultsApi } from "../api/goalKeyResults";
import { goalCheckInsApi } from "../api/goalCheckIns";
import { goalSnapshotsApi } from "../api/goalSnapshots";
import { usePanel } from "../context/PanelContext";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { GoalProperties } from "../components/GoalProperties";
import { InlineEditor } from "../components/InlineEditor";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { AlertTriangle, CopyPlus, PanelRightClose, PanelRightOpen } from "lucide-react";
import { cn } from "../lib/utils";
import { useNavigate } from "@/lib/router";
import { useToast } from "../context/ToastContext";
import type { Issue } from "@ironworksai/shared";

import { evaluateSmart, SmartQualityIndicator } from "../components/goal-detail/SmartQualityIndicator";
import { CelebrationOverlay } from "../components/goal-detail/CelebrationOverlay";
import { GoalBurnupChart } from "../components/goal-detail/GoalBurnupChart";
import { GoalBurndownChart } from "../components/goal-detail/GoalBurndownChart";
import { GoalHealthBadge, HealthTrendChart } from "../components/goal-detail/GoalHealthBadge";
import { calculateGoalRisk, riskColors } from "../components/goal-detail/GoalRiskAssessment";
import { RaciDisplay } from "../components/goal-detail/RaciDisplay";
import { useMilestones, MilestonesSection } from "../components/goal-detail/MilestonesSection";
import { AgentContributionSection } from "../components/goal-detail/AgentContributionSection";
import { GoalProgressBar } from "../components/goal-detail/GoalProgressBar";
import { GoalTabsSection } from "../components/goal-detail/GoalTabsSection";
import { StatusBadge } from "../components/StatusBadge";

export function GoalDetail() {
  const { goalId } = useParams<{ goalId: string }>();
  const { selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { openNewGoal, openNewIssue } = useDialog();
  const { openPanel, closePanel } = usePanel();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pushToast } = useToast();
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

  const { data: allIssues } = useQuery({
    queryKey: queryKeys.issues.list(resolvedCompanyId!),
    queryFn: () => issuesApi.list(resolvedCompanyId!),
    enabled: !!resolvedCompanyId,
  });

  const goalIssues = (allIssues ?? []).filter((i: Issue) => i.goalId === goalId);

  const goalIssueIds = new Set(goalIssues.map((i: Issue) => i.id));
  const { data: allActivity } = useQuery({
    queryKey: queryKeys.activity(resolvedCompanyId!),
    queryFn: () => activityApi.list(resolvedCompanyId!),
    enabled: !!resolvedCompanyId,
    staleTime: 30_000,
  });
  const { data: allAgents } = useQuery({
    queryKey: queryKeys.agents.list(resolvedCompanyId!),
    queryFn: () => agentsApi.list(resolvedCompanyId!),
    enabled: !!resolvedCompanyId,
  });
  const goalActivity = (allActivity ?? []).filter((e) =>
    (e.entityType === "issue" && goalIssueIds.has(e.entityId)) ||
    (e.entityType === "goal" && e.entityId === goalId)
  ).slice(0, 30);
  const agentMap = useMemo(() => {
    const map = new Map<string, import("@ironworksai/shared").Agent>();
    for (const a of allAgents ?? []) map.set(a.id, a);
    return map;
  }, [allAgents]);
  const entityNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of allIssues ?? []) map.set(`issue:${i.id}`, (i as Issue).identifier ?? i.id.slice(0, 8));
    if (goal) map.set(`goal:${goal.id}`, goal.title);
    return map;
  }, [allIssues, goal]);
  const entityTitleMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of allIssues ?? []) map.set(`issue:${i.id}`, i.title);
    return map;
  }, [allIssues]);

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

  // Check-ins
  const { data: checkIns } = useQuery({
    queryKey: queryKeys.goals.checkIns(resolvedCompanyId!, goalId!),
    queryFn: () => goalCheckInsApi.list(resolvedCompanyId!, goalId!),
    enabled: !!resolvedCompanyId && !!goalId,
  });

  const createCheckIn = useMutation({
    mutationFn: (data: import("../api/goalCheckIns").CreateCheckInPayload) =>
      goalCheckInsApi.create(resolvedCompanyId!, goalId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.goals.checkIns(resolvedCompanyId!, goalId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.goals.detail(goalId!) });
    },
  });

  // Snapshots (for trend chart)
  const { data: snapshots } = useQuery({
    queryKey: queryKeys.goals.snapshots(resolvedCompanyId!, goalId!),
    queryFn: () => goalSnapshotsApi.list(resolvedCompanyId!, goalId!, 30),
    enabled: !!resolvedCompanyId && !!goalId,
  });

  // Milestones (localStorage)
  const milestonesHook = useMilestones(goalId!);

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

  const cloneGoal = useMutation({
    mutationFn: async () => {
      if (!goal || !resolvedCompanyId) throw new Error("No goal to clone");
      return goalsApi.create(resolvedCompanyId, {
        title: `${goal.title} (Copy)`,
        description: goal.description,
        level: goal.level,
        status: "planned",
        parentId: goal.parentId,
        targetDate: goal.targetDate,
      });
    },
    onSuccess: (cloned) => {
      pushToast({ title: `Goal cloned as "${cloned.title}"`, tone: "success" });
      if (resolvedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.goals.list(resolvedCompanyId) });
      }
      navigate(`/goals/${cloned.id}`);
    },
    onError: () => {
      pushToast({ title: "Failed to clone goal", tone: "error" });
    },
  });

  const riskAssessment = useMemo(
    () => calculateGoalRisk(goalIssues, goal?.targetDate ?? null),
    [goalIssues, goal?.targetDate],
  );

  const smartCriteria = useMemo(
    () => goal ? evaluateSmart(goal, (keyResults ?? []).length) : null,
    [goal, keyResults],
  );

  const parentGoal = useMemo(
    () => goal?.parentId ? (allGoals ?? []).find((g) => g.id === goal.parentId) ?? null : null,
    [goal?.parentId, allGoals],
  );

  // Celebration on achievement
  const [showCelebration, setShowCelebration] = useState(false);
  const prevStatusRef = useRef<string | null>(null);
  useEffect(() => {
    if (!goal) return;
    if (prevStatusRef.current && prevStatusRef.current !== "achieved" && goal.status === "achieved") {
      setShowCelebration(true);
      pushToast({ title: `Goal achieved: ${goal.title}`, tone: "success" });
      const timer = setTimeout(() => setShowCelebration(false), 2000);
      return () => clearTimeout(timer);
    }
    prevStatusRef.current = goal.status;
  }, [goal?.status]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const toggleTwoPane = useCallback(() => {
    setTwoPane((prev) => {
      const next = !prev;
      try { localStorage.setItem("ironworks:goal-two-pane", String(next)); } catch {}
      return next;
    });
  }, []);

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!goal) return null;

  return (
    <div className={cn(twoPane ? "grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6" : "")}>
      <CelebrationOverlay show={showCelebration} />
      <div className="space-y-6">
        {/* Header */}
        <div className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs uppercase text-muted-foreground">
              {goal.level}
            </span>
            <StatusBadge status={goal.status} />
            <GoalHealthBadge status={goal.healthStatus} />
            {smartCriteria && <SmartQualityIndicator criteria={smartCriteria} />}
            <Button
              variant="outline"
              size="sm"
              onClick={() => cloneGoal.mutate()}
              disabled={cloneGoal.isPending}
              className="ml-auto"
            >
              <CopyPlus className="h-3.5 w-3.5 mr-1" />
              {cloneGoal.isPending ? "Cloning..." : "Clone Goal"}
            </Button>
            <button
              onClick={toggleTwoPane}
              className="hidden text-muted-foreground hover:text-foreground transition-colors lg:inline-flex"
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

        {/* Risk Assessment */}
        {goalIssues.length > 0 && (
          <div className={cn("rounded-lg border p-3 flex items-center gap-3", riskColors[riskAssessment.level])}>
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide">Risk: {riskAssessment.level}</span>
              </div>
              <p className="text-xs mt-0.5">{riskAssessment.description}</p>
            </div>
            <div className="text-right text-xs shrink-0">
              <div>{riskAssessment.totalIssues} missions</div>
              {riskAssessment.blockedPercent > 0 && <div>{riskAssessment.blockedPercent}% blocked</div>}
            </div>
          </div>
        )}

        {/* RACI Co-ownership */}
        <RaciDisplay goal={goal} agentMap={agentMap} parentGoal={parentGoal} />

        {/* Burnup Chart (5+ issues) */}
        {goalIssues.length >= 5 && (
          <GoalBurnupChart issues={goalIssues} targetDate={goal.targetDate ?? null} startDate={goal.startDate ?? null} />
        )}

        {/* Burndown Chart */}
        {goalIssues.length > 0 && (
          <GoalBurndownChart issues={goalIssues} targetDate={goal.targetDate ?? null} />
        )}

        {/* Progress bar */}
        {progress && <GoalProgressBar progress={progress} />}

        {/* Tabs */}
        <GoalTabsSection
          goal={goal}
          goalId={goalId!}
          goalIssues={goalIssues}
          keyResults={keyResults}
          childGoals={childGoals}
          linkedProjects={linkedProjects}
          checkIns={checkIns}
          goalActivity={goalActivity}
          agentMap={agentMap}
          entityNameMap={entityNameMap}
          entityTitleMap={entityTitleMap}
          showKrForm={showKrForm}
          setShowKrForm={setShowKrForm}
          krDescription={krDescription}
          setKrDescription={setKrDescription}
          krTarget={krTarget}
          setKrTarget={setKrTarget}
          krUnit={krUnit}
          setKrUnit={setKrUnit}
          editingKrId={editingKrId}
          setEditingKrId={setEditingKrId}
          editingKrValue={editingKrValue}
          setEditingKrValue={setEditingKrValue}
          isCreatingKr={createKeyResult.isPending}
          onCreateKr={() => {
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
          onUpdateKrValue={(krId, value) => updateKeyResult.mutate({ krId, data: { currentValue: value } })}
          onDeleteKr={(krId) => deleteKeyResult.mutate(krId)}
          isCreatingCheckIn={createCheckIn.isPending}
          onCreateCheckIn={(data) => createCheckIn.mutate(data)}
          onOpenNewIssue={openNewIssue}
          onOpenNewGoal={openNewGoal}
        />

        {/* Milestones Section */}
        <MilestonesSection milestonesHook={milestonesHook} />

        {/* Health Trend Chart */}
        {snapshots && snapshots.length >= 2 && (
          <HealthTrendChart snapshots={snapshots} />
        )}

        {/* Agent Contributions */}
        <AgentContributionSection issues={goalIssues} agentMap={agentMap} />
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
