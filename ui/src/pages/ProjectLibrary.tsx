import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Project } from "@paperclipai/shared";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { StatusBadge } from "../components/StatusBadge";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { cn, projectUrl, relativeTime } from "../lib/utils";
import { Input } from "@/components/ui/input";
import {
  LayoutGrid,
  List,
  Search,
} from "lucide-react";
import { Link } from "@/lib/router";

type StatusFilter = "active" | "completed" | "archived";
type ViewMode = "list" | "grid";

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "completed", label: "Completed" },
  { value: "archived", label: "Archived" },
];

function isActiveProject(project: Project): boolean {
  return !project.archivedAt && project.status !== "completed" && project.status !== "cancelled";
}

function isCompletedProject(project: Project): boolean {
  return !project.archivedAt && (project.status === "completed" || project.status === "cancelled");
}

function isArchivedProject(project: Project): boolean {
  return Boolean(project.archivedAt);
}

function ProjectCard({ project }: { project: Project }) {
  const isArchived = Boolean(project.archivedAt);
  return (
    <Link
      to={projectUrl(project)}
      className={cn(
        "block border border-border bg-card p-4 rounded-md transition-colors hover:bg-accent/50 no-underline text-inherit",
        isArchived && "opacity-50",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {project.color && (
              <span className="h-3 w-3 rounded-sm shrink-0" style={{ backgroundColor: project.color }} />
            )}
            <span className="text-sm font-medium truncate">{project.name}</span>
          </div>
        </div>
        {isArchived ? <StatusBadge status="archived" /> : <StatusBadge status={project.status} />}
      </div>
      {project.description && (
        <p className="text-xs text-muted-foreground mt-2 line-clamp-2">{project.description}</p>
      )}
      <div className="flex items-center gap-3 mt-3 text-xs text-muted-foreground">
        {project.targetDate && <span>Target: {new Date(project.targetDate).toLocaleDateString()}</span>}
        <span>{relativeTime(project.updatedAt)}</span>
      </div>
    </Link>
  );
}

function ProjectRow({ project }: { project: Project }) {
  const isArchived = Boolean(project.archivedAt);
  return (
    <Link
      to={projectUrl(project)}
      className={cn(
        "flex items-center gap-3 px-4 py-2.5 text-sm border-b border-border last:border-b-0 transition-colors hover:bg-accent/50 no-underline text-inherit",
        isArchived && "opacity-50",
      )}
    >
      {project.color && (
        <span className="h-3 w-3 rounded-sm shrink-0" style={{ backgroundColor: project.color }} />
      )}
      <div className="flex-1 min-w-0">
        <span className="truncate block">{project.name}</span>
      </div>
      <span className="text-xs text-muted-foreground shrink-0 hidden md:block">
        {relativeTime(project.updatedAt)}
      </span>
      {isArchived ? <StatusBadge status="archived" /> : <StatusBadge status={project.status} />}
    </Link>
  );
}

export function ProjectLibrary() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilters, setStatusFilters] = useState<Set<StatusFilter>>(new Set(["active"]));
  const [viewMode, setViewMode] = useState<ViewMode>("list");

  useEffect(() => {
    setBreadcrumbs([{ label: "Projects" }]);
  }, [setBreadcrumbs]);

  const { data: projects = [], isLoading } = useQuery({
    queryKey: queryKeys.projects.listWithArchived(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!, { includeArchived: true }),
    enabled: !!selectedCompanyId,
  });

  const filteredProjects = useMemo(() => {
    let result = projects;

    // Status filter
    if (statusFilters.size > 0) {
      result = result.filter((p) => {
        if (statusFilters.has("active") && isActiveProject(p)) return true;
        if (statusFilters.has("completed") && isCompletedProject(p)) return true;
        if (statusFilters.has("archived") && isArchivedProject(p)) return true;
        return false;
      });
    }

    // Search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.description ?? "").toLowerCase().includes(q),
      );
    }

    return result;
  }, [projects, statusFilters, searchQuery]);

  const statusCounts = useMemo(() => ({
    active: projects.filter(isActiveProject).length,
    completed: projects.filter(isCompletedProject).length,
    archived: projects.filter(isArchivedProject).length,
  }), [projects]);

  if (isLoading) return <PageSkeleton />;

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-lg font-semibold">
          Projects
          {selectedCompany && <span className="text-muted-foreground font-normal"> — {selectedCompany.name}</span>}
        </h1>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            className="pl-8 h-8 text-sm"
            placeholder="Search projects..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-1">
          {STATUS_FILTERS.map(({ value, label }) => (
            <button
              key={value}
              className={cn(
                "px-2.5 py-1 text-xs rounded-full border transition-colors",
                statusFilters.has(value)
                  ? "border-foreground/20 bg-foreground/5 text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
              onClick={() => {
                const next = new Set(statusFilters);
                if (next.has(value)) next.delete(value);
                else next.add(value);
                setStatusFilters(next);
              }}
            >
              {label} ({statusCounts[value]})
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 border border-border rounded-md">
          <button
            className={cn("p-1.5 rounded-l-md", viewMode === "list" && "bg-accent")}
            onClick={() => setViewMode("list")}
          >
            <List className="h-3.5 w-3.5" />
          </button>
          <button
            className={cn("p-1.5 rounded-r-md", viewMode === "grid" && "bg-accent")}
            onClick={() => setViewMode("grid")}
          >
            <LayoutGrid className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Projects */}
      {filteredProjects.length === 0 ? (
        <EmptyState
          icon={Search}
          message={searchQuery ? "No projects match your search." : "No projects in this company yet."}
        />
      ) : viewMode === "grid" ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filteredProjects.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      ) : (
        <div className="border border-border rounded-md">
          {filteredProjects.map((project) => (
            <ProjectRow key={project.id} project={project} />
          ))}
        </div>
      )}
    </div>
  );
}
