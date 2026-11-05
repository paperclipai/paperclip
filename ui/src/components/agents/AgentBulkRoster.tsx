import { useTranslation } from "@/i18n";
import { lazy, Suspense, useRef, useState, type ReactNode, type SetStateAction } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Filter, Pencil, X } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { describeError } from "@/api/errors";
import { bindAccount } from "@/lib/account-scope";
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
  const { t } = useTranslation("agent-config");
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
  const [filter, setFilter] = useState("all");
  const [editing, setEditing] = useState<Agent[] | null>(null);
  const [notice, setNotice] = useState("");
  const accounts = useQuery({ queryKey: ["ai-connections", companyId], queryFn: () => aiConnectionsApi.list(companyId) });
  const visible = visibleAgents.filter(a => filter === "all" || bulkAgentHarness(a) === filter);
  const selectable = visible.filter(a => !bulkAgentDisabledReason(a));
  const selectedAgents = agents.filter(a => selected.includes(a.id) && !bulkAgentDisabledReason(a));
  const harnesses = [...new Set(agents.map(bulkAgentHarness))].sort((a, b) => getAdapterLabel(a).localeCompare(getAdapterLabel(b)));
  const groups = [...new Set(selectedAgents.map(bulkAgentHarness))];
  const all = selectable.length > 0 && selectable.every(a => selected.includes(a.id));
  const some = selectable.some(a => selected.includes(a.id));
  const hidden = selectedAgents.filter(a => !visible.includes(a)).length;
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
        setOpenError(t("agent-config:theSelectedAgentsChangedRefreshTheRosterAnd_2aa474a"));
        return;
      }
      setEditing(complete);
    } catch (error) {
      if (account.isCurrentScope() && revision === selectionRevision.current) setOpenError(describeError(error).body);
    } finally { openingRef.current = false; setOpening(false); }
  }

  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={t("agent-config:filterAgents_9b26f6c")} title={filter === "all" ? t("agent-config:filter_d7decf1") : t("agent-config:filterValue_378f3d4", { value1: getAdapterLabel(filter) })}
            className={cn("relative h-8 w-8 shrink-0", filter !== "all" && "text-blue-600 dark:text-blue-400")}>
            <Filter className="h-3.5 w-3.5" aria-hidden />
            {filter !== "all" && <span aria-hidden className="absolute -right-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-blue-600 text-(length:--text-nano) font-bold text-white">1</span>}
          </Button>
        </PopoverTrigger>
        <PopoverContent aria-label={t("agent-config:agentFilters_e6daec4")} align="start" className="w-64 space-y-3 p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">{t("agent-config:filters_96e5782")}</span>
            {filter !== "all" && <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setFilter("all")}>{t("agent-config:clear_719ea39")}</button>}
          </div>
          <div role="group" aria-label={t("agent-config:harness_2b7cfd5")} className="space-y-1">
            <div className="px-2 text-xs font-medium text-muted-foreground">{t("agent-config:harness_2b7cfd5")}</div>
            {["all", ...harnesses].map(h => <button key={h} type="button" aria-pressed={filter === h} onClick={() => setFilter(h)}
              className={cn("flex w-full items-center justify-between rounded-sm px-2 py-1 text-left text-sm", filter === h ? "bg-accent/50 text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground")}>
              {h === "all" ? t("agent-config:allHarnesses_ee34f89") : getAdapterLabel(h)}{filter === h && <Check className="size-3.5" aria-hidden />}
            </button>)}
          </div>
        </PopoverContent>
      </Popover>
      <span className="text-xs text-muted-foreground">{t("countAgents", { count: visible.length })}</span>
    </div>
    {selectedAgents.length > 0 && <div role="region" aria-label={t("agent-config:bulkActions_3268f92")} className="sticky top-0 z-10 flex flex-wrap items-center gap-3 rounded-md border bg-muted p-3">
      <span className="text-sm font-medium">{selectedAgents.length} {t("agent-config:selected_835f3b5")}</span>
      {hidden > 0 && <span className="text-xs text-muted-foreground">{hidden} {t("agent-config:hiddenByFilters_950d6cf")}</span>}
      {groups.length > 1 && <span className="text-xs text-muted-foreground">{t("agent-config:chooseAHarnessToEdit_f8e0d0a")}</span>}
      <div className="flex flex-1 flex-wrap items-center justify-end gap-2">{groups.map(h => <Button key={h} size="sm" variant="outline" disabled={opening} onClick={() => void openEditor(h)}>
        <Pencil className="size-3.5" aria-hidden />{groups.length === 1 ? t("agent-config:editConnectionModel_bb37d2b") : t("agent-config:editValueValue_cdc9cc4", { value1: selectedAgents.filter(a => bulkAgentHarness(a) === h).length, value2: getAdapterLabel(h) })}
      </Button>)}<Button size="icon-sm" variant="ghost" aria-label={t("agent-config:clearSelection_247fd63")} onClick={() => changeSelection([])}><X className="size-4" /></Button></div>
    </div>}
    {opening && <p role="status" className="text-sm text-muted-foreground">{t("agent-config:loadingCurrentAgentSettings_343812c")}</p>}
    {openError && <p role="alert" className="text-sm text-destructive">{openError}</p>}
    {notice && <p role="status" className="flex items-center gap-2 text-sm"><Check className="size-4" aria-hidden />{notice}</p>}
    {accounts.error && <p className="text-xs text-destructive">{t("agent-config:connectionNamesCouldnTBeLoaded_0a22b6e")} <Button variant="link" size="sm" onClick={() => void accounts.refetch()}>{t("agent-config:retry_9f5cd8a")}</Button></p>}
    <div className="overflow-x-auto"><table aria-label={t("agent-config:agentRoster_dec33b6")} className="w-full text-left text-sm">
      <thead className="text-xs text-muted-foreground [&_th]:px-3 [&_th]:py-3 [&_th]:font-normal"><tr>
        <th className="w-10"><Checkbox aria-label={t("agent-config:selectAllVisibleEditableAgents_342b6c7")} checked={all ? true : some ? "indeterminate" : false} disabled={!selectable.length} onCheckedChange={toggleAll} /></th>
        <th>{t("agent-config:agent_5ce2e6f")}</th><th>{t("agent-config:harness_2b7cfd5")}</th><th>{t("agent-config:connection_6512ee1")}</th><th>{t("agent-config:defaultModel_5fbae11")}</th>
      </tr></thead>
      <tbody>{visible.map(agent => {
        const pendingSetup = pendingAgentSetupDisplayAdapter(agent);
        return <tr key={agent.id} data-state={selected.includes(agent.id) ? "selected" : undefined} className="border-t border-border data-[state=selected]:bg-accent/30 [&_td]:px-3">
        <td title={bulkAgentDisabledReason(agent)}><Checkbox aria-label={t("agent-config:selectValue_503f816", { value1: agent.name })} checked={selectedAgents.some(a => a.id === agent.id)} disabled={!!bulkAgentDisabledReason(agent)} onCheckedChange={value => changeSelection(value ? [...new Set([...selected, agent.id])] : selected.filter(id => id !== agent.id))} /></td>
        <td className="min-w-64 p-0">{renderAgent(agent)}</td>
        <td className="whitespace-nowrap text-xs">{getAdapterLabel(pendingSetup ?? bulkAgentHarness(agent))}</td>
        <td className="text-xs">{pendingSetup ? t("agent-config:notConfigured_811931b") : ["http", "process"].includes(agent.adapterType) ? t("agent-config:managedExternally_c44f15d") : bulkConnectionName(agentConnection(agent), accounts.data)}</td>
        <td className="font-mono text-xs">{pendingSetup ? t("agent-config:notAvailableYet_a1db9d5") : agentDefaultModel(agent) ?? t("agent-config:harnessDefault_6dd2a2f")}</td>
      </tr>;
      })}</tbody>
    </table></div>
    {!visible.length && <p className="py-8 text-center text-sm text-muted-foreground">{t("agent-config:noAgentsMatchTheseFilters_9fe7732")}</p>}
    {editing && <Suspense fallback={<p role="status" className="text-sm text-muted-foreground">{t("agent-config:loadingEditor_a31c117")}</p>}><AgentBulkSettingsSheet companyId={companyId} agents={editing} totalSelected={selectedAgents.length} onClose={(updatedIds, complete) => {
      setEditing(null);
      if (updatedIds.length) {
        changeSelection(ids => ids.filter(id => !(complete ? editing.map(a => a.id) : updatedIds).includes(id)));
        setNotice(t("updatedHarnessAgents", { count: updatedIds.length, harness: getAdapterLabel(bulkAgentHarness(editing[0])) }));
      }
    }} /></Suspense>}
  </div>;
}
