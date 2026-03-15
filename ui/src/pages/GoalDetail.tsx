import { useEffect } from "react";
import { useParams } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { goalsApi } from "../api/goals";
import { projectsApi } from "../api/projects";
import { assetsApi } from "../api/assets";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Plus } from "lucide-react";
import type { Goal, GoalPlanningHorizon, Project } from "@paperclipai/shared";

const ROADMAP_HORIZON_LABELS: Record<GoalPlanningHorizon, string> = {
  now: "Now",
  next: "Next",
  later: "Later",
};

export function GoalDetail() {
  const { goalId } = useParams<{ goalId: string }>();
  const { selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { openNewGoal } = useDialog();
  const { openPanel, closePanel } = usePanel();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

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
      { label: "Roadmap", href: "/roadmap" },
      { label: goal?.title ?? goalId ?? "Roadmap Item" }
    ]);
  }, [setBreadcrumbs, goal, goalId]);

  useEffect(() => {
    if (goal) {
      openPanel(
        <GoalProperties
          goal={goal}
          onUpdate={(data) => updateGoal.mutate(data)}
        />
      );
    }
    return () => closePanel();
  }, [goal]); // eslint-disable-line react-hooks/exhaustive-deps

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!goal) return null;

  return (
    <div className="space-y-6">
      <section className="paperclip-work-hero space-y-5 px-5 py-5 sm:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <span className="paperclip-work-meta">
            {goal.level}
          </span>
          <span className="paperclip-work-meta">
            {ROADMAP_HORIZON_LABELS[goal.planningHorizon]}
          </span>
          <StatusBadge status={goal.status} />
        </div>

        <InlineEditor
          value={goal.title}
          onSave={(title) => updateGoal.mutate({ title })}
          as="h2"
          className="paperclip-work-title"
        />

        <InlineEditor
          value={goal.description ?? ""}
          onSave={(description) => updateGoal.mutate({ description })}
          as="p"
          className="max-w-3xl text-sm text-muted-foreground"
          placeholder="Add a description..."
          multiline
          imageUploadHandler={async (file) => {
            const asset = await uploadImage.mutateAsync(file);
            return asset.contentPath;
          }}
        />

        <div className="paperclip-work-card max-w-3xl space-y-2 rounded-[calc(var(--radius)+0.35rem)] px-4 py-4">
          <p className="paperclip-work-kicker">
            Manager guidance
          </p>
          <InlineEditor
            value={goal.guidance ?? ""}
            onSave={(guidance) => updateGoal.mutate({ guidance })}
            as="p"
            className="text-sm text-muted-foreground"
            placeholder="Describe how managers should use this roadmap item when deciding what to do next."
            multiline
          />
        </div>
      </section>

      <Tabs defaultValue="children" className="space-y-4">
        <TabsList>
          <TabsTrigger value="children">
            Sub-Items ({childGoals.length})
          </TabsTrigger>
          <TabsTrigger value="projects">
            Projects ({linkedProjects.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="children" className="mt-4 space-y-3">
          <div className="flex items-center justify-start">
            <Button
              size="sm"
              variant="outline"
              onClick={() => openNewGoal({ parentId: goalId })}
            >
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              Sub-Item
            </Button>
          </div>
          {childGoals.length === 0 ? (
            <div className="paperclip-work-card rounded-[calc(var(--radius)+0.3rem)] px-4 py-3 text-sm text-muted-foreground">
              No child roadmap items.
            </div>
          ) : (
            <GoalTree goals={childGoals} goalLink={(g) => `/roadmap/${g.id}`} />
          )}
        </TabsContent>

        <TabsContent value="projects" className="mt-4">
          {linkedProjects.length === 0 ? (
            <div className="paperclip-work-card rounded-[calc(var(--radius)+0.3rem)] px-4 py-3 text-sm text-muted-foreground">
              No linked projects.
            </div>
          ) : (
            <div className="paperclip-work-list">
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
  );
}
