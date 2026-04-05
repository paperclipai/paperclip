import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { projectsApi } from "../api/projects";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useIsRaava } from "../hooks/useIsRaava";
import { queryKeys } from "../lib/queryKeys";
import { EntityRow } from "../components/EntityRow";
import { StatusBadge } from "../components/StatusBadge";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { formatDate, projectUrl } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Hexagon, Plus } from "lucide-react";

// ---------------------------------------------------------------------------
// Avatar color palette (matches Agents.tsx pattern)
// ---------------------------------------------------------------------------
const AVATAR_COLORS = [
  { bg: "#EEF0FF", text: "#4A52E0" },
  { bg: "#E8F7F5", text: "#0A9984" },
  { bg: "#FFF3E6", text: "#D97706" },
  { bg: "#FEE2E2", text: "#DC2626" },
  { bg: "#F3E8FF", text: "#7C3AED" },
  { bg: "#DBEAFE", text: "#2563EB" },
];

function getAvatarColor(index: number) {
  return AVATAR_COLORS[index % AVATAR_COLORS.length];
}

// ---------------------------------------------------------------------------
// Raava Projects View (Figma Screen 22)
// ---------------------------------------------------------------------------

interface RaavaProjectCard {
  id: string;
  name: string;
  description: string | null;
  status: string;
  taskCount: number;
  completedCount: number;
  memberCount: number;
  memberNames: string[];
  href: string;
}

function RaavaProjectsView({
  projects,
  isLoading: loading,
  error,
  openNewProject,
}: {
  projects: RaavaProjectCard[];
  isLoading: boolean;
  error: Error | null;
  openNewProject: () => void;
}) {
  if (loading) {
    return <PageSkeleton variant="list" />;
  }

  if (error) {
    return (
      <div className="text-center py-12">
        <p className="text-sm text-destructive">{error.message}</p>
      </div>
    );
  }

  return (
    <div className="space-y-7">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="font-display text-[26px] text-foreground">Projects</h1>
        <Button variant="outline" size="sm" onClick={openNewProject}>
          <Plus className="h-4 w-4" />
          New Project
        </Button>
      </div>

      {projects.length === 0 ? (
        /* Empty state with dashed border */
        <div className="raava-card flex flex-col items-center justify-center gap-3 border-dashed bg-white px-8 py-16 text-center dark:bg-card">
          <Hexagon className="h-10 w-10 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">
            No projects yet. Create your first project to start organizing work.
          </p>
          <Button variant="gradient" size="sm" onClick={openNewProject}>
            <Plus className="h-4 w-4" />
            New Project
          </Button>
        </div>
      ) : (
        /* Project cards - 2 side by side */
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          {projects.map((project, idx) => {
            const color = getAvatarColor(idx);
            return (
              <Link
                key={project.id}
                to={project.href}
                className="raava-card flex flex-col gap-4 bg-white px-6 pt-6 pb-5 no-underline text-inherit hover:shadow-md transition-shadow dark:bg-card"
              >
                {/* Title + description */}
                <div>
                  <h3 className="font-[Syne] font-semibold text-base text-foreground">
                    {project.name}
                  </h3>
                  {project.description && (
                    <p className="mt-1 text-sm text-muted-foreground line-clamp-2">
                      {project.description}
                    </p>
                  )}
                </div>

                {/* Stats row */}
                <p className="text-xs text-muted-foreground">
                  {project.taskCount} tasks{" "}
                  <span className="mx-0.5 text-border">&middot;</span>{" "}
                  {project.completedCount} completed{" "}
                  <span className="mx-0.5 text-border">&middot;</span>{" "}
                  {project.memberCount} team member{project.memberCount !== 1 ? "s" : ""}
                </p>

                {/* Overlapping avatar circles */}
                {project.memberCount > 0 && (
                  <div className="flex -space-x-2">
                    {project.memberNames.slice(0, 5).map((name, i) => {
                      const c = getAvatarColor(i);
                      return (
                        <div
                          key={i}
                          className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-white dark:border-card"
                          style={{ backgroundColor: c.bg }}
                          title={name}
                        >
                          <span className="text-[10px] font-semibold" style={{ color: c.text }}>
                            {name[0]?.toUpperCase() ?? "?"}
                          </span>
                        </div>
                      );
                    })}
                    {project.memberCount > 5 && (
                      <div className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-white bg-secondary dark:border-card">
                        <span className="text-[10px] font-semibold text-muted-foreground">
                          +{project.memberCount - 5}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function Projects() {
  const { selectedCompanyId } = useCompany();
  const { openNewProject } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { isRaava } = useIsRaava();

  useEffect(() => {
    setBreadcrumbs([{ label: "Projects" }]);
  }, [setBreadcrumbs]);

  const { data: allProjects, isLoading, error } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents, isLoading: isAgentsLoading, error: agentsError } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && isRaava,
  });

  const { data: issues, isLoading: isIssuesLoading, error: issuesError } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && isRaava,
  });

  const projects = useMemo(
    () => (allProjects ?? []).filter((p) => !p.archivedAt),
    [allProjects],
  );

  // Build Raava project cards with stats
  const raavaCards = useMemo<RaavaProjectCard[]>(() => {
    if (!isRaava) return [];
    const agentMap = new Map((agents ?? []).map((a) => [a.id, a]));
    const issueList = issues ?? [];
    return projects.map((p) => {
      const projectIssues = issueList.filter((i) => i.projectId === p.id);
      const completedCount = projectIssues.filter(
        (i) => i.status === "done",
      ).length;
      const memberIds = new Set<string>();
      for (const i of projectIssues) {
        if (i.assigneeAgentId) memberIds.add(i.assigneeAgentId);
      }
      if (p.leadAgentId) memberIds.add(p.leadAgentId);
      const memberNames = [...memberIds]
        .map((id) => agentMap.get(id)?.name ?? "Unknown")
        .slice(0, 8);
      return {
        id: p.id,
        name: p.name,
        description: p.description,
        status: p.status,
        taskCount: projectIssues.length,
        completedCount,
        memberCount: memberIds.size,
        memberNames,
        href: projectUrl(p),
      };
    });
  }, [isRaava, projects, agents, issues]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Hexagon} message="Select a company to view projects." />;
  }

  const combinedLoading = isLoading || (isRaava && (isAgentsLoading || isIssuesLoading));
  const combinedError = error ?? (isRaava ? (agentsError ?? issuesError) : null);

  if (combinedLoading) {
    return <PageSkeleton variant="list" />;
  }

  // Raava mode: card-grid view (Figma Screen 22)
  if (isRaava) {
    return (
      <RaavaProjectsView
        projects={raavaCards}
        isLoading={false}
        error={combinedError as Error | null}
        openNewProject={openNewProject}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <Button size="sm" variant="outline" onClick={openNewProject}>
          <Plus className="h-4 w-4 mr-1" />
          Add Project
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {!isLoading && projects.length === 0 && (
        <EmptyState
          icon={Hexagon}
          message="No projects yet."
          action="Add Project"
          onAction={openNewProject}
        />
      )}

      {projects.length > 0 && (
        <div className="border border-border">
          {projects.map((project) => (
            <EntityRow
              key={project.id}
              title={project.name}
              subtitle={project.description ?? undefined}
              to={projectUrl(project)}
              trailing={
                <div className="flex items-center gap-3">
                  {project.targetDate && (
                    <span className="text-xs text-muted-foreground">
                      {formatDate(project.targetDate)}
                    </span>
                  )}
                  <StatusBadge status={project.status} />
                </div>
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
