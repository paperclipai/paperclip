import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Project } from "@paperclipai/shared";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EntityRow } from "../components/EntityRow";
import { StatusBadge } from "../components/StatusBadge";
import { MembershipAction } from "../components/MembershipAction";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { formatDate, projectUrl } from "../lib/utils";
import { useCurrentLocale, useLocalizedCopy } from "../i18n/ui-copy";
import {
  resourceMembershipState,
  useResourceMembershipMutation,
  useResourceMemberships,
} from "../hooks/useResourceMemberships";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ArrowUpDown, Check, Hexagon, Plus } from "lucide-react";

type ProjectSortField = "name" | "updated" | "created" | "targetDate";
type ProjectSortDir = "asc" | "desc";

const PROJECT_SORT_OPTIONS: Array<{ field: ProjectSortField; key: string; english: string; korean: string }> = [
  { field: "name", key: "name", english: "Name", korean: "이름" },
  { field: "updated", key: "updated", english: "Updated", korean: "최근 수정" },
  { field: "created", key: "created", english: "Created", korean: "생성일" },
  { field: "targetDate", key: "targetDate", english: "Target date", korean: "목표일" },
];

function compareProjectNames(left: Project, right: Project) {
  const nameDiff = left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  return nameDiff !== 0 ? nameDiff : left.id.localeCompare(right.id);
}

function projectTime(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function compareOptionalTime(
  left: Date | string | null | undefined,
  right: Date | string | null | undefined,
  sortDir: ProjectSortDir,
) {
  const leftTime = projectTime(left);
  const rightTime = projectTime(right);
  if (leftTime === null && rightTime === null) return 0;
  if (leftTime === null) return 1;
  if (rightTime === null) return -1;
  return sortDir === "asc" ? leftTime - rightTime : rightTime - leftTime;
}

function sortProjects(projects: Project[], sortField: ProjectSortField, sortDir: ProjectSortDir) {
  return [...projects].sort((left, right) => {
    let comparison = 0;
    if (sortField === "name") {
      comparison = compareProjectNames(left, right);
      return sortDir === "asc" ? comparison : -comparison;
    }

    if (sortField === "updated") comparison = compareOptionalTime(left.updatedAt, right.updatedAt, sortDir);
    else if (sortField === "created") comparison = compareOptionalTime(left.createdAt, right.createdAt, sortDir);
    else comparison = compareOptionalTime(left.targetDate, right.targetDate, sortDir);

    if (comparison === 0) comparison = compareProjectNames(left, right);
    return comparison;
  });
}

export function Projects() {
  const { selectedCompanyId } = useCompany();
  const { openNewProject } = useDialogActions();
  const { setBreadcrumbs } = useBreadcrumbs();
  const copy = useLocalizedCopy();
  const locale = useCurrentLocale();
  const [sortField, setSortField] = useState<ProjectSortField>("name");
  const [sortDir, setSortDir] = useState<ProjectSortDir>("asc");

  useEffect(() => {
    setBreadcrumbs([{ label: copy("projects.breadcrumb", "Projects", "프로젝트") }]);
  }, [copy, setBreadcrumbs]);

  const { data: allProjects, isLoading, error } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const membershipsQuery = useResourceMemberships(selectedCompanyId);
  const membershipMutation = useResourceMembershipMutation(selectedCompanyId);
  const projects = useMemo(
    () => (allProjects ?? []).filter((p) => !p.archivedAt),
    [allProjects],
  );
  const sortedProjects = useMemo(
    () => sortProjects(projects, sortField, sortDir),
    [projects, sortDir, sortField],
  );
  const groupedProjects = useMemo(() => {
    const groups = {
      mine: [] as typeof sortedProjects,
      other: [] as typeof sortedProjects,
    };

    for (const project of sortedProjects) {
      const state = resourceMembershipState(membershipsQuery.data, "project", project.id);
      if (state === "left") groups.other.push(project);
      else groups.mine.push(project);
    }

    return groups;
  }, [membershipsQuery.data, sortedProjects]);
  const currentSortOption = PROJECT_SORT_OPTIONS.find((option) => option.field === sortField) ?? {
    field: "name",
    key: "name",
    english: "Name",
    korean: "이름",
  };
  const sortLabel = copy(
    `projects.sort.${currentSortOption.key}`,
    currentSortOption.english,
    currentSortOption.korean,
  );

  if (!selectedCompanyId) {
    return (
      <EmptyState
        icon={Hexagon}
        message={copy("projects.noCompany", "Select a company to view projects.", "프로젝트를 보려면 회사를 선택하세요.")}
      />
    );
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" className="w-fit text-xs" title={copy("projects.sort.title", "Sort", "정렬")}>
              <ArrowUpDown className="h-3.5 w-3.5 sm:h-3 sm:w-3 sm:mr-1" />
              <span>{copy("projects.sort.prefix", "Sort: {{label}}", "정렬: {{label}}", { label: sortLabel })}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-44 p-0">
            <div className="p-2 space-y-0.5">
              {PROJECT_SORT_OPTIONS.map((option) => {
                const optionLabel = copy(`projects.sort.${option.key}`, option.english, option.korean);
                return (
                  <button
                    key={option.field}
                    type="button"
                    className={`flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm ${
                      sortField === option.field
                        ? "bg-accent/50 text-foreground"
                        : "text-muted-foreground hover:bg-accent/50"
                    }`}
                    onClick={() => {
                      if (sortField === option.field) {
                        setSortDir((current) => (current === "asc" ? "desc" : "asc"));
                        return;
                      }
                      setSortField(option.field);
                      setSortDir(option.field === "name" || option.field === "targetDate" ? "asc" : "desc");
                    }}
                  >
                    <span>{optionLabel}</span>
                    {sortField === option.field ? (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Check className="h-3 w-3" />
                        {sortDir === "asc"
                          ? copy("projects.sort.asc", "Asc", "오름차순")
                          : copy("projects.sort.desc", "Desc", "내림차순")}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </PopoverContent>
        </Popover>
        <Button size="sm" variant="outline" onClick={openNewProject}>
          <Plus className="h-4 w-4 mr-1" />
          {copy("projects.add", "Add Project", "프로젝트 추가")}
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {!isLoading && projects.length === 0 && (
        <EmptyState
          icon={Hexagon}
          message={copy("projects.empty", "No projects yet.", "아직 프로젝트가 없습니다.")}
          action={copy("projects.add", "Add Project", "프로젝트 추가")}
          onAction={openNewProject}
        />
      )}

      {projects.length > 0 && (
        <div className="space-y-6">
          {([
            [
              copy("projects.group.mine", "My Projects", "내 프로젝트"),
              groupedProjects.mine,
              "mine",
            ],
            [
              copy("projects.group.other", "Other Projects", "다른 프로젝트"),
              groupedProjects.other,
              "other",
            ],
          ] as const).map(([label, sectionProjects, sectionKey]) => {
            if (sectionProjects.length === 0) return null;

            return (
              <section key={sectionKey} className="space-y-2">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-medium">{label}</h2>
                  <span className="text-xs text-muted-foreground">
                    {copy(
                      "projects.count",
                      sectionProjects.length === 1 ? "{{count}} project" : "{{count}} projects",
                      "{{count}}개 프로젝트",
                      { count: sectionProjects.length },
                    )}
                  </span>
                </div>
                <div className="border border-border">
                  {sectionProjects.map((project) => {
                    const state = resourceMembershipState(membershipsQuery.data, "project", project.id);
                    const pending = membershipMutation.isPending &&
                      membershipMutation.variables?.resourceType === "project" &&
                      membershipMutation.variables.resourceId === project.id;
                    return (
                      <EntityRow
                        key={project.id}
                        title={project.name}
                        subtitle={project.description ?? undefined}
                        reserveSubtitleSpace
                        to={projectUrl(project)}
                        className={state === "left" ? "group text-foreground/55" : "group"}
                        trailing={
                          <div className="flex items-center gap-3">
                            {project.targetDate && (
                              <span className="text-xs text-muted-foreground">
                                {formatDate(project.targetDate, locale)}
                              </span>
                            )}
                            <StatusBadge status={project.status} />
                            <MembershipAction
                              state={state}
                              pending={pending}
                              pendingState={pending ? membershipMutation.variables?.state : null}
                              resourceName={project.name}
                              onJoin={() => membershipMutation.mutate({
                                resourceType: "project",
                                resourceId: project.id,
                                resourceName: project.name,
                                state: "joined",
                              })}
                              onLeave={() => membershipMutation.mutate({
                                resourceType: "project",
                                resourceId: project.id,
                                resourceName: project.name,
                                state: "left",
                              })}
                            />
                          </div>
                        }
                      />
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
