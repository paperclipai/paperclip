import { useEffect, useRef, useState } from "react";
import type { Agent, Issue } from "@paperclipai/shared";
import { CirclePause, Coffee, ListChecks, SearchX, Users, Zap } from "lucide-react";
import { AgentAvatar } from "@/components/AgentAvatar";
import { CollectionToolbar } from "@/components/CollectionToolbar";
import { CommandPalette } from "@/components/CommandPalette";
import { DesignPageShell } from "@/components/DesignPageShell";
import { DesignSidebar } from "@/components/DesignSidebar";
import { EmptyState } from "@/components/EmptyState";
import { MetricCard } from "@/components/MetricCard";
import { NewIssueDialog } from "@/components/NewIssueDialog";
import { AgentStatusCapsule } from "@/components/StatusBadge";
import { TabFilters } from "@/components/TabBar";
import { TaskRowGroup } from "@/components/TaskRowGroup";
import { TaskSummaryList } from "@/components/TaskSummaryList";
import { ToolbarSearch } from "@/components/ToolbarSearch";
import { SidePanelWindowControls } from "@/components/side-panel";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useCompany } from "@/context/CompanyContext";
import { useDialogActions } from "@/context/DialogContext";
import { DesignProposalAccess } from "./DesignProposalAccess";
import { workloadAgents, workloadTasks } from "./agent-workload-trial-data";
import "./agent-workload-trial.css";

type WorkloadState = "working" | "idle" | "paused";
type WorkloadFilter = "all" | WorkloadState;
export type AgentWorkloadTrialProps = {
  initialQuery?: string;
  initialFilter?: WorkloadFilter;
  initialAgentId?: string;
  emptyOrganization?: boolean;
};

const filters = [
  { value: "all", label: "All" }, { value: "working", label: "Working" },
  { value: "idle", label: "Idle" }, { value: "paused", label: "Paused" },
] as const;
const stateLabels = { working: "Working", idle: "Idle", paused: "Paused" };
const workloadState = (agent: Agent): WorkloadState => agent.status === "running" ? "working" : agent.status === "paused" ? "paused" : "idle";
const activeTask = (task: Issue) => task.status === "in_progress";
const queuedTask = (task: Issue) => task.status === "todo" || task.status === "backlog";
const newestFirst = (a: Issue, b: Issue) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();

/** The caller supplies workload membership; row presentation stays entirely shared. */
function TaskSection({ title, tasks, label, emptyMessage }: { title: string; tasks: Issue[]; label: string; emptyMessage: string }) {
  return <section className="space-y-3" aria-label={label}>
    <h3 className="text-sm font-semibold">{title} <span className="font-mono font-normal text-muted-foreground">{tasks.length}</span></h3>
    {tasks.length ? <TaskRowGroup><TaskSummaryList issues={tasks.slice(0, 6)} label={label} /></TaskRowGroup>
      : <p className="text-sm text-muted-foreground">{emptyMessage}</p>}
    {tasks.length > 6 && <p className="text-xs text-muted-foreground">Showing the six most recently updated tasks.</p>}
  </section>;
}

function AgentWorkloadContent({ initialQuery = "", initialFilter = "all", initialAgentId, emptyOrganization = false }: AgentWorkloadTrialProps) {
  const { selectedCompanyId } = useCompany();
  const { openNewIssue } = useDialogActions();
  const [query, setQuery] = useState(initialQuery);
  const [filter, setFilter] = useState<WorkloadFilter>(initialFilter);
  const [selectedId, setSelectedId] = useState<string | null>(initialAgentId ?? null);
  const [maximized, setMaximized] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const cardRefs = useRef(new Map<string, HTMLButtonElement>());
  const agents = emptyOrganization ? [] : workloadAgents.filter(agent => agent.companyId === selectedCompanyId);
  const tasks = workloadTasks.filter(task => task.companyId === selectedCompanyId && agents.some(agent => agent.id === task.assigneeAgentId));
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const visibleAgents = agents.filter(agent => (filter === "all" || workloadState(agent) === filter)
    && words.every(word => `${agent.name} ${agent.role} ${agent.title ?? ""}`.toLocaleLowerCase().includes(word)));
  const selectedAgent = visibleAgents.find(agent => agent.id === selectedId);
  const selectedTasks = tasks.filter(task => task.assigneeAgentId === selectedAgent?.id).toSorted(newestFirst);
  const active = selectedTasks.filter(activeTask);
  const recent = selectedTasks.filter(task => !activeTask(task) && !queuedTask(task));

  useEffect(() => {
    if (selectedAgent) document.getElementById("design-page-aside-content")?.focus();
  }, [selectedAgent?.id]);

  const dismiss = () => {
    const returnId = selectedId;
    setSelectedId(null);
    setMaximized(false);
    requestAnimationFrame(() => { if (returnId) cardRefs.current.get(returnId)?.focus(); });
  };
  const changeQuery = (next: string) => { setQuery(next); setSelectedId(null); setMaximized(false); };
  const changeFilter = (next: WorkloadFilter) => { setFilter(next); setSelectedId(null); setMaximized(false); };
  const clear = () => { changeQuery(""); setFilter("all"); searchRef.current?.focus(); };

  return <div className="agent-workload-trial" onKeyDown={event => {
    if (event.key === "Escape" && !event.defaultPrevented && selectedAgent) { event.preventDefault(); dismiss(); }
  }}>
    <DesignPageShell
      title="Agent workload"
      sidebarStorageKey="paperclip.design-proposal.agent-workload-trial.sidebar"
      rightSidebarStorageKey="paperclip.design-proposal.agent-workload-trial.aside"
      sidebar={<DesignSidebar recentTasks={tasks.toSorted(newestFirst).slice(0, 5)} onNewTask={() => openNewIssue()} />}
      rightSidebarTitle="Agent tasks"
      rightSidebarMaximized={maximized}
      rightSidebarControls={<SidePanelWindowControls maximized={maximized} onMaximizedChange={setMaximized} onToggle={dismiss} closeControl="close" />}
      rightSidebar={selectedAgent && <>
        <div className="space-y-3">
          <AgentAvatar agent={selectedAgent} size={48} />
          <h2 className="break-words text-lg font-semibold">{selectedAgent.name}</h2>
          <p className="text-sm text-muted-foreground">{selectedAgent.title}</p>
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><AgentStatusCapsule status={selectedAgent.status} />{stateLabels[workloadState(selectedAgent)]}</p>
          {selectedAgent.status === "paused" && <p className="text-xs text-muted-foreground">Work is paused. Queued tasks stay assigned.</p>}
        </div>
        {selectedTasks.length ? <>
          <TaskSection title="Active tasks" tasks={active} label={`Active tasks for ${selectedAgent.name}`} emptyMessage="No active tasks. This agent is not working on a task right now." />
          <TaskSection title="Recent tasks" tasks={recent} label={`Recent tasks for ${selectedAgent.name}`} emptyMessage="No recent task history yet." />
          <p className="text-xs text-muted-foreground"><span className="font-mono">{selectedTasks.filter(queuedTask).length}</span> queued tasks · Todo and backlog</p>
        </> : <EmptyState icon={ListChecks} message="No tasks yet" description="This agent has no assigned task history. Select another agent to inspect its workload." action="Back to agents" hideActionIcon onAction={dismiss} />}
      </>}
    >
      <section aria-label="Workload summary" className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, var(--sz-160px)), 1fr))" }}>
        <MetricCard appearance="card" icon={Zap} value={agents.filter(agent => workloadState(agent) === "working").length} label="Working agents" description="Currently running" />
        <MetricCard appearance="card" icon={Coffee} value={agents.filter(agent => workloadState(agent) === "idle").length} label="Idle agents" description="Available for work" />
        <MetricCard appearance="card" icon={CirclePause} value={agents.filter(agent => workloadState(agent) === "paused").length} label="Paused agents" description="Work on hold" />
      </section>
      <CollectionToolbar
        ariaLabel="Agent workload controls"
        search={<ToolbarSearch query={query} onQueryChange={changeQuery} inputRef={searchRef} label="Search agents" placeholder="Search agents…" />}
        controls={<TabFilters items={filters} value={filter} onValueChange={changeFilter} label="Agent state" />}
        feedback={<p className="text-sm text-muted-foreground" role="status"><span className="font-mono">{visibleAgents.length} of {agents.length}</span> agents · {selectedAgent ? "Viewing assigned work" : "Select an agent to inspect its tasks"}</p>}
      />
      {agents.length === 0 ? <EmptyState icon={Users} message="No agents in this organization" description="There is no workload to review yet. Choose an organization with agents to inspect their work." />
        : visibleAgents.length === 0 ? <EmptyState icon={SearchX} message="No agents match this view" description="Search by name or role, or clear the current search and state filter." action="Clear filters" hideActionIcon onAction={clear} />
          : <ul aria-label="Agent cards" className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, var(--design-page-aside-min-width)), 1fr))" }}>
            {visibleAgents.map(agent => {
              const assigned = tasks.filter(task => task.assigneeAgentId === agent.id);
              return <li key={agent.id} className="min-w-0">
                <Card elevation={selectedAgent?.id === agent.id ? "middle" : "low"} className="h-full gap-0 p-0">
                  <Button variant="ghost"
                    ref={element => { if (element) cardRefs.current.set(agent.id, element); else cardRefs.current.delete(agent.id); }}
                    className="h-full w-full min-w-0 flex-col items-stretch justify-start gap-4 whitespace-normal rounded-lg p-5 text-left"
                    aria-label={`View workload for ${agent.name}`} aria-describedby={`${agent.id}-role ${agent.id}-details`}
                    aria-expanded={selectedAgent?.id === agent.id} aria-controls={selectedAgent?.id === agent.id ? "design-page-aside-content" : undefined}
                    onClick={() => { setSelectedId(agent.id); setMaximized(false); }}
                  >
                    <span className="flex items-start gap-3"><AgentAvatar agent={agent} size={48} /><span className="min-w-0 flex-1 space-y-1"><span className="block break-words text-base font-semibold text-foreground">{agent.name}</span><span id={`${agent.id}-role`} className="block text-sm font-normal text-muted-foreground">{agent.title}</span></span></span>
                    <span id={`${agent.id}-details`} className="flex flex-col gap-3 text-sm font-normal text-muted-foreground">
                      <span className="flex items-center gap-2"><AgentStatusCapsule status={agent.status} />{stateLabels[workloadState(agent)]}</span>
                      <span className="flex flex-wrap gap-x-4 gap-y-2 text-xs"><span><span className="font-mono text-foreground">{assigned.filter(activeTask).length}</span> active tasks</span><span><span className="font-mono text-foreground">{assigned.filter(queuedTask).length}</span> queued tasks</span></span>
                    </span>
                  </Button>
                </Card>
              </li>;
            })}
          </ul>}
    </DesignPageShell>
    <NewIssueDialog />
    <CommandPalette />
  </div>;
}

export function AgentWorkloadTrial(props: AgentWorkloadTrialProps) {
  const { selectedCompanyId } = useCompany();
  return <DesignProposalAccess><AgentWorkloadContent key={selectedCompanyId} {...props} /></DesignProposalAccess>;
}
