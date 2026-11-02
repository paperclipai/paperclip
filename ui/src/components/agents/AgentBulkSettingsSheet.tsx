import { t, useTranslation } from "@/i18n";
import { SettingsDisplayError, settingsErrorText } from "@/lib/settings-localization";
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Loader2 } from "lucide-react";
import { aiRoutingModel, isAiConnectionCompatible, type Agent, type AiConnectionBinding, type AiConnectionList } from "@paperclipai/shared";
import { agentsApi, type AdapterModel } from "@/api/agents";
import { aiConnectionsApi } from "@/api/ai-connections";
import { getAdapterLabel } from "@/adapters/adapter-display-registry";
import { agentConnection, agentDefaultModel, bulkAgentHarness, bulkConnectionName, mapBulkAgents, resolveBulkConnection, sameBinding } from "@/lib/bulk-agent-settings";
import { queryKeys } from "@/lib/queryKeys";
import { AgentAvatar } from "@/components/AgentAvatar";
import { ModelDropdown } from "@/components/AgentConfigForm";
import { AiConnectionField, aiProviderForAdapter } from "@/components/ai-connections/AiConnectionField";
import { bindingProblem } from "@/components/ai-connections/model";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";

type Catalog = { agent: Agent; accounts: AiConnectionList; binding: AiConnectionBinding | undefined; models: AdapterModel[]; restricted: boolean };
type Failure = { agent: Agent; error: Error };

export function AgentBulkSettingsSheet({ companyId, agents, totalSelected, onClose }: {
  companyId: string; agents: Agent[]; totalSelected: number; onClose: (updatedIds: string[], complete?: boolean) => void;
}) {
  useTranslation();
  const client = useQueryClient();
  const harness = bulkAgentHarness(agents[0]);
  const label = getAdapterLabel(harness);
  const [changeConnection, setChangeConnection] = useState(false);
  const [changeModel, setChangeModel] = useState(false);
  const [binding, setBinding] = useState<AiConnectionBinding>();
  const [selectionError, setSelectionError] = useState(false);
  const [model, setModel] = useState("");
  const [modelOpen, setModelOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [updatedIds, setUpdatedIds] = useState<string[]>([]);
  const [failures, setFailures] = useState<Failure[] | null>(null);
  const targets = failures ? failures.map(f => f.agent) : agents;
  const catalogs = useQuery({
    queryKey: ["bulk-agent-models", companyId, targets.map(a => a.id), changeConnection ? binding : null],
    retry: false,
    queryFn: async () => {
      const modelRequests = new Map<string, Promise<AdapterModel[]>>();
      const results = await mapBulkAgents(targets, async agent => {
        const accounts = await aiConnectionsApi.list(companyId, agent.id);
        const current = agentConnection(agent);
        const effective = changeConnection && binding ? binding : current?.mode !== "router" ? current : undefined;
        const connection = resolveBulkConnection(effective, accounts);
        const routing = connection?.routing;
        const openRouter = routing?.kind === "openrouter" || (!routing && effective?.provider === "openrouter");
        const restricted = Boolean(routing?.models.length || openRouter || harness === "copilot_runtime");
        let models: AdapterModel[];
        if (routing?.models.length) {
          models = routing.models.map(m => ({ id: aiRoutingModel(routing, harness, m.id), label: m.label ?? m.id }));
        } else {
          const copilot = harness === "copilot_runtime";
          const type = openRouter ? "opencode_local" : copilot ? "paperclip_runner" : harness;
          const options = openRouter ? { provider: "openrouter" } : copilot
            ? { provider: "acpx", acpxAgent: "copilot", agentId: agent.id, aiConnection: effective, environmentId: agent.defaultEnvironmentId }
            : { environmentId: agent.defaultEnvironmentId };
          const key = JSON.stringify([type, options]);
          let request = modelRequests.get(key);
          if (!request) { request = agentsApi.adapterModels(companyId, type, options); modelRequests.set(key, request); }
          models = await request;
          if (openRouter && !["opencode_local", "pi_local"].includes(harness)) models = models.map(m => ({ ...m, id: m.id.replace(/^openrouter\//, "") }));
        }
        return { agent, accounts, binding: effective, models, restricted } satisfies Catalog;
      });
      return results.map((result, index) => result.status === "fulfilled" ? result.value : { agent: targets[index], error: result.reason instanceof Error ? result.reason : new SettingsDisplayError("bulk.loadError") });
    },
  });
  const rows = catalogs.data?.filter((r): r is Catalog => !("error" in r)) ?? [];
  const loadErrors = catalogs.data?.filter(r => "error" in r) ?? [];
  const availableModels = [...new Map(rows.flatMap(r => r.models).map(m => [m.id, m])).values()]
    .filter(m => rows.every(r => !r.restricted || r.models.some(other => other.id === m.id)));
  const allowManualModel = rows.length === targets.length && rows.every(r => !r.restricted);
  const changed = targets.filter(a => (changeConnection && binding && !sameBinding(binding, agentConnection(a))) || (changeModel && model && model !== agentDefaultModel(a)));
  const missing = (!changeConnection && !changeModel) || (changeConnection && !binding) || (changeModel && !model);
  const problems = targets.flatMap(agent => {
    const row = rows.find(r => r.agent.id === agent.id);
    if (!row || missing) return [];
    const nextModel = changeModel ? model : agentDefaultModel(agent);
    let problem: string | null = null;
    if (row.binding) {
      problem = bindingProblem(row.binding, { companyId, provider: row.binding.provider }, row.accounts.connections, row.accounts.currentUserId, agent.id);
      if (!problem && !isAiConnectionCompatible(row.binding, harness, nextModel)) problem = t("oct26Settings.bulk.compatibleModel");
    }
    if (!problem && row.restricted && !row.models.some(m => m.id === nextModel)) problem = nextModel ? t("oct26Settings.bulk.modelUnavailable", { model: nextModel }) : t("oct26Settings.bulk.defaultUnavailable");
    return problem ? [{ agent, message: problem }] : [];
  });
  const canSave = !saving && !missing && !selectionError && !catalogs.isFetching && !catalogs.error && !loadErrors.length && rows.length === targets.length && !problems.length && changed.length > 0;
  const updateCount = changed.length || agents.length;
  const otherSelected = totalSelected - agents.length;
  const currentConnections = [...new Set(agents.map(a => bulkConnectionName(agentConnection(a), rows.find(r => r.agent.id === a.id)?.accounts)))];
  const currentModels = [...new Set(agents.map(a => agentDefaultModel(a) ?? t("oct26Settings.roster.harnessDefault")))];
  const close = () => { if (!savingRef.current) onClose(updatedIds); };

  async function save() {
    if (!canSave || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    const results = await mapBulkAgents(changed, async agent => {
      const patch = { harness, ...(changeConnection && binding ? { aiConnection: binding } : {}), ...(changeModel ? { model } : {}), expected: { model: agentDefaultModel(agent), aiConnection: agentConnection(agent) ?? null } };
      // A lost response may hide a successful commit. Re-read before retrying so
      // an acknowledged or already-applied edit never creates a second write.
      if (failures) {
        const latest = await agentsApi.get(agent.id, companyId);
        if (bulkAgentHarness(latest) === harness && (!changeConnection || sameBinding(binding, agentConnection(latest))) && (!changeModel || agentDefaultModel(latest) === model)) return latest;
      }
      return agentsApi.updateRuntimeSettings(agent.id, patch, companyId);
    });
    const nextFailures: Failure[] = [];
    const successes: Agent[] = [];
    results.forEach((result, index) => {
      if (result.status === "fulfilled") successes.push(result.value);
      else nextFailures.push({ agent: changed[index], error: result.reason instanceof Error ? result.reason : new SettingsDisplayError("bulk.saveError") });
    });
    const allUpdated = [...updatedIds, ...successes.map(a => a.id)];
    setUpdatedIds(allUpdated);
    client.setQueryData<Agent[]>(queryKeys.agents.list(companyId), current => current?.map(a => successes.find(updated => updated.id === a.id) ?? a));
    await Promise.all(successes.map(a => client.invalidateQueries({ queryKey: queryKeys.agents.detail(a.id) })));
    void client.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
    savingRef.current = false;
    setSaving(false);
    if (nextFailures.length) setFailures(nextFailures);
    else onClose(allUpdated, true);
  }

  return <Sheet open onOpenChange={open => { if (!open) close(); }}><SheetContent className="w-full sm:max-w-lg" showCloseButton={!saving} onEscapeKeyDown={event => { if (savingRef.current) event.preventDefault(); }} onInteractOutside={event => { if (savingRef.current) event.preventDefault(); }}>
    <SheetHeader className="px-6 pt-6 pb-0"><SheetTitle>{t("oct26Settings.bulk.title", { count: agents.length, harness: label })}</SheetTitle><SheetDescription>{totalSelected > agents.length ? t("oct26Settings.bulk.otherSelected", { count: otherSelected }) : t("oct26Settings.bulk.description")}</SheetDescription></SheetHeader>
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 py-2">
      <div className="flex flex-wrap gap-2" aria-label={t("oct26Settings.bulk.targets")}>{agents.map(a => <span key={a.id} className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs"><AgentAvatar agent={a} size={20} />{a.name}</span>)}</div>
      {failures && <div role="alert" className="space-y-2 rounded-md border border-destructive/30 p-3 text-sm"><p className="font-medium">{t("oct26Settings.bulk.result", { updated: updatedIds.length, failed: failures.length })}</p>{failures.map(f => <p key={f.agent.id} className="text-muted-foreground">{f.agent.name}: {settingsErrorText(f.error)}</p>)}<p className="text-xs text-muted-foreground">{t("oct26Settings.bulk.retryNotice")}</p></div>}
      <fieldset disabled={saving || failures !== null} className="flex flex-col gap-6 disabled:opacity-60">
        <section className="space-y-3"><label className="flex cursor-pointer items-start gap-3"><Checkbox checked={changeConnection} disabled={!aiProviderForAdapter(harness)} onCheckedChange={value => setChangeConnection(value === true)} aria-label={t("oct26Settings.bulk.changeConnection")} className="mt-0.5" /><span className="space-y-1"><span className="block text-sm font-medium">{t("oct26Settings.bulk.changeConnection")}</span><span className="block text-xs text-muted-foreground">{currentConnections.length === 1 ? currentConnections[0] : t("oct26Settings.bulk.connectionCount", { count: currentConnections.length })}{!changeConnection && t("oct26Settings.bulk.keepCurrent")}</span></span></label>
          {changeConnection && <div className="pl-7"><AiConnectionField companyId={companyId} agentId={agents[0].id} agentName={t("oct26Settings.roster.agentCount", { count: agents.length })} adapterType={harness} model={changeModel ? model : undefined} value={binding} readOnly={saving || failures !== null} onChange={value => {
            if (value.mode === "router") { setSelectionError(true); return; }
            setSelectionError(false); setBinding(value);
          }} /></div>}
        </section>
        <section className="space-y-3"><label className="flex cursor-pointer items-start gap-3"><Checkbox checked={changeModel} onCheckedChange={value => setChangeModel(value === true)} aria-label={t("oct26Settings.bulk.changeDefaultModel")} className="mt-0.5" /><span className="space-y-1"><span className="block text-sm font-medium">{t("oct26Settings.bulk.changeDefaultModel")}</span><span className="block text-xs text-muted-foreground">{currentModels.length === 1 ? currentModels[0] : t("oct26Settings.bulk.modelCount", { count: currentModels.length })}{!changeModel && t("oct26Settings.bulk.keepCurrent")}</span></span></label>
          {changeModel && <div className="pl-7"><ModelDropdown models={availableModels} value={model} onChange={setModel} open={modelOpen} onOpenChange={setModelOpen} allowDefault={false} required groupByProvider={false} preserveOrder creatable={allowManualModel} /><p className="pt-2 text-xs text-muted-foreground">{allowManualModel ? t("oct26Settings.bulk.modelHint") : t(changeConnection ? "oct26Settings.bulk.newConnectionAvailability" : "oct26Settings.bulk.currentConnectionAvailability")}</p></div>}
        </section>
      </fieldset>
      {catalogs.isFetching && <p role="status" className="text-xs text-muted-foreground">{t("oct26Settings.bulk.checking")}</p>}
      {(catalogs.error || loadErrors.length > 0) && <div role="alert" className="space-y-2 text-sm text-destructive"><p>{catalogs.error?.message}</p>{loadErrors.map(r => <p key={r.agent.id}>{r.agent.name}: {"error" in r ? settingsErrorText(r.error) : ""}</p>)}<Button variant="outline" size="sm" onClick={() => void catalogs.refetch()}>{t("oct26Settings.bulk.retryLoading")}</Button></div>}
      {selectionError && <p role="alert" className="text-sm text-destructive">{t("oct26Settings.bulk.poolHint")}</p>}
      {problems.length > 0 && <div role="alert" className="space-y-2 rounded-md border border-destructive/30 p-3 text-sm">{problems.map(p => <p key={p.agent.id}><span className="font-medium">{p.agent.name}: </span>{p.message}</p>)}{!changeModel && !failures && <Button size="sm" variant="outline" onClick={() => setChangeModel(true)}>{t("oct26Settings.bulk.changeDefaultModel")}</Button>}</div>}
      {!missing && changed.length > 0 && <section className="space-y-3" aria-label={t("oct26Settings.bulk.changes")}><h3 className="text-xs font-medium text-muted-foreground">{t("oct26Settings.bulk.changesHeading")}</h3><div className="divide-y divide-border">{changed.map(agent => <div key={agent.id} className="space-y-1.5 py-3 text-xs"><p className="text-sm font-medium">{agent.name}</p>{changeConnection && !sameBinding(binding, agentConnection(agent)) && <p className="flex flex-wrap items-center gap-1.5 text-muted-foreground"><span>{bulkConnectionName(agentConnection(agent), rows.find(r => r.agent.id === agent.id)?.accounts)}</span><ArrowRight className="size-3" aria-label={t("oct26Settings.bulk.to")} /><span className="text-foreground">{bulkConnectionName(binding, rows.find(r => r.agent.id === agent.id)?.accounts)}</span></p>}{changeModel && model !== agentDefaultModel(agent) && <p className="flex flex-wrap items-center gap-1.5 font-mono text-muted-foreground"><span>{agentDefaultModel(agent) ?? t("oct26Settings.roster.harnessDefault")}</span><ArrowRight className="size-3" aria-label={t("oct26Settings.bulk.to")} /><span className="text-foreground">{model}</span></p>}</div>)}</div>{targets.length > changed.length && <p className="text-xs text-muted-foreground">{t("oct26Settings.bulk.alreadyConfigured", { count: targets.length - changed.length })}</p>}</section>}
      {!missing && !changed.length && <p className="text-sm text-muted-foreground">{t("oct26Settings.bulk.allConfigured")}</p>}
      <p className="text-xs text-muted-foreground">{t("oct26Settings.bulk.applyNotice")}</p>
    </div>
    <SheetFooter className="flex-row items-center justify-between border-t px-6 py-4"><Button variant="ghost" onClick={close} disabled={saving}>{failures ? t("oct26Settings.common.close") : t("oct26Settings.common.cancel")}</Button><Button onClick={() => void save()} disabled={!canSave}>{saving && <Loader2 className="size-4 animate-spin" aria-hidden />}{saving ? t("oct26Settings.bulk.updating") : failures ? t("oct26Settings.bulk.retryAgents", { count: failures.length }) : t("oct26Settings.bulk.updateAgents", { count: updateCount })}</Button></SheetFooter>
  </SheetContent></Sheet>;
}
