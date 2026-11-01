import { useRef, useState } from "react";
import { CheckCheck, ChevronDown, CircleAlert, FolderOpen, ListChecks, Search, SearchX, X } from "lucide-react";
import { CommandPalette } from "@/components/CommandPalette";
import { DesignPageShell } from "@/components/DesignPageShell";
import { DesignSidebar } from "@/components/DesignSidebar";
import { EmptyState } from "@/components/EmptyState";
import { MetricCard } from "@/components/MetricCard";
import { NewIssueDialog } from "@/components/NewIssueDialog";
import { TaskRowGroup } from "@/components/TaskRowGroup";
import { TaskSummaryList } from "@/components/TaskSummaryList";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { FlyoutHeader, FlyoutOptions } from "@/components/ui/flyout";
import { Input } from "@/components/ui/input";
import { useCompany } from "@/context/CompanyContext";
import { useDialogActions } from "@/context/DialogContext";
import { matchesTaskListView } from "@/lib/task-list-views";
import { DesignProposalAccess } from "./DesignProposalAccess";
import { projectHealthProjects, projectHealthTasks } from "./project-health-trial-data";

type ProjectView = "all" | "attention";
export type ProjectHealthTrialProps = {
  initialQuery?: string;
  initialView?: ProjectView;
  initialProjectId?: string;
  emptyOrganization?: boolean;
};

const projectViews = [
  { value: "all", label: "All projects" },
  { value: "attention", label: "Needs attention" },
] as const;
const projectStatusLabels = {
  backlog: "Backlog", planned: "Planned", in_progress: "In progress", completed: "Completed", cancelled: "Cancelled",
};

/** Trial-only project composition. Shared task semantics and UI remain unchanged. */
function ProjectHealthContent({ initialQuery = "", initialView = "all", initialProjectId, emptyOrganization = false }: ProjectHealthTrialProps) {
  const { selectedCompanyId } = useCompany();
  const { openNewIssue } = useDialogActions();
  const [query, setQuery] = useState(initialQuery);
  const [view, setView] = useState<ProjectView>(initialView);
  const [selectedId, setSelectedId] = useState<string | null>(initialProjectId ?? null);
  const searchRef = useRef<HTMLInputElement>(null);
  const projectButtons = useRef(new Map<string, HTMLButtonElement>());

  const projects = emptyOrganization ? [] : projectHealthProjects.filter(project => project.companyId === selectedCompanyId);
  const tasks = projectHealthTasks.filter(task => task.companyId === selectedCompanyId && projects.some(project => project.id === task.projectId));
  const needsAttention = (task: typeof tasks[number]) => matchesTaskListView("blocked", task, false, null);
  const projectsWithCounts = projects.map(project => {
    const projectTasks = tasks.filter(task => task.projectId === project.id);
    return {
      ...project,
      tasks: projectTasks.toSorted((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
      total: projectTasks.length,
      attention: projectTasks.filter(needsAttention).length,
      completed: projectTasks.filter(task => task.status === "done").length,
    };
  });
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleProjects = projectsWithCounts.filter(project =>
    (view === "all" || project.attention > 0)
    && `${project.name} ${project.description ?? ""}`.toLocaleLowerCase().includes(normalizedQuery),
  );
  // A filtered-out project must never leave unrelated tasks visible in the pane.
  const selectedProject = visibleProjects.find(project => project.id === selectedId);
  const clear = () => { setQuery(""); setView("all"); setSelectedId(null); searchRef.current?.focus(); };
  const closeSelection = () => {
    if (selectedId) projectButtons.current.get(selectedId)?.focus();
    setSelectedId(null);
  };

  return <>
    <DesignPageShell
      title="Project health"
      sidebarStorageKey="paperclip.design-proposal.project-health-trial.sidebar"
      rightSidebarStorageKey="paperclip.design-proposal.project-health-trial.aside"
      sidebar={<DesignSidebar recentTasks={tasks.toSorted((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()).slice(0, 5)} onNewTask={() => openNewIssue()} />}
      rightSidebarTitle="Recent tasks"
      rightSidebarControls={selectedProject && <Button variant="ghost" size="icon-sm" aria-label="Clear project selection" onClick={closeSelection}><X aria-hidden /></Button>}
      rightSidebar={selectedProject ? <>
        <div className="space-y-3">
          <h3 className="text-base font-semibold break-words" aria-live="polite">{selectedProject.name}</h3>
          <p className="text-sm text-muted-foreground">{selectedProject.description}</p>
          <Badge variant="outline">{projectStatusLabels[selectedProject.status]}</Badge>
        </div>
        {selectedProject.tasks.length ? <section className="space-y-3" aria-label="Selected project tasks">
          <p className="text-xs text-muted-foreground">Most recently updated · <span className="font-mono">{Math.min(6, selectedProject.total)} of {selectedProject.total}</span> tasks</p>
          <TaskRowGroup><TaskSummaryList issues={selectedProject.tasks.slice(0, 6)} label={`Recent tasks for ${selectedProject.name}`} /></TaskRowGroup>
        </section> : <EmptyState icon={ListChecks} message="No tasks yet" description="This project is ready for its first task. Select another project to review recent work." action="Browse projects" hideActionIcon onAction={closeSelection} />}
      </> : <EmptyState icon={FolderOpen} message="Select a project" description="Choose a project to see its recent tasks here." />}
    >
      <div className="space-y-8">
      <section aria-label="Project summary" className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, var(--sz-160px)), 1fr))" }}>
        <MetricCard appearance="card" icon={FolderOpen} value={projects.filter(project => project.status === "in_progress").length} label="Active projects" description="Projects in progress" />
        <MetricCard appearance="card" icon={CircleAlert} value={tasks.filter(needsAttention).length} label="Tasks needing attention" description="Blocked or awaiting review" />
        <MetricCard appearance="card" icon={CheckCheck} value={tasks.filter(task => task.status === "done").length} label="Completed tasks" description="Across all projects" />
      </section>
      <section className="space-y-4" aria-label="Projects">
        <div className="design-page-toolbar" role="group" aria-label="Project controls">
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button variant="outline" className="design-toolbar-button design-view-trigger" aria-label={`Project view: ${projectViews.find(option => option.value === view)!.label}`}>
              {projectViews.find(option => option.value === view)!.label}<ChevronDown aria-hidden />
            </Button></DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="task-list-options" aria-label="Project views">
              <DropdownMenuLabel asChild><FlyoutHeader className="task-list-options-heading">Views</FlyoutHeader></DropdownMenuLabel>
              <DropdownMenuRadioGroup value={view} onValueChange={value => { setView(value as ProjectView); setSelectedId(null); }} asChild>
                <FlyoutOptions className="task-list-options-items">
                  {projectViews.map(option => <DropdownMenuRadioItem key={option.value} value={option.value} className="task-list-options-item">{option.label}</DropdownMenuRadioItem>)}
                </FlyoutOptions>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="design-task-search">
            <Search aria-hidden />
            <Input ref={searchRef} aria-label="Search projects" placeholder="Search projects…" value={query} onChange={event => { setQuery(event.target.value); setSelectedId(null); }} />
            {query && <Button variant="ghost" size="icon-xs" aria-label="Clear search" onClick={() => { setQuery(""); searchRef.current?.focus(); }}><X aria-hidden /></Button>}
          </div>
        </div>
        <p role="status" className="text-sm text-muted-foreground"><span className="font-mono">{visibleProjects.length} of {projects.length}</span> projects{view === "attention" ? " · With blocked or in-review tasks" : " · Select a project to inspect recent work"}</p>
        {projects.length === 0 ? <EmptyState icon={FolderOpen} message="No projects yet" description="Projects bring related tasks together. This organization has no projects to review." />
          : visibleProjects.length === 0 ? <EmptyState icon={SearchX} message="No projects match this view" description="Try another name or description, or clear the current filters." action="Clear filters" hideActionIcon onAction={clear} />
            : <ul className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, var(--design-page-aside-min-width)), 1fr))" }} aria-label="Project cards">
              {visibleProjects.map(project => <li key={project.id} className="min-w-0">
                <Card elevation={selectedId === project.id ? "middle" : "low"} className="h-full gap-0 p-0">
                  <Button
                    ref={element => { if (element) projectButtons.current.set(project.id, element); else projectButtons.current.delete(project.id); }}
                    variant="ghost" className="h-full w-full min-w-0 flex-col items-stretch justify-start gap-4 whitespace-normal rounded-lg p-5 text-left"
                    aria-label={`View recent tasks for ${project.name}`} aria-pressed={selectedId === project.id}
                    aria-describedby={`${project.id}-status ${project.id}-description ${project.id}-counts`}
                    aria-controls="design-page-aside-content" onClick={() => setSelectedId(project.id)}
                  >
                    <span id={`${project.id}-status`} className="flex flex-wrap items-center gap-2"><Badge variant="outline">{projectStatusLabels[project.status]}</Badge>{project.attention > 0 && <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><CircleAlert aria-hidden />Needs attention</span>}</span>
                    <span className="flex flex-1 flex-col gap-2">
                      <span className="text-base font-semibold text-foreground break-words">{project.name}</span>
                      <span id={`${project.id}-description`} className="text-sm font-normal text-muted-foreground">{project.description}</span>
                    </span>
                    <span id={`${project.id}-counts`} className="flex flex-wrap gap-x-4 gap-y-2 text-xs font-normal text-muted-foreground">
                      <span><span className="font-mono text-foreground">{project.total}</span> tasks</span>
                      <span><span className="font-mono text-foreground">{project.attention}</span> attention</span>
                      <span><span className="font-mono text-foreground">{project.completed}</span> completed</span>
                    </span>
                  </Button>
                </Card>
              </li>)}
            </ul>}
      </section>
      </div>
    </DesignPageShell>
    <NewIssueDialog />
    <CommandPalette />
  </>;
}

export function ProjectHealthTrial(props: ProjectHealthTrialProps) {
  const { selectedCompanyId } = useCompany();
  return <DesignProposalAccess><ProjectHealthContent key={selectedCompanyId} {...props} /></DesignProposalAccess>;
}
