import { useState } from "react";
import { ArrowLeft, ArrowRight, Check, FolderOpen, Loader2, Plus, ShieldCheck, ShieldX, X } from "lucide-react";
import { AgentAvatar } from "@/components/AgentAvatar";
import { DesignPageShell } from "@/components/DesignPageShell";
import { DesignSidebar } from "@/components/DesignSidebar";
import { IssueStatusBadge } from "@/components/StatusBadge";
import { TaskChatBubble } from "@/components/task-chat/TaskChatBubble";
import { TaskChatLiveRunPill } from "@/components/task-chat/TaskChatLiveRunPill";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DesignProposalAccess } from "./DesignProposalAccess";

const projects = [
  { id: "product", name: "Product", repository: "acme/product" },
  { id: "extensions", name: "Agent Extensions", repository: "acme/agent-extensions" },
  { id: "website", name: "Website", repository: "acme/website" },
];
const agent = { id: "reviewer-preview", name: "Reviewer" };
const wait = () => new Promise<void>(resolve => setTimeout(resolve, 650));

export interface ProjectAccessProposalProps {
  initialView?: "task" | "permissions";
  initialState?: "blocked" | "access_saved";
  canManage?: boolean;
  failSave?: boolean;
  failRetry?: boolean;
  holdSaving?: boolean;
}

/** Design-only state machine. It never calls a permissions or execution API. */
function Proposal({ initialView = "task", initialState = "blocked", canManage = true,
  failSave = false, failRetry = false, holdSaving = false }: ProjectAccessProposalProps) {
  const [view, setView] = useState(initialView);
  const [allowed, setAllowed] = useState(initialState === "access_saved" ? ["product", "extensions"] : ["product"]);
  const [draft, setDraft] = useState(allowed);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [saveAttempted, setSaveAttempted] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const [run, setRun] = useState<"stopped" | "starting" | "replied">("stopped");
  const [retryError, setRetryError] = useState(false);
  const [retryAttempted, setRetryAttempted] = useState(false);
  const [shellNotice, setShellNotice] = useState("");
  const added = projects.filter(project => draft.includes(project.id) && !allowed.includes(project.id));
  const accessReady = allowed.includes("extensions");

  function openPermissions() {
    setDraft(allowed);
    setSavedNotice(false);
    setSaveError(false);
    setView("permissions");
  }

  async function save() {
    if (!canManage || saving || !added.length) return;
    setSaving(true);
    setSaveError(false);
    if (holdSaving) return;
    await wait();
    setSaving(false);
    setSaveAttempted(true);
    if (failSave && !saveAttempted) { setSaveError(true); return; }
    setAllowed([...draft]);
    setSavedNotice(true);
  }

  async function retry() {
    if (!accessReady || run === "starting") return;
    setRun("starting");
    setRetryError(false);
    await wait();
    setRetryAttempted(true);
    if (failRetry && !retryAttempted) { setRun("stopped"); setRetryError(true); return; }
    setRun("replied");
  }

  const task = <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>DEMO-42</span><span aria-hidden>·</span><FolderOpen className="size-3.5" aria-hidden /><span>Agent Extensions</span>
      </div>
      <div className="flex flex-wrap items-center gap-3"><h2 className="text-2xl font-semibold">Quick check-in</h2>
        <IssueStatusBadge status={run === "replied" ? "done" : run === "starting" ? "in_progress" : "blocked"} />
      </div>
      <span className="inline-flex items-center gap-2 text-sm text-muted-foreground"><AgentAvatar agent={agent} size={24} />Reviewer</span>
    </section>
    <TaskChatBubble item={{ id: "check-in", kind: "message", author: "human", authorName: "You", isCurrentUser: true, text: "Are you there?" }} />
    {run === "starting" ? <div role="status" aria-label="Retry in progress"><TaskChatLiveRunPill status="running" startedAtMs={null} toolSummary={null} /></div>
      : run === "replied" ? <TaskChatBubble item={{ id: "reply", kind: "message", author: "agent", authorName: agent.name, text: "Yes, I’m here. What would you like me to look at?" }} />
      : <section role={accessReady ? "status" : "alert"} aria-label="Project access" className="space-y-4 rounded-lg border border-border p-4">
        <div className="flex items-start gap-3">
          {accessReady ? <ShieldCheck className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden /> : <ShieldX className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden />}
          <div className="min-w-0 space-y-2">
            <h3 className="text-sm font-semibold">{accessReady ? "Project access is ready" : "Reviewer can’t access this project"}</h3>
            <p className="text-sm text-muted-foreground">{accessReady
              ? "Agent Extensions is now in Reviewer’s allowed projects. Retry to continue with your saved message."
              : "This task uses Agent Extensions, which isn’t in Reviewer’s allowed projects. The agent hasn’t started. Your message is saved."}</p>
            {!accessReady && !canManage && <p className="text-sm text-muted-foreground">An organization admin can add this project in Reviewer’s Permissions / Trust settings.</p>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 pl-8">
          {accessReady ? <Button size="sm" onClick={() => void retry()}>Retry task<ArrowRight className="size-4" aria-hidden /></Button>
            : canManage ? <Button size="sm" variant="outline" onClick={openPermissions}>Manage project access<ArrowRight className="size-4" aria-hidden /></Button>
              : <Button size="sm" variant="outline" onClick={openPermissions}>View agent access</Button>}
        </div>
        {retryError && <p role="alert" className="text-sm text-destructive">Couldn’t start the retry. Project access is saved. Try again.</p>}
        {!accessReady && <details className="pl-8 text-xs text-muted-foreground"><summary className="cursor-pointer">Run details</summary>
          <dl className="mt-3 grid grid-cols-2 gap-2"><dt>Stopped during</dt><dd>Workspace setup</dd><dt>Reason</dt><dd>Project outside allowed scope</dd><dt>Provider started</dt><dd>No</dd></dl>
        </details>}
      </section>}
    {run === "replied" && <Button variant="ghost" size="sm" className="self-start" onClick={openPermissions}>View saved project access</Button>}
  </div>;

  const permissions = <div className="mx-auto w-full max-w-3xl space-y-6">
    <Button variant="ghost" size="sm" onClick={() => setView("task")} disabled={saving}><ArrowLeft className="size-4" aria-hidden />Back to task</Button>
    <div className="flex items-center gap-3"><AgentAvatar agent={agent} size={40} /><div><h2 className="text-xl font-semibold">Reviewer</h2><p className="text-sm text-muted-foreground">Permissions / Trust</p></div></div>
    <section className="flex items-start gap-3 rounded-lg border p-4" aria-label="Trust preset">
      <ShieldCheck className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
      <div className="space-y-1"><h3 className="text-sm font-semibold">Low-trust review</h3><p className="text-sm text-muted-foreground">Runs in an isolated sandbox. Untrusted output stays quarantined.</p></div>
    </section>
    <section className="space-y-4" aria-labelledby="allowed-projects-heading">
      <div className="flex flex-wrap items-start justify-between gap-3"><div className="space-y-1">
        <h3 id="allowed-projects-heading" className="text-sm font-semibold">Allowed projects</h3>
        <p className="text-sm text-muted-foreground">Projects whose tasks and repositories this agent may access.</p>
      </div>
      {canManage && <Popover open={pickerOpen} onOpenChange={setPickerOpen}><PopoverTrigger asChild>
        <Button variant="outline" size="sm" disabled={saving}><Plus className="size-4" aria-hidden />Add project</Button>
      </PopoverTrigger><PopoverContent align="end" className="w-72 space-y-3">
        <Input aria-label="Search projects" placeholder="Search projects…" value={query} onChange={event => setQuery(event.target.value)} />
        <div className="space-y-1">{projects.filter(project => `${project.name} ${project.repository}`.toLowerCase().includes(query.toLowerCase())).map(project => <label key={project.id} className="flex cursor-pointer items-start gap-3 rounded-md px-2 py-2 hover:bg-accent">
          <Checkbox aria-label={project.name} checked={draft.includes(project.id)} disabled={allowed.includes(project.id)} className="mt-0.5"
            onCheckedChange={checked => { setDraft(current => checked ? [...new Set([...current, project.id])] : current.filter(id => id !== project.id)); setSavedNotice(false); }} />
          <span className="min-w-0"><span className="block text-sm">{project.name}</span><span className="block text-xs text-muted-foreground">{allowed.includes(project.id) ? "Already allowed" : project.repository}</span></span>
        </label>)}</div>
        {!projects.some(project => `${project.name} ${project.repository}`.toLowerCase().includes(query.toLowerCase())) && <p className="px-2 text-sm text-muted-foreground">No projects found.</p>}
        <Button variant="secondary" size="sm" className="w-full" onClick={() => setPickerOpen(false)}>Done</Button>
      </PopoverContent></Popover>}
      </div>
      <ul aria-label="Allowed projects" className="divide-y divide-border rounded-lg border">
        {projects.filter(project => draft.includes(project.id)).map(project => <li key={project.id} className="flex items-center gap-3 p-4" data-testid={`project-${project.id}`}>
          <FolderOpen className="size-4 shrink-0 text-muted-foreground" aria-hidden /><div className="min-w-0 flex-1"><p className="text-sm font-medium">{project.name}</p><p className="break-all text-xs text-muted-foreground">{project.repository}</p></div>
          {allowed.includes(project.id) ? <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Check className="size-3.5" aria-hidden />Allowed</span>
            : <><span className="text-xs text-muted-foreground">To add</span><Button size="icon-sm" variant="ghost" aria-label={`Undo adding ${project.name}`} disabled={saving} onClick={() => setDraft(current => current.filter(id => id !== project.id))}><X className="size-4" aria-hidden /></Button></>}
        </li>)}
      </ul>
      {!accessReady && <p className="text-sm text-muted-foreground">DEMO-42 is waiting for access to <span className="font-medium text-foreground">Agent Extensions</span>.</p>}
      {!canManage && <p role="note" className="text-sm text-muted-foreground">Only people with agent configuration permission can change this access.</p>}
      {added.length > 0 && <div aria-label="Changes to save" className="space-y-2 rounded-md bg-muted p-4 text-sm">
        <p className="font-medium">Add access to {added.map(project => project.name).join(" and ")}</p>
        <p className="text-muted-foreground">Reviewer will be able to access work and repositories in {added.length === 1 ? "this project" : "these projects"}. Existing project access and low-trust restrictions stay in place.</p>
      </div>}
      {saveError && <p role="alert" className="text-sm text-destructive">Couldn’t save project access. No permissions changed. Your selection is kept.</p>}
      {savedNotice && <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-muted p-4 text-sm">
        <span className="inline-flex items-center gap-2"><Check className="size-4" aria-hidden />Project access saved.</span>
        <Button variant="outline" size="sm" onClick={() => setView("task")}>Return to task<ArrowRight className="size-4" aria-hidden /></Button>
      </div>}
      {canManage && <div className="flex items-center justify-between gap-3 border-t pt-4">
        <Button variant="ghost" disabled={saving} onClick={() => { setDraft(allowed); setSaveError(false); setView("task"); }}>Cancel</Button>
        <Button disabled={!added.length || saving} onClick={() => void save()}>{saving && <Loader2 className="size-4 animate-spin" aria-hidden />}{saving ? "Saving access…" : saveError ? "Try saving again" : "Save project access"}</Button>
      </div>}
    </section>
  </div>;

  return <div className="[&_.design-page-navigation]:hidden md:[&_.design-page-navigation]:flex">
    <DesignPageShell title={view === "task" ? "Tasks / DEMO-42" : "Agents / Reviewer"} sidebarStorageKey="paperclip.proposal.project-access.sidebar"
      sidebar={<DesignSidebar onNewTask={() => setShellNotice("This preview focuses on project access. Use Manage project access to try the repair.")} />}
      headerActions={<span className="text-xs text-muted-foreground">Design preview</span>}>
      {shellNotice && <p role="status" className="text-xs text-muted-foreground">{shellNotice}</p>}
      {view === "task" ? task : permissions}
    </DesignPageShell>
  </div>;
}

export function ProjectAccessProposal(props: ProjectAccessProposalProps) {
  return <DesignProposalAccess><Proposal {...props} /></DesignProposalAccess>;
}
