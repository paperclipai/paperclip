import { lazy, Suspense, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Filter, Pencil, X } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { aiConnectionsApi } from "@/api/ai-connections";
import { getAdapterLabel } from "@/adapters/adapter-display-registry";
import { agentConnection, agentDefaultModel, bulkAgentDisabledReason, bulkAgentHarness, bulkConnectionName } from "@/lib/bulk-agent-settings";
import { pendingAgentSetupDisplayAdapter } from "@/lib/agent-setup-choice";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

const AgentBulkSettingsSheet = lazy(() => import("./AgentBulkSettingsSheet").then(m => ({ default: m.AgentBulkSettingsSheet })));

/** Shared by both roster layouts. Mount with a company key to isolate selection. */
export function AgentBulkRoster({ companyId, agents, visibleAgents, renderAgent }: {
  companyId: string; agents: Agent[]; visibleAgents: Agent[]; renderAgent: (agent: Agent) => ReactNode;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [filter, setFilter] = useState("all");
  const [editing, setEditing] = useState<Agent[] | null>(null);
  const [notice, setNotice] = useState("");
  const accounts = useQuery({ queryKey: ["ai-connections", companyId], queryFn: () => aiConnectionsApi.list(companyId), retry: false });
  const visible = visibleAgents.filter(a => filter === "all" || bulkAgentHarness(a) === filter);
  const selectable = visible.filter(a => !bulkAgentDisabledReason(a));
  const selectedAgents = agents.filter(a => selected.includes(a.id) && !bulkAgentDisabledReason(a));
  const harnesses = [...new Set(agents.map(bulkAgentHarness))].sort((a, b) => getAdapterLabel(a).localeCompare(getAdapterLabel(b)));
  const groups = [...new Set(selectedAgents.map(bulkAgentHarness))];
  const all = selectable.length > 0 && selectable.every(a => selected.includes(a.id));
  const some = selectable.some(a => selected.includes(a.id));
  const hidden = selectedAgents.filter(a => !visible.includes(a)).length;
  const toggleAll = () => setSelected(all ? selected.filter(id => !selectable.some(a => a.id === id)) : [...new Set([...selected, ...selectable.map(a => a.id)])]);

  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Filter agents" title={filter === "all" ? "Filter" : `Filter: ${getAdapterLabel(filter)}`}
            className={cn("relative h-8 w-8 shrink-0", filter !== "all" && "text-blue-600 dark:text-blue-400")}>
            <Filter className="h-3.5 w-3.5" aria-hidden />
            {filter !== "all" && <span aria-hidden className="absolute -right-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-blue-600 text-(length:--text-nano) font-bold text-white">1</span>}
          </Button>
        </PopoverTrigger>
        <PopoverContent aria-label="Agent filters" align="start" className="w-64 space-y-3 p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Filters</span>
            {filter !== "all" && <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setFilter("all")}>Clear</button>}
          </div>
          <div role="group" aria-label="Harness" className="space-y-1">
            <div className="px-2 text-xs font-medium text-muted-foreground">Harness</div>
            {["all", ...harnesses].map(h => <button key={h} type="button" aria-pressed={filter === h} onClick={() => setFilter(h)}
              className={cn("flex w-full items-center justify-between rounded-sm px-2 py-1 text-left text-sm", filter === h ? "bg-accent/50 text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground")}>
              {h === "all" ? "All harnesses" : getAdapterLabel(h)}{filter === h && <Check className="size-3.5" aria-hidden />}
            </button>)}
          </div>
        </PopoverContent>
      </Popover>
      <span className="text-xs text-muted-foreground">{visible.length} {visible.length === 1 ? "agent" : "agents"}</span>
    </div>
    {selectedAgents.length > 0 && <div role="region" aria-label="Bulk actions" className="sticky top-0 z-10 flex flex-wrap items-center gap-3 rounded-md border bg-muted p-3">
      <span className="text-sm font-medium">{selectedAgents.length} selected</span>
      {hidden > 0 && <span className="text-xs text-muted-foreground">{hidden} hidden by filters</span>}
      {groups.length > 1 && <span className="text-xs text-muted-foreground">Choose a harness to edit</span>}
      <div className="flex flex-1 flex-wrap items-center justify-end gap-2">{groups.map(h => <Button key={h} size="sm" variant="outline" onClick={() => setEditing(selectedAgents.filter(a => bulkAgentHarness(a) === h))}>
        <Pencil className="size-3.5" aria-hidden />{groups.length === 1 ? "Edit connection & model" : `Edit ${selectedAgents.filter(a => bulkAgentHarness(a) === h).length} ${getAdapterLabel(h)}`}
      </Button>)}<Button size="icon-sm" variant="ghost" aria-label="Clear selection" onClick={() => setSelected([])}><X className="size-4" /></Button></div>
    </div>}
    {notice && <p role="status" className="flex items-center gap-2 text-sm"><Check className="size-4" aria-hidden />{notice}</p>}
    {accounts.error && <p className="text-xs text-destructive">Connection names couldn’t be loaded. <Button variant="link" size="sm" onClick={() => void accounts.refetch()}>Retry</Button></p>}
    <div className="overflow-x-auto"><table aria-label="Agent roster" className="w-full text-left text-sm">
      <thead className="text-xs text-muted-foreground [&_th]:px-3 [&_th]:py-3 [&_th]:font-normal"><tr>
        <th className="w-10"><Checkbox aria-label="Select all visible editable agents" checked={all ? true : some ? "indeterminate" : false} disabled={!selectable.length} onCheckedChange={toggleAll} /></th>
        <th>Agent</th><th>Harness</th><th>Connection</th><th>Default model</th>
      </tr></thead>
      <tbody>{visible.map(agent => {
        const pendingSetup = pendingAgentSetupDisplayAdapter(agent);
        return <tr key={agent.id} data-state={selected.includes(agent.id) ? "selected" : undefined} className="border-t border-border data-[state=selected]:bg-accent/30 [&_td]:px-3">
        <td title={bulkAgentDisabledReason(agent)}><Checkbox aria-label={`Select ${agent.name}`} checked={selectedAgents.some(a => a.id === agent.id)} disabled={!!bulkAgentDisabledReason(agent)} onCheckedChange={value => setSelected(value ? [...new Set([...selected, agent.id])] : selected.filter(id => id !== agent.id))} /></td>
        <td className="min-w-64 p-0">{renderAgent(agent)}</td>
        <td className="whitespace-nowrap text-xs">{getAdapterLabel(pendingSetup ?? bulkAgentHarness(agent))}</td>
        <td className="text-xs">{pendingSetup ? "Not configured" : ["http", "process"].includes(agent.adapterType) ? "Managed externally" : bulkConnectionName(agentConnection(agent), accounts.data)}</td>
        <td className="font-mono text-xs">{pendingSetup ? "Not available yet" : agentDefaultModel(agent) ?? "Harness default"}</td>
      </tr>;
      })}</tbody>
    </table></div>
    {!visible.length && <p className="py-8 text-center text-sm text-muted-foreground">No agents match these filters.</p>}
    {editing && <Suspense fallback={<p role="status" className="text-sm text-muted-foreground">Loading editor…</p>}><AgentBulkSettingsSheet companyId={companyId} agents={editing} totalSelected={selectedAgents.length} onClose={(updatedIds, complete) => {
      setEditing(null);
      if (updatedIds.length) {
        setSelected(ids => ids.filter(id => !(complete ? editing.map(a => a.id) : updatedIds).includes(id)));
        setNotice(`Updated ${updatedIds.length} ${getAdapterLabel(bulkAgentHarness(editing[0]))} ${updatedIds.length === 1 ? "agent" : "agents"}.`);
      }
    }} /></Suspense>}
  </div>;
}
