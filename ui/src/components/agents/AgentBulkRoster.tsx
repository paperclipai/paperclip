import { t, useTranslation } from "@/i18n";
import { lazy, Suspense, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Filter, Pencil, X } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { aiConnectionsApi } from "@/api/ai-connections";
import { getAdapterLabel } from "@/adapters/adapter-display-registry";
import { agentConnection, agentDefaultModel, bulkAgentDisabledReason, bulkAgentHarness, bulkConnectionName } from "@/lib/bulk-agent-settings";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

const AgentBulkSettingsSheet = lazy(() => import("./AgentBulkSettingsSheet").then(m => ({ default: m.AgentBulkSettingsSheet })));

/** Shared by both roster layouts. Mount with a company key to isolate selection. */
export function AgentBulkRoster({ companyId, agents, visibleAgents, renderAgent }: {
  companyId: string; agents: Agent[]; visibleAgents: Agent[]; renderAgent: (agent: Agent) => ReactNode;
}) {
  useTranslation();
  const [selected, setSelected] = useState<string[]>([]);
  const [filter, setFilter] = useState("all");
  const [editing, setEditing] = useState<Agent[] | null>(null);
  const [notice, setNotice] = useState<{ count: number; harness: string } | null>(null);
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
          <Button variant="ghost" size="icon" aria-label={t("oct26Settings.roster.filterAgents")} title={filter === "all" ? t("oct26Settings.roster.filter") : t("oct26Settings.roster.filterHarness", { harness: getAdapterLabel(filter) })}
            className={cn("relative h-8 w-8 shrink-0", filter !== "all" && "text-blue-600 dark:text-blue-400")}>
            <Filter className="h-3.5 w-3.5" aria-hidden />
            {filter !== "all" && <span aria-hidden className="absolute -right-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-blue-600 text-(length:--text-nano) font-bold text-white">1</span>}
          </Button>
        </PopoverTrigger>
        <PopoverContent aria-label={t("oct26Settings.roster.agentFilters")} align="start" className="w-64 space-y-3 p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">{t("oct26Settings.roster.filters")}</span>
            {filter !== "all" && <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setFilter("all")}>{t("oct26Settings.roster.clear")}</button>}
          </div>
          <div role="group" aria-label={t("oct26Settings.roster.harness")} className="space-y-1">
            <div className="px-2 text-xs font-medium text-muted-foreground">{t("oct26Settings.roster.harness")}</div>
            {["all", ...harnesses].map(h => <button key={h} type="button" aria-pressed={filter === h} onClick={() => setFilter(h)}
              className={cn("flex w-full items-center justify-between rounded-sm px-2 py-1 text-left text-sm", filter === h ? "bg-accent/50 text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground")}>
              {h === "all" ? t("oct26Settings.roster.allHarnesses") : getAdapterLabel(h)}{filter === h && <Check className="size-3.5" aria-hidden />}
            </button>)}
          </div>
        </PopoverContent>
      </Popover>
      <span className="text-xs text-muted-foreground">{t("oct26Settings.roster.agentCount", { count: visible.length })}</span>
    </div>
    {selectedAgents.length > 0 && <div role="region" aria-label={t("oct26Settings.roster.bulkActions")} className="sticky top-0 z-10 flex flex-wrap items-center gap-3 rounded-md border bg-muted p-3">
      <span className="text-sm font-medium">{t("oct26Settings.roster.selected", { count: selectedAgents.length })}</span>
      {hidden > 0 && <span className="text-xs text-muted-foreground">{t("oct26Settings.roster.hidden", { count: hidden })}</span>}
      {groups.length > 1 && <span className="text-xs text-muted-foreground">{t("oct26Settings.roster.chooseHarness")}</span>}
      <div className="flex flex-1 flex-wrap items-center justify-end gap-2">{groups.map(h => <Button key={h} size="sm" variant="outline" onClick={() => setEditing(selectedAgents.filter(a => bulkAgentHarness(a) === h))}>
        <Pencil className="size-3.5" aria-hidden />{groups.length === 1 ? t("oct26Settings.roster.editConnectionModel") : t("oct26Settings.roster.editGroup", { count: selectedAgents.filter(a => bulkAgentHarness(a) === h).length, harness: getAdapterLabel(h) })}
      </Button>)}<Button size="icon-sm" variant="ghost" aria-label={t("oct26Settings.common.clearSelection")} onClick={() => setSelected([])}><X className="size-4" /></Button></div>
    </div>}
    {notice && <p role="status" className="flex items-center gap-2 text-sm"><Check className="size-4" aria-hidden />{t("oct26Settings.roster.updated", { count: notice.count, harness: getAdapterLabel(notice.harness) })}</p>}
    {accounts.error && <p className="text-xs text-destructive">{t("oct26Settings.roster.namesError")}<Button variant="link" size="sm" onClick={() => void accounts.refetch()}>{t("oct26Settings.common.retry")}</Button></p>}
    <div className="overflow-x-auto"><table aria-label={t("oct26Settings.roster.title")} className="w-full text-left text-sm">
      <thead className="text-xs text-muted-foreground [&_th]:px-3 [&_th]:py-3 [&_th]:font-normal"><tr>
        <th className="w-10"><Checkbox aria-label={t("oct26Settings.roster.selectAll")} checked={all ? true : some ? "indeterminate" : false} disabled={!selectable.length} onCheckedChange={toggleAll} /></th>
        <th>{t("oct26Settings.roster.agent")}</th><th>{t("oct26Settings.roster.harness")}</th><th>{t("oct26Settings.roster.connection")}</th><th>{t("oct26Settings.roster.defaultModel")}</th>
      </tr></thead>
      <tbody>{visible.map(agent => <tr key={agent.id} data-state={selected.includes(agent.id) ? "selected" : undefined} className="border-t border-border data-[state=selected]:bg-accent/30 [&_td]:px-3">
        <td title={bulkAgentDisabledReason(agent)}><Checkbox aria-label={t("oct26Settings.roster.selectAgent", { name: agent.name })} checked={selectedAgents.some(a => a.id === agent.id)} disabled={!!bulkAgentDisabledReason(agent)} onCheckedChange={value => setSelected(value ? [...new Set([...selected, agent.id])] : selected.filter(id => id !== agent.id))} /></td>
        <td className="min-w-64 p-0">{renderAgent(agent)}</td>
        <td className="whitespace-nowrap text-xs">{getAdapterLabel(bulkAgentHarness(agent))}</td>
        <td className="text-xs">{["http", "process"].includes(agent.adapterType) ? t("oct26Settings.roster.external") : bulkConnectionName(agentConnection(agent), accounts.data)}</td>
        <td className="font-mono text-xs">{agentDefaultModel(agent) ?? t("oct26Settings.roster.harnessDefault")}</td>
      </tr>)}</tbody>
    </table></div>
    {!visible.length && <p className="py-8 text-center text-sm text-muted-foreground">{t("oct26Settings.roster.noMatches")}</p>}
    {editing && <Suspense fallback={<p role="status" className="text-sm text-muted-foreground">{t("oct26Settings.roster.loadingEditor")}</p>}><AgentBulkSettingsSheet companyId={companyId} agents={editing} totalSelected={selectedAgents.length} onClose={(updatedIds, complete) => {
      setEditing(null);
      if (updatedIds.length) {
        setSelected(ids => ids.filter(id => !(complete ? editing.map(a => a.id) : updatedIds).includes(id)));
        setNotice({ count: updatedIds.length, harness: bulkAgentHarness(editing[0]) });
      }
    }} /></Suspense>}
  </div>;
}
