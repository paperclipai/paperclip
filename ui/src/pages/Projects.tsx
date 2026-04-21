import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { projectsApi } from "../api/projects";
import { authApi } from "../api/auth";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useProjectPins } from "../hooks/useProjectPins";
import { queryKeys } from "../lib/queryKeys";
import { StatusBadge } from "../components/StatusBadge";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { ProjectCodeBadge } from "../components/ProjectCodeBadge";
import { ProjectLabelPills } from "../components/ProjectLabelPills";
import { sortProjectsByRecentActivity } from "../lib/project-recency";
import { buildProjectHierarchyEntries, projectAncestorNames } from "../lib/project-hierarchy";
import { formatDate, projectUrl } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Hexagon, Plus, Search } from "lucide-react";
import { ProjectStarButton } from "../components/ProjectStarButton";

function buildProjectSearchText(project: {
  name: string;
  code: string | null;
  description: string | null;
  status: string;
  goals: Array<{ title: string }>;
  labels?: Array<{ name: string }>;
}) {
  return [
    project.name,
    project.code,
    project.description,
    project.status,
    project.status.replaceAll("_", " "),
    ...(project.labels ?? []).map((label) => label.name),
    ...project.goals.map((goal) => goal.title),
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();
}

export function Projects() {
  const { selectedCompanyId } = useCompany();
  const { openNewProject } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "Projects" }]);
  }, [setBreadcrumbs]);

  const { data: allProjects, isLoading, error } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const projects = useMemo(
    () => sortProjectsByRecentActivity((allProjects ?? []).filter((p) => !p.archivedAt)),
    [allProjects],
  );
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const {
    orderedProjects: starredProjectsFirst,
    pinnedIds: starredProjectIds,
    togglePinned: toggleStarred,
  } = useProjectPins({
    projects,
    companyId: selectedCompanyId,
    userId: currentUserId,
  });
  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const filteredProjects = useMemo(() => {
    if (!normalizedSearchQuery) return starredProjectsFirst;
    return starredProjectsFirst.filter((project) => {
      const ancestorText = projectAncestorNames(project, projects).join(" ");
      return `${buildProjectSearchText(project)} ${ancestorText}`.toLowerCase().includes(normalizedSearchQuery);
    });
  }, [starredProjectsFirst, normalizedSearchQuery, projects]);
  const projectEntries = useMemo(
    () => buildProjectHierarchyEntries(filteredProjects, projects),
    [filteredProjects, projects],
  );

  if (!selectedCompanyId) {
    return <EmptyState icon={Hexagon} message="Select a company to view projects." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="relative sm:hidden">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search projects..."
            className="h-8 w-full pl-8 text-xs"
            aria-label="Search projects"
          />
        </div>

        <div className="flex items-center justify-end gap-2 sm:justify-between">
          <div className="relative hidden sm:block w-64 md:w-80">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search projects..."
              className="h-8 w-full pl-8 text-xs"
              aria-label="Search projects"
            />
          </div>

          <Button size="sm" variant="outline" onClick={openNewProject}>
            <Plus className="h-4 w-4 mr-1" />
            Add Project
          </Button>
        </div>
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

      {!isLoading && projects.length > 0 && filteredProjects.length === 0 && (
        <EmptyState
          icon={Search}
          message="No projects match your search."
        />
      )}

      {projectEntries.length > 0 && (
        <div className="border border-border">
          {projectEntries.map(({ project, depth, ancestorNames }) => {
            const metadata = [
              ancestorNames.length > 0 ? ancestorNames.join(" / ") : null,
              project.description,
            ].filter((value): value is string => Boolean(value));
            return (
              <div
                key={project.id}
                className="group/project flex items-stretch border-b border-border last:border-b-0"
              >
                <Link
                  to={projectUrl(project)}
                  className="flex min-w-0 flex-1 items-center gap-3 px-4 py-2 no-underline text-inherit transition-colors hover:bg-accent/50"
                  style={{ paddingLeft: `${1 + Math.min(depth, 6) * 1.25}rem` }}
                >
                  <span
                    className="h-3.5 w-3.5 shrink-0 rounded-sm"
                    style={{ backgroundColor: project.color ?? "#6366f1" }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <div className="truncate text-sm">{project.name}</div>
                      <ProjectCodeBadge code={project.code} />
                      <ProjectLabelPills labels={project.labels} />
                    </div>
                    {metadata.length > 0 && (
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">{metadata.join(" - ")}</p>
                    )}
                  </div>
                  <div className="ml-3 flex shrink-0 items-center gap-3">
                    {project.targetDate && (
                      <span className="text-xs text-muted-foreground">
                        {formatDate(project.targetDate)}
                      </span>
                    )}
                    <StatusBadge status={project.status} />
                  </div>
                </Link>
                <div className="flex items-center px-2">
                  <ProjectStarButton
                    starred={starredProjectIds.includes(project.id)}
                    projectName={project.name}
                    onToggle={() => toggleStarred(project.id)}
                    className="h-8 w-8"
                    iconClassName="h-4 w-4"
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
