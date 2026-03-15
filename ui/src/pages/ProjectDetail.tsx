import { useEffect, useMemo, useState, useRef } from "react";
import { useParams, useNavigate, useLocation, Navigate } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PROJECT_COLORS, isUuidLike } from "@paperclipai/shared";
import { projectsApi } from "../api/projects";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { assetsApi } from "../api/assets";
import { usePanel } from "../context/PanelContext";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { ProjectProperties } from "../components/ProjectProperties";
import { InlineEditor } from "../components/InlineEditor";
import { StatusBadge } from "../components/StatusBadge";
import { IssuesList } from "../components/IssuesList";
import { PageSkeleton } from "../components/PageSkeleton";
import { projectRouteRef, cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SlidersHorizontal } from "lucide-react";

/* ── Top-level tab types ── */

type ProjectTab = "overview" | "list" | "configuration";

function resolveProjectTab(pathname: string, projectId: string): ProjectTab | null {
  const segments = pathname.split("/").filter(Boolean);
  const projectsIdx = segments.indexOf("projects");
  if (projectsIdx === -1 || segments[projectsIdx + 1] !== projectId) return null;
  const tab = segments[projectsIdx + 2];
  if (tab === "overview") return "overview";
  if (tab === "configuration") return "configuration";
  if (tab === "issues") return "list";
  return null;
}

/* ── Overview tab content ── */

function OverviewContent({
  project,
  onUpdate,
  imageUploadHandler,
}: {
  project: { description: string | null; status: string; targetDate: string | null };
  onUpdate: (data: Record<string, unknown>) => void;
  imageUploadHandler?: (file: File) => Promise<string>;
}) {
  return (
    <div className="space-y-4">
      <InlineEditor
        value={project.description ?? ""}
        onSave={(description) => onUpdate({ description })}
        as="p"
        className="paperclip-work-card rounded-[calc(var(--radius)+0.35rem)] px-4 py-4 text-sm text-muted-foreground"
        placeholder="Add a description..."
        multiline
        imageUploadHandler={imageUploadHandler}
      />

      <div className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
        <div className="paperclip-work-stat px-4 py-4">
          <span className="paperclip-work-label">Status</span>
          <div className="mt-3">
            <StatusBadge status={project.status} />
          </div>
        </div>
        {project.targetDate && (
          <div className="paperclip-work-stat px-4 py-4">
            <span className="paperclip-work-label">Target Date</span>
            <p className="mt-3 text-base font-medium">{project.targetDate}</p>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Color picker popover ── */

function ColorPicker({
  currentColor,
  onSelect,
}: {
  currentColor: string;
  onSelect: (color: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="shrink-0 h-5 w-5 rounded-md cursor-pointer hover:ring-2 hover:ring-foreground/20 transition-[box-shadow]"
        style={{ backgroundColor: currentColor }}
        aria-label="Change project color"
      />
      {open && (
        <div className="absolute top-full left-0 mt-2 p-2 bg-popover border border-border rounded-lg shadow-lg z-50 w-max">
          <div className="grid grid-cols-5 gap-1.5">
            {PROJECT_COLORS.map((color) => (
              <button
                key={color}
                onClick={() => {
                  onSelect(color);
                  setOpen(false);
                }}
                className={`h-6 w-6 rounded-md cursor-pointer transition-[transform,box-shadow] duration-150 hover:scale-110 ${
                  color === currentColor
                    ? "ring-2 ring-foreground ring-offset-1 ring-offset-background"
                    : "hover:ring-2 hover:ring-foreground/30"
                }`}
                style={{ backgroundColor: color }}
                aria-label={`Select color ${color}`}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── List (issues) tab content ── */

function ProjectIssuesList({ projectId, companyId }: { projectId: string; companyId: string }) {
  const queryClient = useQueryClient();

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !!companyId,
  });

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(companyId),
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId),
    enabled: !!companyId,
    refetchInterval: 5000,
  });

  const liveIssueIds = useMemo(() => {
    const ids = new Set<string>();
    for (const run of liveRuns ?? []) {
      if (run.issueId) ids.add(run.issueId);
    }
    return ids;
  }, [liveRuns]);

  const { data: issues, isLoading, error } = useQuery({
    queryKey: queryKeys.issues.listByProject(companyId, projectId),
    queryFn: () => issuesApi.list(companyId, { projectId }),
    enabled: !!companyId,
  });

  const updateIssue = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      issuesApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listByProject(companyId, projectId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
    },
  });

  return (
    <IssuesList
      issues={issues ?? []}
      isLoading={isLoading}
      error={error as Error | null}
      agents={agents}
      liveIssueIds={liveIssueIds}
      projectId={projectId}
      viewStateKey={`paperclip:project-view:${projectId}`}
      onUpdateIssue={(id, data) => updateIssue.mutate({ id, data })}
    />
  );
}

/* ── Main project page ── */

export function ProjectDetail() {
  const { companyPrefix, projectId, filter } = useParams<{
    companyPrefix?: string;
    projectId: string;
    filter?: string;
  }>();
  const { companies, selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { openPanel, closePanel, panelVisible, setPanelVisible } = usePanel();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [mobilePropsOpen, setMobilePropsOpen] = useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const routeProjectRef = projectId ?? "";
  const [projectConfigPatch, setProjectConfigPatch] = useState<Record<string, unknown>>({});
  const routeCompanyId = useMemo(() => {
    if (!companyPrefix) return null;
    const requestedPrefix = companyPrefix.toUpperCase();
    return companies.find((company) => company.issuePrefix.toUpperCase() === requestedPrefix)?.id ?? null;
  }, [companies, companyPrefix]);
  const lookupCompanyId = routeCompanyId ?? selectedCompanyId ?? undefined;
  const canFetchProject = routeProjectRef.length > 0 && (isUuidLike(routeProjectRef) || Boolean(lookupCompanyId));

  const activeTab = routeProjectRef ? resolveProjectTab(location.pathname, routeProjectRef) : null;

  const { data: project, isLoading, error } = useQuery({
    queryKey: [...queryKeys.projects.detail(routeProjectRef), lookupCompanyId ?? null],
    queryFn: () => projectsApi.get(routeProjectRef, lookupCompanyId),
    enabled: canFetchProject,
  });
  const canonicalProjectRef = project ? projectRouteRef(project) : routeProjectRef;
  const projectLookupRef = project?.id ?? routeProjectRef;
  const resolvedCompanyId = project?.companyId ?? selectedCompanyId;

  useEffect(() => {
    if (!project?.companyId || project.companyId === selectedCompanyId) return;
    setSelectedCompanyId(project.companyId, { source: "route_sync" });
  }, [project?.companyId, selectedCompanyId, setSelectedCompanyId]);

  const invalidateProject = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(routeProjectRef) });
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(projectLookupRef) });
    if (resolvedCompanyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(resolvedCompanyId) });
    }
  };

  const updateProject = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      projectsApi.update(projectLookupRef, data, resolvedCompanyId ?? lookupCompanyId),
    onSuccess: () => {
      setProjectConfigPatch({});
      invalidateProject();
    },
  });

  const uploadImage = useMutation({
    mutationFn: async (file: File) => {
      if (!resolvedCompanyId) throw new Error("No company selected");
      return assetsApi.uploadImage(resolvedCompanyId, file, `projects/${projectLookupRef || "draft"}`);
    },
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Projects", href: "/projects" },
      { label: project?.name ?? routeProjectRef ?? "Project" },
    ]);
  }, [setBreadcrumbs, project, routeProjectRef]);

  useEffect(() => {
    if (!project) return;
    if (routeProjectRef === canonicalProjectRef) return;
    if (activeTab === "overview") {
      navigate(`/projects/${canonicalProjectRef}/overview`, { replace: true });
      return;
    }
    if (activeTab === "configuration") {
      navigate(`/projects/${canonicalProjectRef}/configuration`, { replace: true });
      return;
    }
    if (activeTab === "list") {
      if (filter) {
        navigate(`/projects/${canonicalProjectRef}/issues/${filter}`, { replace: true });
        return;
      }
      navigate(`/projects/${canonicalProjectRef}/issues`, { replace: true });
      return;
    }
    navigate(`/projects/${canonicalProjectRef}`, { replace: true });
  }, [project, routeProjectRef, canonicalProjectRef, activeTab, filter, navigate]);

  useEffect(() => {
    setProjectConfigPatch({});
  }, [project?.id, project?.updatedAt]);

  useEffect(() => {
    if (!project) return;
    if (activeTab === "configuration") {
      closePanel();
      return;
    }
    openPanel(<ProjectProperties project={project} onUpdate={(data) => updateProject.mutate(data)} />);
    return () => closePanel();
  }, [activeTab, project]); // eslint-disable-line react-hooks/exhaustive-deps

  // Redirect bare /projects/:id to /projects/:id/issues
  if (routeProjectRef && activeTab === null) {
    return <Navigate to={`/projects/${canonicalProjectRef}/issues`} replace />;
  }

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!project) return null;

  const handleTabChange = (tab: ProjectTab) => {
    if (tab === "overview") {
      navigate(`/projects/${canonicalProjectRef}/overview`);
    } else if (tab === "configuration") {
      navigate(`/projects/${canonicalProjectRef}/configuration`);
    } else {
      navigate(`/projects/${canonicalProjectRef}/issues`);
    }
  };

  // Keep this as a plain derived object instead of another hook. ProjectDetail
  // returns early while the project query is loading, so adding hooks below that
  // guard can break hook ordering between the loading and loaded renders.
  const configurationDraft = {
    ...project,
    ...projectConfigPatch,
    ...(Object.prototype.hasOwnProperty.call(projectConfigPatch, "goalIds") ? { goals: [] } : null),
  };
  const hasConfigChanges = Object.keys(projectConfigPatch).length > 0;
  return (
    <div className="space-y-6">
      <section className="paperclip-work-hero px-5 py-5 sm:px-6">
        <div className="flex flex-wrap items-start gap-4">
          <div className="paperclip-work-stat flex h-11 items-center px-3">
            <ColorPicker
              currentColor={project.color ?? "#6366f1"}
              onSelect={(color) => updateProject.mutate({ color })}
            />
            <span className="paperclip-work-meta ml-3">Project Color</span>
          </div>
          <div className="min-w-0 flex-1 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <p className="paperclip-work-kicker">Execution Lane</p>
              <StatusBadge status={project.status} />
              {project.targetDate ? <span className="paperclip-work-meta">Target {project.targetDate}</span> : null}
            </div>
            <InlineEditor
              value={project.name}
              onSave={(name) => updateProject.mutate({ name })}
              as="h2"
              className="paperclip-work-title"
            />
          </div>
          {activeTab !== "configuration" ? (
            <>
              <Button
                variant="ghost"
                size="icon-xs"
                className="paperclip-icon-button md:hidden shrink-0"
                onClick={() => setMobilePropsOpen(true)}
                title="Properties"
              >
                <SlidersHorizontal className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                className={cn(
                  "paperclip-icon-button hidden shrink-0 transition-opacity duration-200 md:flex",
                  panelVisible ? "pointer-events-none w-0 overflow-hidden opacity-0" : "opacity-100",
                )}
                onClick={() => setPanelVisible(true)}
                title="Show properties"
              >
                <SlidersHorizontal className="h-4 w-4" />
              </Button>
            </>
          ) : null}
        </div>
      </section>

      {/* Top-level project tabs */}
      <div className="paperclip-work-tabs flex items-center gap-1">
        <button
          className={`px-3 py-2 text-sm font-medium transition-colors border-b-2 ${
            activeTab === "overview"
              ? "border-foreground text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => handleTabChange("overview")}
        >
          Overview
        </button>
        <button
          className={`px-3 py-2 text-sm font-medium transition-colors border-b-2 ${
            activeTab === "list"
              ? "border-foreground text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => handleTabChange("list")}
        >
          List
        </button>
        <button
          className={`px-3 py-2 text-sm font-medium transition-colors border-b-2 ${
            activeTab === "configuration"
              ? "border-foreground text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => handleTabChange("configuration")}
        >
          Configuration
        </button>
      </div>

      {/* Tab content */}
      {activeTab === "overview" && (
        <OverviewContent
          project={project}
          onUpdate={(data) => updateProject.mutate(data)}
          imageUploadHandler={async (file) => {
            const asset = await uploadImage.mutateAsync(file);
            return asset.contentPath;
          }}
        />
      )}

      {activeTab === "list" && project?.id && resolvedCompanyId && (
        <ProjectIssuesList projectId={project.id} companyId={resolvedCompanyId} />
      )}

      {activeTab === "configuration" && configurationDraft && (
        <div className="space-y-4">
          <div className="paperclip-work-card-strong flex flex-wrap items-center justify-between gap-3 rounded-[calc(var(--radius)+0.45rem)] p-4">
            <div>
              <p className="paperclip-work-kicker">Control Surface</p>
              <h3 className="mt-1 text-sm font-medium">Project Configuration</h3>
              <p className="text-xs text-muted-foreground">
                Save roadmap linkage and project settings deliberately so reviews stay easy to follow.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={!hasConfigChanges}
                onClick={() => setProjectConfigPatch({})}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={!hasConfigChanges || updateProject.isPending}
                onClick={() => updateProject.mutate(projectConfigPatch)}
              >
                {updateProject.isPending ? "Saving..." : "Save changes"}
              </Button>
            </div>
          </div>
          <ProjectProperties
            project={configurationDraft}
            onUpdate={(patch) =>
              setProjectConfigPatch((current) => ({
                ...current,
                ...patch,
              }))
            }
          />
        </div>
      )}

      {/* Mobile properties drawer */}
      <Sheet open={activeTab !== "configuration" && mobilePropsOpen} onOpenChange={setMobilePropsOpen}>
        <SheetContent side="bottom" className="max-h-[85dvh] pb-[env(safe-area-inset-bottom)]">
          <SheetHeader>
            <SheetTitle className="text-sm">Properties</SheetTitle>
          </SheetHeader>
          <ScrollArea className="flex-1 overflow-y-auto">
            <div className="px-4 pb-4">
              <ProjectProperties project={project} onUpdate={(data) => updateProject.mutate(data)} />
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>
    </div>
  );
}
