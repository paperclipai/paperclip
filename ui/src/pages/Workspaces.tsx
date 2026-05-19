import { useEffect, useMemo } from "react";
import { Link, Navigate } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import type { ExecutionWorkspace, Issue, Project } from "@paperclipai/shared";
import { executionWorkspacesApi } from "../api/execution-workspaces";
import { instanceSettingsApi } from "../api/instanceSettings";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { ProjectWorkspacesContent } from "../components/ProjectWorkspacesContent";
import { PageSkeleton } from "../components/PageSkeleton";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { buildProjectWorkspaceSummaries, type ProjectWorkspaceSummary } from "../lib/project-workspaces-tab";
import { queryKeys } from "../lib/queryKeys";
import { projectRouteRef } from "../lib/utils";

type ProjectWorkspaceGroup = {
  project: Project;
  projectRef: string;
  summaries: ProjectWorkspaceSummary[];
  lastUpdatedAt: Date;
  runningServiceCount: number;
};

function buildProjectWorkspaceGroups(input: {
  projects: Project[];
  issues: Issue[];
  executionWorkspaces: ExecutionWorkspace[];
}): ProjectWorkspaceGroup[] {
  const issuesByProjectId = new Map<string, Issue[]>();
  for (const issue of input.issues) {
    if (!issue.projectId) continue;
    const existing = issuesByProjectId.get(issue.projectId) ?? [];
    existing.push(issue);
    issuesByProjectId.set(issue.projectId, existing);
  }

  const executionWorkspacesByProjectId = new Map<string, ExecutionWorkspace[]>();
  for (const workspace of input.executionWorkspaces) {
    if (!workspace.projectId) continue;
    const existing = executionWorkspacesByProjectId.get(workspace.projectId) ?? [];
    existing.push(workspace);
    executionWorkspacesByProjectId.set(workspace.projectId, existing);
  }

  return input.projects
    .map((project) => {
      const summaries = buildProjectWorkspaceSummaries({
        project,
        issues: issuesByProjectId.get(project.id) ?? [],
        executionWorkspaces: executionWorkspacesByProjectId.get(project.id) ?? [],
      });
      if (summaries.length === 0) return null;
      return {
        project,
        projectRef: projectRouteRef(project),
        summaries,
        lastUpdatedAt: summaries.reduce(
          (latest, summary) => summary.lastUpdatedAt.getTime() > latest.getTime() ? summary.lastUpdatedAt : latest,
          new Date(0),
        ),
        runningServiceCount: summaries.reduce((count, summary) => count + summary.runningServiceCount, 0),
      };
    })
    .filter((group): group is ProjectWorkspaceGroup => group !== null)
    .sort((a, b) => {
      const runningDiff = b.runningServiceCount - a.runningServiceCount;
      if (runningDiff !== 0) return runningDiff;
      const updatedDiff = b.lastUpdatedAt.getTime() - a.lastUpdatedAt.getTime();
      return updatedDiff !== 0 ? updatedDiff : a.project.name.localeCompare(b.project.name);
    });
}

export function Workspaces() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const experimentalSettingsQuery = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  const isolatedWorkspacesEnabled = experimentalSettingsQuery.data?.enableIsolatedWorkspaces === true;

  const { data: projects = [], isLoading: projectsLoading, error: projectsError } = useQuery({
    queryKey: selectedCompanyId ? queryKeys.projects.list(selectedCompanyId) : ["projects", "__workspaces__", "disabled"],
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId && isolatedWorkspacesEnabled),
  });
  const { data: issues = [], isLoading: issuesLoading, error: issuesError } = useQuery({
    queryKey: selectedCompanyId ? queryKeys.issues.list(selectedCompanyId) : ["issues", "__workspaces__", "disabled"],
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId && isolatedWorkspacesEnabled),
  });
  const {
    data: executionWorkspaces = [],
    isLoading: executionWorkspacesLoading,
    error: executionWorkspacesError,
  } = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.executionWorkspaces.list(selectedCompanyId)
      : ["execution-workspaces", "__workspaces__", "disabled"],
    queryFn: () => executionWorkspacesApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId && isolatedWorkspacesEnabled),
  });

  useEffect(() => {
    setBreadcrumbs([{ label: "Workspaces" }]);
  }, [setBreadcrumbs]);

  const groups = useMemo(
    () => buildProjectWorkspaceGroups({ projects, issues, executionWorkspaces }),
    [executionWorkspaces, issues, projects],
  );
  const dataLoading = projectsLoading || issuesLoading || executionWorkspacesLoading;
  const error = (projectsError ?? issuesError ?? executionWorkspacesError) as Error | null;

  if (experimentalSettingsQuery.isLoading) return <PageSkeleton variant="detail" />;
  if (!isolatedWorkspacesEnabled) return <Navigate to="/issues" replace />;
  if (dataLoading) return <PageSkeleton variant="list" />;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold">Workspaces</h2>
      </div>

      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">No workspace activity yet.</p>
      ) : (
        <div className="space-y-8">
          {groups.map((group) => (
            <section key={group.project.id} className="space-y-3">
              <div className="flex flex-wrap items-end justify-between gap-2">
                <div className="min-w-0">
                  <Link
                    to={`/projects/${group.projectRef}/workspaces`}
                    className="text-base font-semibold hover:underline"
                  >
                    {group.project.name}
                  </Link>
                  {group.project.description ? (
                    <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                      {group.project.description}
                    </p>
                  ) : null}
                </div>
                <span className="text-xs text-muted-foreground">
                  {group.summaries.length} workspace{group.summaries.length === 1 ? "" : "s"}
                </span>
              </div>
              <ProjectWorkspacesContent
                companyId={selectedCompanyId!}
                projectId={group.project.id}
                projectRef={group.projectRef}
                summaries={group.summaries}
              />
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
