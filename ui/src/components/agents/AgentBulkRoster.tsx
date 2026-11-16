import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Pencil, X } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { describeError } from "@/api/errors";
import { bindAccount } from "@/lib/account-scope";
import { aiConnectionsApi } from "@/api/ai-connections";
import { getAdapterLabel } from "@/adapters/adapter-display-registry";
import { bulkAgentDisabledReason, bulkAgentHarness } from "@/lib/bulk-agent-settings";
import { buildAgentRosterIndex } from "@/lib/agent-roster-filters";
import { AgentStatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

const AgentBulkSettingsSheet = lazy(() => import("./AgentBulkSettingsSheet").then(m => ({ default: m.AgentBulkSettingsSheet })));

/** Shared by both roster layouts. Mount with a company key to isolate selection. */
export function AgentBulkRoster({ companyId, agents, visibleAgents, renderAgent, renderChat, renderStatus }: {
  companyId: string; agents: Agent[]; visibleAgents: Agent[]; renderAgent: (agent: Agent) => ReactNode;
  renderChat?: (agent: Agent) => ReactNode;
  renderStatus?: (agent: Agent) => ReactNode;
}) {
  const client = useQueryClient();
  const openingRef = useRef(false);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const selectionRevision = useRef(0);
  const changeSelection = (next: SetStateAction<string[]>) => {
    selectionRevision.current += 1;
    setSelected(next);
  };
  const [editing, setEditing] = useState<Agent[] | null>(null);
  const [notice, setNotice] = useState("");
  const accounts = useQuery({ queryKey: ["ai-connections", companyId], queryFn: () => aiConnectionsApi.list(companyId) });
  const visible = visibleAgents;
  const rosterIndex = useMemo(() => buildAgentRosterIndex(agents, accounts.data), [agents, accounts.data]);
  const selectable = visible.filter(a => !bulkAgentDisabledReason(a));
  const selectedAgents = useMemo(() => agents.filter(a => selected.includes(a.id) && !bulkAgentDisabledReason(a)), [agents, selected]);
  const [lastSelection, setLastSelection] = useState<Agent[]>([]);
  useEffect(() => { if (selectedAgents.length) setLastSelection(selectedAgents); }, [selectedAgents]);
  // Retain the card contents while it drops out, so its width does not collapse mid-animation.
  const actionAgents = selectedAgents.length ? selectedAgents : lastSelection;
  const groups = [...new Set(actionAgents.map(bulkAgentHarness))];
  const all = selectable.length > 0 && selectable.every(a => selected.includes(a.id));
  const some = selectable.some(a => selected.includes(a.id));
  const hidden = actionAgents.filter(a => !visible.includes(a)).length;
  const toggleAll = () => changeSelection(all ? selected.filter(id => !selectable.some(a => a.id === id)) : [...new Set([...selected, ...selectable.map(a => a.id)])]);

  async function openEditor(harness: string) {
    if (openingRef.current) return;
    openingRef.current = true; setOpening(true); setOpenError("");
    const account = bindAccount(client);
    const revision = selectionRevision.current;
    try {
      await account.whenAccountReady();
      if (!account.isCurrentAccount() || revision !== selectionRevision.current) return;
      const complete = await Promise.all(selectedAgents.filter(a => bulkAgentHarness(a) === harness)
        .map(a => agentsApi.get(a.id, companyId, { cache: "no-store", fresh: true })));
      if (!account.isCurrentAccount() || revision !== selectionRevision.current) return;
      // The display cache excludes private runtime fields. Only complete,
      // freshly authorized agents can become the editor's optimistic base.
      if (complete.some(a => a.companyId !== companyId || bulkAgentHarness(a) !== harness || bulkAgentDisabledReason(a))) {
        setOpenError("The selected agents changed. Refresh the roster and select them again.");
        return;
      }
      setEditing(complete);
    } catch (error) {
      if (account.isCurrentScope() && revision === selectionRevision.current) setOpenError(describeError(error).body);
    } finally { openingRef.current = false; setOpening(false); }
  }

  return <div className="space-y-4">
    {createPortal(<div role="region" aria-label="Bulk actions" aria-hidden={selectedAgents.length === 0} inert={selectedAgents.length === 0}
      data-state={selectedAgents.length > 0 ? "open" : "closed"} className="agent-selection-bar flex flex-wrap items-center gap-3 rounded-lg border bg-background p-3">
      <span className="text-sm font-medium">{actionAgents.length} selected</span>
      {hidden > 0 && <span className="text-xs text-muted-foreground">{hidden} hidden by filters</span>}
      {groups.length > 1 && <span className="text-xs text-muted-foreground">Choose a harness to edit</span>}
      <div className="flex flex-1 flex-wrap items-center justify-end gap-2">{groups.map(h => <Button key={h} size="sm" variant="outline" disabled={opening} onClick={() => void openEditor(h)}>
        <Pencil className="size-3.5" aria-hidden />{groups.length === 1 ? "Edit connection & model" : `Edit ${actionAgents.filter(a => bulkAgentHarness(a) === h).length} ${getAdapterLabel(h)}`}
      </Button>)}<Button size="icon-sm" variant="ghost" aria-label="Clear selection" onClick={() => changeSelection([])}><X className="size-4" /></Button></div>
    </div>, document.body)}
    {opening && <p role="status" className="text-sm text-muted-foreground">Loading current agent settings…</p>}
    {openError && <p role="alert" className="text-sm text-destructive">{openError}</p>}
    {notice && <p role="status" className="flex items-center gap-2 text-sm"><Check className="size-4" aria-hidden />{notice}</p>}
    <div className="overflow-x-auto"><table aria-label="Agent roster" className="agent-roster w-full text-left text-sm">
      <thead className="text-xs text-muted-foreground [&_th]:px-3 [&_th]:py-3 [&_th]:font-normal"><tr>
        <th className="w-10"><Checkbox aria-label="Select all visible editable agents" checked={all ? true : some ? "indeterminate" : false} disabled={!selectable.length} onCheckedChange={toggleAll} /></th>
        <th scope="col">{visible.length} {visible.length === 1 ? "agent" : "agents"}</th>{renderChat && <th scope="col"><span className="sr-only">Chat</span></th>}<th scope="col">Status</th><th scope="col">Harness</th><th scope="col">Default model</th><th scope="col">Connection</th>
      </tr></thead>
      <tbody>{visible.map(agent => {
        const metadata = rosterIndex.byAgentId.get(agent.id)!;
        return <tr key={agent.id} data-state={selected.includes(agent.id) ? "selected" : undefined} className="group/agent-row border-t border-border data-[state=selected]:bg-accent/30 hover:bg-accent/50 focus-within:bg-accent/50 [&_td]:px-3 [&_td]:align-middle">
        <td title={bulkAgentDisabledReason(agent)}><Checkbox aria-label={`Select ${agent.name}`} checked={selectedAgents.some(a => a.id === agent.id)} disabled={!!bulkAgentDisabledReason(agent)} onCheckedChange={value => changeSelection(value ? [...new Set([...selected, agent.id])] : selected.filter(id => id !== agent.id))} /></td>
        <td className="min-w-64 p-0">{renderAgent(agent)}</td>
        {renderChat && <td>{renderChat(agent)}</td>}
        <td>{renderStatus ? renderStatus(agent) : <AgentStatusBadge status={agent.status} />}</td>
        <td className="whitespace-nowrap text-xs">{metadata.harness.label}</td>
        <td className="text-xs">{metadata.model.label}</td>
        <td className="text-xs">{metadata.connection.label}</td>
      </tr>;
      })}</tbody>
    </table></div>
    {!visible.length && <p className="py-8 text-center text-sm text-muted-foreground">No agents match these filters.</p>}
    {editing && <Suspense fallback={<p role="status" className="text-sm text-muted-foreground">Loading editor…</p>}><AgentBulkSettingsSheet companyId={companyId} agents={editing} totalSelected={selectedAgents.length} onClose={(updatedIds, complete) => {
      setEditing(null);
      if (updatedIds.length) {
        changeSelection(ids => ids.filter(id => !(complete ? editing.map(a => a.id) : updatedIds).includes(id)));
        setNotice(`Updated ${updatedIds.length} ${getAdapterLabel(bulkAgentHarness(editing[0]))} ${updatedIds.length === 1 ? "agent" : "agents"}.`);
      }
    }} /></Suspense>}
  </div>;
}
