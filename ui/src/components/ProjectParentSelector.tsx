import { useMemo } from "react";
import type { Project } from "@paperclipai/shared";
import { InlineEntitySelector, type InlineEntityOption } from "./InlineEntitySelector";
import { ProjectCodeBadge } from "./ProjectCodeBadge";
import {
  buildProjectHierarchyEntries,
  projectDescendantIds,
  projectHierarchyLabel,
} from "../lib/project-hierarchy";

interface ProjectParentSelectorProps {
  projects: Project[];
  value: string | null;
  onChange: (parentId: string | null) => void;
  excludeProjectId?: string | null;
  className?: string;
  disablePortal?: boolean;
}

export function ProjectParentSelector({
  projects,
  value,
  onChange,
  excludeProjectId,
  className,
  disablePortal,
}: ProjectParentSelectorProps) {
  const blockedIds = useMemo(() => {
    if (!excludeProjectId) return new Set<string>();
    return new Set([excludeProjectId, ...projectDescendantIds(excludeProjectId, projects)]);
  }, [excludeProjectId, projects]);

  const candidates = useMemo(
    () => projects.filter((project) => !project.archivedAt && !blockedIds.has(project.id)),
    [blockedIds, projects],
  );
  const entries = useMemo(() => buildProjectHierarchyEntries(candidates, projects), [candidates, projects]);
  const entryById = useMemo(
    () => new Map(entries.map((entry) => [entry.project.id, entry])),
    [entries],
  );
  const options = useMemo<InlineEntityOption[]>(
    () =>
      entries.map(({ project }) => ({
        id: project.id,
        label: project.name,
        searchText: `${project.code ?? ""} ${projectHierarchyLabel(project, projects)}`,
      })),
    [entries, projects],
  );

  return (
    <InlineEntitySelector
      value={value ?? ""}
      options={options}
      placeholder="Parent project"
      noneLabel="No parent"
      searchPlaceholder="Search projects..."
      emptyMessage="No eligible projects found."
      className={className}
      disablePortal={disablePortal}
      onChange={(id) => onChange(id || null)}
      renderTriggerValue={(option) => {
        if (!option) return <span className="text-muted-foreground">No parent</span>;
        const project = candidates.find((candidate) => candidate.id === option.id);
        return (
          <>
            <span
              className="h-3.5 w-3.5 shrink-0 rounded-sm"
              style={{ backgroundColor: project?.color ?? "#6366f1" }}
            />
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            <ProjectCodeBadge code={project?.code} />
          </>
        );
      }}
      renderOption={(option) => {
        if (!option.id) return <span className="truncate">{option.label}</span>;
        const entry = entryById.get(option.id);
        const project = entry?.project;
        return (
          <span
            className="flex min-w-0 flex-1 items-center gap-2"
            style={{ paddingLeft: `${Math.min(entry?.depth ?? 0, 6) * 0.75}rem` }}
          >
            <span
              className="h-3.5 w-3.5 shrink-0 rounded-sm"
              style={{ backgroundColor: project?.color ?? "#6366f1" }}
            />
            <span className="min-w-0 flex-1 truncate">{projectHierarchyLabel(project ?? { id: option.id, parentId: null, name: option.label }, projects)}</span>
            <ProjectCodeBadge code={project?.code} />
          </span>
        );
      }}
    />
  );
}
