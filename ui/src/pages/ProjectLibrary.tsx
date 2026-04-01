import { useEffect, useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import type { Company, Project } from "@paperclipai/shared";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { StatusBadge } from "../components/StatusBadge";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { cn, projectUrl, relativeTime } from "../lib/utils";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  ChevronRight,
  Hexagon,
  LayoutGrid,
  List,
  Search,
} from "lucide-react";
import { Link } from "@/lib/router";

type StatusFilter = "active" | "completed" | "archived";
type ViewMode = "list" | "grid";

interface CompanyProjectGroup {
  company: Company;
  projects: Project[];
}

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "completed", label: "Completed" },
  { value: "archived", label: "Archived" },
];

function isActiveProject(project: Project): boolean {
  return (
    !project.archivedAt &&
    project.status !== "completed" &&
    project.status !== "cancelled"
  );
}

function isCompletedProject(project: Project): boolean {
  return (
    !project.archivedAt &&
    (project.status === "completed" || project.status === "cancelled")
  );
}

function isArchivedProject(project: Project): boolean {
  return Boolean(project.archivedAt);
}

function ProjectCard({ project, companyName }: { project: Project; companyName: string }) {
  const isArchived = Boolean(project.archivedAt);

  return (
    <Link
      to={projectUrl(project)}
      className={cn(
        "block border border-border bg-card p-4 transition-colors hover:bg-accent/50 no-underline text-inherit",
        isArchived && "opacity-50",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {project.color && (
              <span
                className="h-3 w-3 rounded-sm shrink-0"
                style={{ backgroundColor: project.color }}
              />
            )}
            <span className="text-sm font-medium truncate">{project.name}</span>
          </div>
          <p className="text-xs text-muted-foreground mt-1 truncate">
            {companyName}
          </p>
        </div>
        {isArchived ? (
          <StatusBadge status="archived" />
        ) : (
          <StatusBadge status={project.status} />
        )}
      </div>
      {project.description && (
        <p className="text-xs text-muted-foreground mt-2 line-clamp-2">
          {project.description}
        </p>
      )}
      <div className="flex items-center gap-3 mt-3 text-xs text-muted-foreground">
        {project.targetDate && (
          <span>Target: {new Date(project.targetDate).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
        )}
        <span className="ml-auto">{relativeTime(project.updatedAt)}</span>
      </div>
    </Link>
  );
}

function ProjectRow({ project, companyName }: { project: Project; companyName: string }) {
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
        <span
          className="h-3 w-3 rounded-sm shrink-0"
          style={{ backgroundColor: project.color }}
        />
      )}
      <div className="flex-1 min-w-0">
        <span className="truncate block">{project.name}</span>
      </div>
      <span className="text-xs text-muted-foreground shrink-0 hidden sm:block">
        {companyName}
      </span>
      <span className="text-xs text-muted-foreground shrink-0 hidden md:block">
        {relativeTime(project.updatedAt)}
      </span>
      {isArchived ? (
        <StatusBadge status="archived" />
      ) : (
        <StatusBadge status={project.status} />
      )}
    </Link>
  );
}

function CompanySection({
  group,
  viewMode,
  defaultOpen,
}: {
  group: CompanyProjectGroup;
  viewMode: ViewMode;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-2 w-full px-1 py-2 hover:bg-accent/30 transition-colors rounded-sm">
        <ChevronRight
          className={cn(
            "h-4 w-4 text-muted-foreground transition-transform shrink-0",
            open && "rotate-90",
          )}
        />
        {group.company.brandColor && (
          <span
            className="h-3 w-3 rounded-sm shrink-0"
            style={{ backgroundColor: group.company.brandColor }}
          />
        )}
        <span className="text-sm font-semibold truncate">
          {group.company.name}
        </span>
        <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-5 shrink-0">
          {group.projects.length}
        </Badge>
      </CollapsibleTrigger>

      <CollapsibleContent>
        {viewMode === "grid" ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 pt-1 pb-3">
            {group.projects.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                companyName={group.company.name}
              />
            ))}
          </div>
        ) : (
          <div className="border border-border mb-3">
            {group.projects.map((project) => (
              <ProjectRow
                key={project.id}
                project={project}
                companyName={group.company.name}
              />
            ))}
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ProjectLibrary() {
  const { companies } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilters, setStatusFilters] = useState<Set<StatusFilter>>(
    new Set(["active"]),
  );
  const [viewMode, setViewMode] = useState<ViewMode>("list");

  useEffect(() => {
    setBreadcrumbs([{ label: "Project Library" }]);
  }, [setBreadcrumbs]);

  // Filter to non-archived companies for fetching
  const activeCompanies = useMemo(
    () => companies.filter((c) => c.status !== "archived"),
    [companies],
  );

  // Fetch projects for every company in parallel
  const projectQueries = useQueries({
    queries: activeCompanies.map((company) => ({
      queryKey: queryKeys.projects.listWithArchived(company.id),
      queryFn: () => projectsApi.list(company.id, { includeArchived: true }),
      enabled: true,
    })),
  });

  const isLoading = projectQueries.some((q) => q.isLoading);
  const hasError = projectQueries.some((q) => q.error);

  // Build a map from companyId -> Company
  const companiesMap = useMemo(() => {
    const map = new Map<string, Company>();
    for (const company of activeCompanies) {
      map.set(company.id, company);
    }
    return map;
  }, [activeCompanies]);

  // Flatten all projects and apply filters
  const allProjects = useMemo(() => {
    const result: Project[] = [];
    for (const query of projectQueries) {
      if (query.data) {
        result.push(...query.data);
      }
    }
    return result;
  }, [projectQueries]);

  const filteredProjects = useMemo(() => {
    let result = allProjects;

    // Apply status filters
    if (statusFilters.size > 0) {
      result = result.filter((project) => {
        if (statusFilters.has("active") && isActiveProject(project)) return true;
        if (statusFilters.has("completed") && isCompletedProject(project)) return true;
        if (statusFilters.has("archived") && isArchivedProject(project)) return true;
        return false;
      });
    }

    // Apply search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      result = result.filter((project) => {
        const companyName = companiesMap.get(project.companyId)?.name ?? "";
        return (
          project.name.toLowerCase().includes(q) ||
          (project.description?.toLowerCase().includes(q) ?? false) ||
          companyName.toLowerCase().includes(q)
        );
      });
    }

    return result;
  }, [allProjects, statusFilters, searchQuery, companiesMap]);

  // Group by company
  const grouped = useMemo(() => {
    const map = new Map<string, CompanyProjectGroup>();
    for (const project of filteredProjects) {
      const existing = map.get(project.companyId);
      if (existing) {
        existing.projects.push(project);
      } else {
        const company = companiesMap.get(project.companyId);
        if (company) {
          map.set(project.companyId, { company, projects: [project] });
        }
      }
    }

    // Sort groups: company name ascending
    const groups = Array.from(map.values());
    groups.sort((a, b) => a.company.name.localeCompare(b.company.name));

    // Sort projects within each group: active first, then by updatedAt desc
    for (const group of groups) {
      group.projects.sort((a, b) => {
        const aArchived = a.archivedAt ? 1 : 0;
        const bArchived = b.archivedAt ? 1 : 0;
        if (aArchived !== bArchived) return aArchived - bArchived;
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      });
    }

    return groups;
  }, [filteredProjects, companiesMap]);

  const totalProjectCount = filteredProjects.length;

  function toggleStatusFilter(filter: StatusFilter) {
    setStatusFilters((prev) => {
      const next = new Set(prev);
      if (next.has(filter)) {
        next.delete(filter);
      } else {
        next.add(filter);
      }
      return next;
    });
  }

  if (activeCompanies.length === 0) {
    return <EmptyState icon={Hexagon} message="No companies yet. Create a company to get started." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-4">
      {/* Toolbar: search + filters + view toggle */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search projects..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 h-9"
          />
        </div>

        <div className="flex items-center gap-2">
          {/* Status filter chips */}
          <div className="flex items-center gap-1">
            {STATUS_FILTERS.map(({ value, label }) => (
              <button
                key={value}
                onClick={() => toggleStatusFilter(value)}
                className={cn(
                  "inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium transition-colors border",
                  statusFilters.has(value)
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-transparent text-muted-foreground border-border hover:bg-accent hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {/* View toggle */}
          <div className="flex items-center border border-border rounded-md overflow-hidden ml-1">
            <button
              onClick={() => setViewMode("list")}
              className={cn(
                "p-1.5 transition-colors",
                viewMode === "list"
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/50",
              )}
              title="List view"
            >
              <List className="h-4 w-4" />
            </button>
            <button
              onClick={() => setViewMode("grid")}
              className={cn(
                "p-1.5 transition-colors",
                viewMode === "grid"
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/50",
              )}
              title="Grid view"
            >
              <LayoutGrid className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Summary line */}
      <p className="text-xs text-muted-foreground">
        {totalProjectCount} {totalProjectCount === 1 ? "project" : "projects"}
        {activeCompanies.length > 1
          ? ` across ${grouped.length} ${grouped.length === 1 ? "company" : "companies"}`
          : ""}
      </p>

      {hasError && (
        <p className="text-sm text-destructive">
          Some project data could not be loaded.
        </p>
      )}

      {/* Grouped project list */}
      {grouped.length === 0 && (
        <EmptyState
          icon={Hexagon}
          message={
            searchQuery
              ? "No projects match your search."
              : "No projects found with the selected filters."
          }
        />
      )}

      <div className="space-y-1">
        {grouped.map((group) => (
          <CompanySection
            key={group.company.id}
            group={group}
            viewMode={viewMode}
            defaultOpen={grouped.length <= 10}
          />
        ))}
      </div>
    </div>
  );
}
