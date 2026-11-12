import { useState } from "react";
import { ArrowRight, Check, Loader2, Pencil, X } from "lucide-react";
import { AgentAvatar } from "@/components/AgentAvatar";
import { AgentsToolbar } from "@/components/AgentsToolbar";
import { PageTabBar } from "@/components/PageTabBar";
import { ModelDropdown } from "@/components/AgentConfigForm";
import { AiConnectionSelect } from "@/components/ai-connections/AiConnectionSelect";
import { bindingProblem, type AiConnectionBinding } from "@/components/ai-connections/model";
import { DesignPageShell } from "@/components/DesignPageShell";
import { DesignSidebar } from "@/components/DesignSidebar";
import { AppLogo } from "@/pages/apps/AppLogo";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { DesignProposalAccess } from "./DesignProposalAccess";
import { bindingFor, connectionName, connections, harnesses, modelsFor, roster, type Harness, type RosterAgent } from "./bulk-agent-settings-data";

export interface BulkAgentSettingsProposalProps {
  selection?: "none" | "codex" | "mixed";
  editor?: "closed" | "connection" | "model" | "both" | "incompatible";
  failOne?: boolean;
}

function HarnessLabel({ harness }: { harness: RosterAgent["harness"] }) {
  if (harness === "external") return <span className="text-muted-foreground">External</span>;
  const info = harnesses[harness];
  return <span className="inline-flex items-center gap-2"><AppLogo name={info.label} brandKey={info.brand} size={16} compact />{info.label}</span>;
}

function BulkEditor({ agents, harness, totalSelected, initialEditor, failOne, saving, setSaving, onApply, onDone }: {
  agents: RosterAgent[];
  harness: Harness;
  totalSelected: number;
  initialEditor: BulkAgentSettingsProposalProps["editor"];
  failOne: boolean;
  saving: boolean;
  setSaving: (saving: boolean) => void;
  onApply: (ids: string[], change: { connectionId?: string; model?: string }) => void;
  onDone: (message?: string) => void;
}) {
  const info = harnesses[harness];
  const [changeConnection, setChangeConnection] = useState(initialEditor === "connection" || initialEditor === "both" || initialEditor === "incompatible");
  const [changeModel, setChangeModel] = useState(initialEditor === "model" || initialEditor === "both");
  const [binding, setBinding] = useState<AiConnectionBinding | undefined>(initialEditor === "incompatible" ? bindingFor("codex-limited") : undefined);
  const [model, setModel] = useState("");
  const [modelOpen, setModelOpen] = useState(false);
  const [failedIds, setFailedIds] = useState<string[] | null>(null);
  const [savedCount, setSavedCount] = useState(0);
  const [accountNotice, setAccountNotice] = useState(false);
  const targetConnection = binding?.mode === "responsible_user" ? "responsible_user" : binding?.connectionId;
  const targets = failedIds ? agents.filter(agent => failedIds.includes(agent.id)) : agents;
  const availableModels = info.models.filter(id => targets.every(agent => modelsFor(harness, changeConnection && targetConnection ? targetConnection : agent.connectionId).includes(id)));
  const invalid = targets.filter(agent => !modelsFor(harness, changeConnection && targetConnection ? targetConnection : agent.connectionId).includes(changeModel ? model : agent.model));
  const changed = targets.filter(agent => (changeConnection && targetConnection && targetConnection !== agent.connectionId) || (changeModel && model && model !== agent.model));
  const missing = (changeConnection && !targetConnection) || (changeModel && !model);
  const connectionError = changeConnection && binding && bindingProblem(binding, { companyId: "company-storybook", provider: info.provider }, connections, "user-board", agents[0].id);
  const canSave = changed.length > 0 && !missing && !connectionError && invalid.length === 0 && !saving;
  const otherCount = totalSelected - agents.length;
  const currentConnections = [...new Set(agents.map(agent => connectionName(agent.connectionId)))];
  const currentModels = [...new Set(agents.map(agent => agent.model))];

  async function save() {
    if (!canSave) return;
    setSaving(true);
    // Local fixture latency only. No HTTP mutation is made by this proposal.
    await new Promise(resolve => setTimeout(resolve, 650));
    const failures = failOne && failedIds === null ? [changed.at(-1)!.id] : [];
    const successes = changed.filter(agent => !failures.includes(agent.id));
    onApply(successes.map(agent => agent.id), { connectionId: changeConnection ? targetConnection : undefined, model: changeModel ? model : undefined });
    setSaving(false);
    if (failures.length) {
      setSavedCount(successes.length);
      setFailedIds(failures);
    } else {
      onDone(`Updated ${savedCount + successes.length} ${info.label} agents.`);
    }
  }

  return <>
    <SheetHeader className="px-6 pt-6 pb-0">
      <SheetTitle>Update {agents.length} {info.label} agents</SheetTitle>
      <SheetDescription>{otherCount > 0 ? `${otherCount} other selected agents won’t change.` : "Change their connection, default model, or both."}</SheetDescription>
    </SheetHeader>
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 py-2">
      <div className="flex flex-wrap gap-2" aria-label="Agents to update">
        {agents.map(agent => <span key={agent.id} className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs"><AgentAvatar agent={agent} size={20} />{agent.name}</span>)}
      </div>
      {failedIds && <div role="alert" className="space-y-2 rounded-md border border-destructive/30 p-3 text-sm">
        <p className="font-medium">{savedCount} updated · {failedIds.length} couldn’t be saved</p>
        <p className="text-muted-foreground">{targets.map(agent => agent.name).join(", ")}: connection interrupted while saving. Retry updates only this agent.</p>
      </div>}
      <fieldset disabled={saving || failedIds !== null} className="flex flex-col gap-6 disabled:opacity-60">
        <section className="space-y-3">
          <label className="flex cursor-pointer items-start gap-3">
            <Checkbox checked={changeConnection} onCheckedChange={value => setChangeConnection(value === true)} aria-label="Change connection" className="mt-0.5" />
            <span className="space-y-1"><span className="block text-sm font-medium">Change connection</span><span className="block text-xs text-muted-foreground">{currentConnections.length === 1 ? currentConnections[0] : `${currentConnections.length} different connections`}{!changeConnection && " · Keep current"}</span></span>
          </label>
          {changeConnection && <div className="space-y-2 pl-7">
            <AiConnectionSelect requirement={{ companyId: "company-storybook", provider: info.provider }} connections={connections}
              value={binding} currentUserId="user-board" agentId={agents[0].id} agentName={`${agents.length} agents`} adapterType={info.adapter}
              onChange={setBinding} onConnect={() => setAccountNotice(true)} />
            {accountNotice && <p role="status" className="text-xs text-muted-foreground">Account setup is outside this preview. Choose one of the sample connections.</p>}
          </div>}
        </section>
        <section className="space-y-3">
          <label className="flex cursor-pointer items-start gap-3">
            <Checkbox checked={changeModel} onCheckedChange={value => setChangeModel(value === true)} aria-label="Change default model" className="mt-0.5" />
            <span className="space-y-1"><span className="block text-sm font-medium">Change default model</span><span className="block text-xs text-muted-foreground">{currentModels.length === 1 ? currentModels[0] : `${currentModels.length} different models`}{!changeModel && " · Keep current"}</span></span>
          </label>
          {changeModel && <div className="pl-7"><ModelDropdown models={availableModels.map(id => ({ id, label: id }))} value={model} onChange={setModel}
            open={modelOpen} onOpenChange={setModelOpen} allowDefault={false} required groupByProvider={false} preserveOrder />
            <p className="pt-2 text-xs text-muted-foreground">Available on every selected agent’s {changeConnection ? "new connection" : "current connection"}.</p>
          </div>}
        </section>
      </fieldset>
      {!missing && invalid.length > 0 && <div role="alert" className="space-y-2 rounded-md border border-destructive/30 p-3 text-sm">
        <p className="font-medium">{invalid.map(agent => agent.name).join(", ")} needs a compatible model</p>
        <p className="text-muted-foreground">{changeModel ? model : invalid[0].model} isn’t available on the selected connection. Choose a different connection or change the default model.</p>
        {!changeModel && <Button size="sm" variant="outline" onClick={() => setChangeModel(true)}>Change default model</Button>}
      </div>}
      {!missing && changed.length > 0 && <section className="space-y-3" aria-label="Changes to apply">
        <h3 className="text-xs font-medium text-muted-foreground">CHANGES TO APPLY</h3>
        <div className="divide-y divide-border">{changed.map(agent => <div key={agent.id} className="space-y-1.5 py-3 text-xs">
          <p className="text-sm font-medium">{agent.name}</p>
          {changeConnection && targetConnection !== agent.connectionId && <p className="flex flex-wrap items-center gap-1.5 text-muted-foreground"><span>{connectionName(agent.connectionId)}</span><ArrowRight className="size-3" aria-label="to" /><span className="text-foreground">{connectionName(targetConnection!)}</span></p>}
          {changeModel && model !== agent.model && <p className="flex flex-wrap items-center gap-1.5 font-mono text-muted-foreground"><span>{agent.model}</span><ArrowRight className="size-3" aria-label="to" /><span className="text-foreground">{model}</span></p>}
        </div>)}</div>
        {targets.length > changed.length && <p className="text-xs text-muted-foreground">{targets.length - changed.length} already {targets.length - changed.length === 1 ? "has" : "have"} these settings.</p>}
      </section>}
      {!missing && changed.length === 0 && (changeConnection || changeModel) && <p className="text-sm text-muted-foreground">All selected agents already have these settings.</p>}
      <p className="text-xs text-muted-foreground">Applies to future runs. Running work continues with its current settings. Task-specific model overrides stay in place.</p>
    </div>
    <SheetFooter className="flex-row items-center justify-between border-t px-6 py-4">
      <Button variant="ghost" onClick={() => onDone()} disabled={saving}>{failedIds ? "Close" : "Cancel"}</Button>
      <Button onClick={() => void save()} disabled={!canSave}>{saving && <Loader2 className="size-4 animate-spin" aria-hidden />}{saving ? "Updating…" : failedIds ? `Retry ${failedIds.length} agent` : `Update ${changed.length || agents.length} agents`}</Button>
    </SheetFooter>
  </>;
}

function Proposal({ selection = "none", editor = "closed", failOne = false }: BulkAgentSettingsProposalProps) {
  const initialSelection = selection === "none" && editor !== "closed" ? "codex" : selection;
  const [agents, setAgents] = useState(roster);
  const [selected, setSelected] = useState<string[]>(roster.filter(agent => initialSelection === "mixed" ? agent.harness === "codex" || agent.harness === "claude" : initialSelection === "codex" && agent.harness === "codex").map(agent => agent.id));
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [filter, setFilter] = useState("all");
  const [editing, setEditing] = useState<Harness | null>(editor === "closed" ? null : "codex");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const visible = agents.filter(agent => (filter === "all" || agent.harness === filter) && (status === "all" || (status === "paused" ? agent.paused : !agent.paused)) && `${agent.name} ${agent.title}`.toLowerCase().includes(query.toLowerCase()));
  const selectable = visible.filter(agent => agent.harness !== "external");
  const selectedAgents = agents.filter(agent => selected.includes(agent.id));
  const groups = (Object.keys(harnesses) as Harness[]).filter(harness => selectedAgents.some(agent => agent.harness === harness));
  const checked = selectable.length > 0 && selectable.every(agent => selected.includes(agent.id));
  const someChecked = selectable.some(agent => selected.includes(agent.id));
  const hiddenCount = selectedAgents.filter(agent => !visible.includes(agent)).length;
  const toggleAll = () => setSelected(checked ? selected.filter(id => !selectable.some(agent => agent.id === id)) : [...new Set([...selected, ...selectable.map(agent => agent.id)])]);
  const close = (message?: string) => {
    setEditing(null);
    if (message) {
      setNotice(message);
      setSelected(selected.filter(id => agents.find(agent => agent.id === id)?.harness !== editing));
    }
  };

  return <div className="[&_.design-page-navigation]:hidden md:[&_.design-page-navigation]:flex">
    <DesignPageShell title="Agents" sidebarStorageKey="paperclip.proposal.bulk-agents.sidebar" sidebar={<DesignSidebar onNewTask={() => setNotice("This preview focuses on bulk agent settings.")} />}
      headerActions={<span className="text-xs text-muted-foreground">Interactive proposal · sample data</span>}>
      <Tabs value={status} onValueChange={setStatus} className="gap-4">
        <AgentsToolbar query={query} onQueryChange={setQuery} view="list" onViewChange={() => {}} hideViewToggle onNewAgent={() => setNotice("Agent creation is outside this preview.")} />
        <PageTabBar items={[{ value: "all", label: "All" }, { value: "active", label: "Active" }, { value: "paused", label: "Paused" }]} value={status} onValueChange={setStatus} align="start" />
        <TabsContent value={status} className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Select value={filter} onValueChange={setFilter}><SelectTrigger aria-label="Filter by harness" className="w-44"><SelectValue /></SelectTrigger><SelectContent>
              <SelectItem value="all">All harnesses</SelectItem>{(Object.keys(harnesses) as Harness[]).map(harness => <SelectItem key={harness} value={harness}>{harnesses[harness].label}</SelectItem>)}
              <SelectItem value="external">External</SelectItem>
            </SelectContent></Select>
            <span className="text-xs text-muted-foreground">{visible.length} agents</span>
          </div>
          {selected.length > 0 && <div role="region" aria-label="Bulk actions" className="sticky top-0 z-10 flex flex-wrap items-center gap-3 rounded-md border bg-muted p-3">
            <span className="text-sm font-medium">{selected.length} selected</span>
            {hiddenCount > 0 && <span className="text-xs text-muted-foreground">{hiddenCount} hidden by filters</span>}
            {groups.length > 1 && <span className="text-xs text-muted-foreground">Choose a harness to edit</span>}
            <div className="flex flex-1 flex-wrap items-center justify-end gap-2">{groups.map(harness => <Button key={harness} size="sm" variant="outline" onClick={() => setEditing(harness)}>
              <Pencil className="size-3.5" aria-hidden />{groups.length === 1 ? "Edit connection & model" : `Edit ${selectedAgents.filter(agent => agent.harness === harness).length} ${harnesses[harness].label}`}
            </Button>)}<Button size="icon-sm" variant="ghost" aria-label="Clear selection" onClick={() => setSelected([])}><X className="size-4" /></Button></div>
          </div>}
          {notice && <p role="status" className="flex items-center gap-2 text-sm"><Check className="size-4" aria-hidden />{notice}</p>}
          <div className="overflow-x-auto"><table aria-label="Agent roster" className="w-full text-left text-sm">
            <thead className="text-xs text-muted-foreground [&_th]:px-3 [&_th]:py-3 [&_th]:font-normal"><tr><th className="w-10"><Checkbox aria-label="Select all visible editable agents" checked={checked ? true : someChecked ? "indeterminate" : false} disabled={!selectable.length} onCheckedChange={toggleAll} /></th><th>Agent</th><th>Harness</th><th>Connection</th><th>Default model</th></tr></thead>
            <tbody className="[&_td]:px-3 [&_td]:py-3 [&_td]:whitespace-nowrap">{visible.map(agent => <tr className="border-t border-border data-[state=selected]:bg-accent/30" key={agent.id} data-testid={`agent-row-${agent.id}`} data-state={selected.includes(agent.id) ? "selected" : undefined}>
              <td><Checkbox aria-label={`Select ${agent.name}`} checked={selected.includes(agent.id)} disabled={agent.harness === "external"} onCheckedChange={value => setSelected(value ? [...selected, agent.id] : selected.filter(id => id !== agent.id))} /></td>
              <td><div className="flex items-center gap-3"><AgentAvatar agent={agent} size={32} /><div className="space-y-0.5"><span className="text-sm font-medium">{agent.name}</span><p className="text-xs text-muted-foreground">{agent.title}{agent.paused ? " · Paused" : ""}</p></div></div></td>
              <td className="text-xs"><HarnessLabel harness={agent.harness} /></td>
              <td className={cn("text-xs", !agent.connectionId && "text-muted-foreground")}>{agent.connectionId ? connectionName(agent.connectionId) : "Managed externally"}</td>
              <td className="font-mono text-xs">{agent.model || "—"}</td>
            </tr>)}</tbody>
          </table></div>
          {!visible.length && <p className="py-8 text-center text-sm text-muted-foreground">No agents match these filters.</p>}
          {!selected.length && <p className="text-xs text-muted-foreground">Select agents to update their connection or default model.</p>}
        </TabsContent>
      </Tabs>
    </DesignPageShell>
    <Sheet open={editing !== null} onOpenChange={open => { if (!open && !saving) close(); }}><SheetContent className="w-full sm:max-w-lg" showCloseButton={!saving}>
      {editing && <BulkEditor key={editing} agents={selectedAgents.filter(agent => agent.harness === editing)} harness={editing} totalSelected={selected.length} initialEditor={editor} failOne={failOne} saving={saving} setSaving={setSaving}
        onApply={(ids, change) => setAgents(current => current.map(agent => ids.includes(agent.id) ? { ...agent, connectionId: change.connectionId ?? agent.connectionId, model: change.model ?? agent.model } : agent))} onDone={close} />}
    </SheetContent></Sheet>
  </div>;
}

export function BulkAgentSettingsProposal(props: BulkAgentSettingsProposalProps) {
  return <DesignProposalAccess><Proposal {...props} /></DesignProposalAccess>;
}
