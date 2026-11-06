import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ExternalLink, Loader2, MoreHorizontal, Plus, Search, Trash2, X } from "lucide-react";
import { aiConnectionRouterAppDefinition, type AiConnectionPool, type AiConnectionPoolConfig, type AiConnectionPoolMember, type AiManagedConnectionSummary, type ToolConnection } from "@paperclipai/shared";
import { PAPERCLIP_RUNNER_DEFAULT_MODELS } from "@paperclipai/adapter-utils";
import { aiConnectionsApi } from "@/api/ai-connections";
import { aiConnectionPoolsApi, type PoolInspection } from "@/api/ai-connection-pools";
import { describeError } from "@/api/errors";
import { toolsApi } from "@/api/tools";
import { agentsApi } from "@/api/agents";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useToast } from "@/context/ToastContext";
import { Link, useNavigate } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { AppLogo } from "@/pages/apps/AppLogo";
import { AppDetailHeader } from "@/pages/apps/AppDetail";
import { StepHeader } from "@/features/connections/ConnectionSetupHeader";
import { Button } from "@/components/ui/button";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { AgentIdentity } from "@/components/AgentIdentity";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AiConnectionUsagePanel } from "./AiConnectionUsagePanel";
import { AI_PROVIDERS, aiMethodLabel } from "./model";
import { t, useTranslation } from "@/i18n";

const configOf = ({ name, enabled, members, mode, thresholdPercent }: AiConnectionPoolConfig): AiConnectionPoolConfig => ({ name, enabled, members, mode, thresholdPercent });
const emptyConfig = (): AiConnectionPoolConfig => ({ name: t("agents.AiConnectionPoolConnector.defaultPoolName"), enabled: false, members: [], mode: "round_robin", thresholdPercent: 90 });
function memberOf(account: AiManagedConnectionSummary): AiConnectionPoolMember {
  const profile: AiConnectionPoolMember["profile"] = account.provider === "openai" ? { provider: "codex", model: PAPERCLIP_RUNNER_DEFAULT_MODELS.codex }
    : account.provider === "anthropic" ? { provider: "acpx", acpxAgent: "claude", model: "claude-sonnet-5" }
    : account.provider === "xai" ? { provider: "acpx", acpxAgent: "grok", model: "grok-4.7" }
    : { provider: "opencode", model: "openrouter/anthropic/claude-sonnet-4.6" };
  return { id: crypto.randomUUID(), binding: { mode: account.ownership === "shared" ? "shared" : "delegated", provider: account.provider, method: account.method, connectionId: account.id, grantId: account.grantId }, profile };
}

/** Native connector surface shared by all plugins implementing the pool contract. */
export function AiConnectionPoolConnector({ pluginKey, connection }: { pluginKey: string; connection?: ToolConnection }) {
  const { t } = useTranslation();
  const { selectedCompanyId } = useCompany();
  return selectedCompanyId ? <PoolConnector key={`${selectedCompanyId}:${connection?.id ?? pluginKey}`} companyId={selectedCompanyId} pluginKey={pluginKey} connection={connection} /> : <p>{t("agents.AiConnectionPoolConnector.selectCompany")}</p>;
}
function PoolConnector({ companyId, pluginKey, connection }: { companyId: string; pluginKey: string; connection?: ToolConnection }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const { pushToast } = useToast();
  const { setBreadcrumbs } = useBreadcrumbs();
  const accountsQuery = useQuery({ queryKey: ["pool-accounts", companyId], queryFn: () => aiConnectionsApi.list(companyId) });
  const poolsQuery = useQuery({ queryKey: ["ai-connection-pools", companyId], queryFn: () => aiConnectionPoolsApi.list(companyId), enabled: accountsQuery.data?.canManageConnections === true });
  const galleryQuery = useQuery({ queryKey: queryKeys.apps.gallery(companyId), queryFn: () => toolsApi.listGallery(companyId) });
  const accountsView = useQueryView(accountsQuery);
  const poolsView = useQueryView(poolsQuery);
  const galleryView = useQueryView(galleryQuery);
  const [editing, setEditing] = useState<AiConnectionPool>();
  const [draft, setDraft] = useState(emptyConfig);
  const [step, setStep] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerMembers, setPickerMembers] = useState<AiConnectionPoolMember[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [inspectionError, setInspectionError] = useState("");
  const [inspection, setInspection] = useState<PoolInspection>({});
  const accounts = accountsQuery.data?.connections ?? [];
  const entry = galleryQuery.data?.apps.find(app => app.aiConnectionRouter?.pluginKey === pluginKey);
  const unavailable = galleryQuery.isSuccess && (!entry || entry.availability?.available === false);
  const canManage = Boolean(accountsQuery.data?.canManageConnections);
  const disabled = busy || !canManage || unavailable;
  const agentsQuery = useQuery({ queryKey: queryKeys.agents.list(companyId), queryFn: () => agentsApi.list(companyId), enabled: Boolean(connection) && canManage });
  const agentsView = useQueryView(agentsQuery);
  const usingAgents = (agentsQuery.data ?? []).filter(agent => agent.status !== "terminated" && agent.runtimeConfig?.aiConnection?.mode === "router" && agent.runtimeConfig.aiConnection.connectionId === connection?.id).sort((a, b) => a.name.localeCompare(b.name));
  useEffect(() => {
    if (connection && !editing && canManage) {
      const pool = poolsQuery.data?.find(pool => pool.id === connection.id && pool.pluginKey === pluginKey);
      if (pool) { setEditing(pool); setDraft(configOf(pool)); }
    }
  }, [poolsQuery.data, connection, editing, pluginKey, canManage]);
  useEffect(() => {
    setBreadcrumbs([{ label: t("agents.AiConnectionPoolConnector.connectors"), href: "/apps" }, { label: connection ? draft.name : t("agents.AiConnectionPoolConnector.addPool") }]);
    return () => setBreadcrumbs([]);
  }, [connection, draft.name, setBreadcrumbs, t]);
  useEffect(() => {
    if (!editing || !canManage) return;
    let alive = true;
    void aiConnectionPoolsApi.inspect(companyId, editing.id).then(value => { if (alive) setInspection(value); }).catch(() => { if (alive) setInspectionError(t("agents.AiConnectionPoolConnector.usageUnavailable")); });
    return () => { alive = false; };
  }, [companyId, editing, canManage, t]);
  async function invalidate() {
    await Promise.all([
      client.invalidateQueries({ queryKey: ["ai-connection-pools", companyId] }),
      client.invalidateQueries({ queryKey: queryKeys.tools.connections(companyId) }),
      client.invalidateQueries({ queryKey: queryKeys.tools.applications(companyId) }),
      ...(connection ? [client.invalidateQueries({ queryKey: queryKeys.tools.connection(connection.id) })] : []),
    ]);
  }
  async function save(config = draft) {
    setBusy(true); setError("");
    try {
      const saved = await aiConnectionPoolsApi.save(companyId, { pluginKey, ...(editing ? { id: editing.id, expectedRevision: editing.revision } : {}), config });
      setEditing(saved); setDraft(configOf(saved)); setRenaming(false);
      await invalidate();
      pushToast({ title: connection ? t("agents.AiConnectionPoolConnector.poolSaved") : t("agents.AiConnectionPoolConnector.poolCreated"), tone: "success" });
      if (!connection) navigate(`/apps/${saved.id}/permissions`);
    } catch (cause) { setError(describeError(cause).body); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!editing) return;
    setBusy(true); setError("");
    try { await aiConnectionPoolsApi.remove(companyId, editing.id, editing.revision); await invalidate(); navigate("/apps"); }
    catch (cause) { setError(describeError(cause).body); }
    finally { setBusy(false); }
  }
  function move(index: number, offset: number) {
    setDraft(value => { const members = [...value.members]; [members[index], members[index + offset]] = [members[index + offset]!, members[index]!]; return { ...value, members }; });
  }
  // Loaded data stays on screen through a transient refetch failure; only a real failure replaces the pool.
  const failedViews = [accountsView, poolsView, galleryView].filter(view => view.kind === "error");
  const reconnecting = [accountsView, poolsView, galleryView].some(view => view.kind === "reconnecting");
  if (accountsQuery.data && !canManage) return <p role="alert" className="text-sm text-muted-foreground">{t("agents.AiConnectionPoolConnector.managerView")}</p>;
  if (failedViews.length > 0) return <QueryErrorState error={failedViews[0]!.error} action={t("errorActions.loadConnections")} onRetry={() => failedViews.forEach(view => view.retry())} retrying={failedViews.some(view => view.isFetching)} />;
  if (accountsQuery.isPending || poolsQuery.isPending || galleryQuery.isPending || reconnecting || (connection && !editing && poolsQuery.data?.some(pool => pool.id === connection.id))) return <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("agents.AiConnectionPoolConnector.loadingConnections")}</p>;
  if (connection && !editing) return <p role="alert">{t("agents.AiConnectionPoolConnector.noLongerAvailable")}</p>;
  const name = entry?.name ?? t("agents.AiConnectionPoolConnector.defaultPoolName");
  const logoEntry = entry ?? aiConnectionRouterAppDefinition(pluginKey, { name, description: t("agents.AiConnectionPoolConnector.routerDescription") });
  const orderedMembers = <ol aria-label={t("agents.AiConnectionPoolConnector.connectionOrder")} className="divide-y divide-border rounded-lg border border-border">
    {draft.members.map((member, index) => {
      const account = accounts.find(account => account.id === member.binding.connectionId && account.grantId === member.binding.grantId);
      const provider = AI_PROVIDERS[member.binding.provider];
      return <li key={member.id} className="flex items-center gap-3 px-4 py-3">
        <span className="w-4 text-center text-xs text-muted-foreground">{index + 1}</span>
        <AppLogo name={provider.name} logoUrl={provider.logo} size={32} />
        <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{account?.name ?? t("agents.AiConnectionPoolConnector.connectionUnavailable")}</p><p className="text-xs text-muted-foreground">{account ? aiMethodLabel(account.provider, account.method) : t("agents.AiConnectionPoolConnector.restoreAccess")}</p>{connection && draft.mode === "usage_aware" && account && <details className="mt-2 text-xs text-muted-foreground"><summary className="cursor-pointer">{t("agents.AiConnectionPoolConnector.usage")}</summary><div className="pt-3">{inspectionError ? <p role="status">{inspectionError}</p> : <AiConnectionUsagePanel account={account} cachedOnly observation={inspection[member.id]?.usage} />}</div></details>}</div>
        <div className="flex shrink-0 items-center gap-1">
          <Button type="button" variant="ghost" size="icon-sm" disabled={disabled || index === 0} aria-label={t("agents.AiConnectionPoolConnector.moveUp", { name: account?.name ?? t("agents.AiConnectionPoolConnector.connection") })} onClick={() => move(index, -1)}><ArrowUp className="size-4" /></Button>
          <Button type="button" variant="ghost" size="icon-sm" disabled={disabled || index === draft.members.length - 1} aria-label={t("agents.AiConnectionPoolConnector.moveDown", { name: account?.name ?? t("agents.AiConnectionPoolConnector.connection") })} onClick={() => move(index, 1)}><ArrowDown className="size-4" /></Button>
          <Button type="button" variant="ghost" size="icon-sm" disabled={disabled} aria-label={t("agents.AiConnectionPoolConnector.removeName", { name: account?.name ?? t("agents.AiConnectionPoolConnector.connection") })} onClick={() => setDraft({ ...draft, members: draft.members.filter(item => item.id !== member.id) })}><X className="size-4" /></Button>
        </div>
      </li>;
    })}
    {draft.members.length === 0 && <li className="px-4 py-6 text-sm text-muted-foreground">{t("agents.AiConnectionPoolConnector.addConnectionHint")}</li>}
  </ol>;
  return <div className={connection ? "space-y-6" : "mx-auto max-w-2xl"}>
    {connection ? <div className="flex items-start justify-between gap-4">
      <AppDetailHeader appName={draft.name} connection={connection} logoEntry={logoEntry} brandKey={logoEntry.slug} allowRemoteLogo canRename={!disabled} status={editing?.enabled ? { label: t("agents.AiConnectionPoolConnector.connected"), tone: "connected" } : { label: t("agents.AiConnectionPoolConnector.paused"), tone: "paused" }} actionCount={null} renaming={renaming} nameDraft={nameDraft} renamePending={disabled} onNameDraftChange={setNameDraft} onRenameStart={() => { if (!disabled) { setNameDraft(draft.name); setRenaming(true); } }} onRenameCancel={() => setRenaming(false)} onRenameSubmit={value => void save({ ...draft, name: value })} />
      <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={t("agents.AiConnectionPoolConnector.manageConnectionPool")}><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem variant="destructive" disabled={busy || !canManage} onSelect={() => { setError(""); setRemoving(true); }}><Trash2 />{t("agents.AiConnectionPoolConnector.removeConnection")}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
    </div> : <StepHeader title={t("agents.AiConnectionPoolConnector.addPool")} subtitle={step === 0 ? t("agents.AiConnectionPoolConnector.chooseConnections") : t("agents.AiConnectionPoolConnector.rotateOrder")} step="connect" activeIndex={step} labels={[t("agents.AiConnectionPoolConnector.connections"), t("agents.AiConnectionPoolConnector.order")]} appIdentity={{ name, logoUrl: logoEntry.branding.logoUrl }} />}
    {unavailable && <p role="alert" className="text-sm text-destructive">{entry?.availability?.reason ?? t("agents.AiConnectionPoolConnector.enablePlugin")}</p>}
    {!canManage && <p role="alert" className="text-sm text-muted-foreground">{t("agents.AiConnectionPoolConnector.managerEdit")}</p>}
    {error && !removing && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!connection && step === 0 ? <ConnectionPicker accounts={accounts} selected={draft.members} disabled={disabled} onChange={members => setDraft({ ...draft, members })} onRefresh={() => void accountsQuery.refetch()} /> : <div className="space-y-4">
      {connection && <div className="flex items-center justify-between gap-3"><h2 className="text-sm font-semibold">{t("agents.AiConnectionPoolConnector.connections")}</h2><Button variant="outline" size="sm" disabled={disabled} onClick={() => { setPickerMembers(draft.members); setPickerOpen(true); }}><Plus className="size-4" />{t("agents.AiConnectionPoolConnector.addConnections")}</Button></div>}
      {orderedMembers}
      <p className="text-xs text-muted-foreground">{connection ? t("agents.AiConnectionPoolConnector.orderHint") : t("agents.AiConnectionPoolConnector.createdPaused")}</p>
      {connection && <>
        <label className="flex items-center gap-2 text-sm"><Checkbox checked={draft.enabled} disabled={disabled} onCheckedChange={checked => setDraft({ ...draft, enabled: checked === true })} />{t("agents.AiConnectionPoolConnector.enablePool")}</label>
        <details className="rounded-lg border border-border"><summary className="cursor-pointer px-4 py-3 text-sm font-medium">{t("agents.AiConnectionPoolConnector.advanced")}</summary><fieldset disabled={disabled} className="space-y-4 border-t border-border p-4">
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={draft.mode === "usage_aware"} onCheckedChange={checked => setDraft({ ...draft, mode: checked ? "usage_aware" : "round_robin" })} />{t("agents.AiConnectionPoolConnector.skipNearLimit")}</label>
          {draft.mode === "usage_aware" && <label className="flex items-center gap-3 text-sm">{t("agents.AiConnectionPoolConnector.skipAt")}<Input className="w-20" aria-label={t("agents.AiConnectionPoolConnector.usageThreshold")} type="number" min={1} max={100} step={1} value={draft.thresholdPercent} onChange={event => setDraft({ ...draft, thresholdPercent: Number(event.target.value) })} />{t("agents.AiConnectionPoolConnector.percentUsage")}</label>}
          {draft.members.map((member, index) => <div key={member.id} className="space-y-2"><p className="text-sm font-medium">{accounts.find(account => account.id === member.binding.connectionId)?.name ?? t("agents.AiConnectionPoolConnector.connectionUnavailable")}</p><div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-xs text-muted-foreground">{t("agents.AiConnectionPoolConnector.model")}<Input aria-label={t("agents.AiConnectionPoolConnector.modelFor", { index: index + 1 })} value={member.profile.model} onChange={event => setDraft({ ...draft, members: draft.members.map(row => row.id === member.id ? { ...row, profile: { ...row.profile, model: event.target.value } } : row) })} /></label><label className="space-y-1 text-xs text-muted-foreground">{t("agents.AiConnectionPoolConnector.effortOptional")}<Input aria-label={t("agents.AiConnectionPoolConnector.effortFor", { index: index + 1 })} value={member.profile.effort ?? ""} onChange={event => { const { effort: _old, ...profile } = member.profile; setDraft({ ...draft, members: draft.members.map(row => row.id === member.id ? { ...row, profile: { ...profile, ...(event.target.value.trim() ? { effort: event.target.value.trim() } : {}) } } : row) }); }} /></label></div></div>)}
        </fieldset></details>
        <section aria-labelledby="pool-used-by" className="space-y-3">
          <h2 id="pool-used-by" className="text-sm font-semibold">{t("agents.AiConnectionPoolConnector.usedBy")}</h2>
          {agentsQuery.isPending || agentsView.kind === "reconnecting" ? <p role="status" className="text-sm text-muted-foreground">{t("agents.AiConnectionPoolConnector.loadingAgents")}</p>
            : agentsView.kind === "error" ? <QueryErrorState size="inline" error={agentsQuery.error} action={t("errorActions.loadAgents")} onRetry={agentsView.retry} retrying={agentsView.isFetching} />
            : usingAgents.length ? <ul className="flex flex-wrap gap-x-6 gap-y-3">{usingAgents.map(agent => <li key={agent.id} className="min-w-0 max-w-full"><Link to={`/agents/${agent.id}`} className="inline-flex max-w-full rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><AgentIdentity agent={agent} /></Link></li>)}</ul>
            : <p className="text-sm text-muted-foreground">{t("agents.AiConnectionPoolConnector.noAgentsYet")}</p>}
        </section>
      </>}
    </div>}
    <div className="mt-6 flex items-center justify-between gap-3 border-t border-border pt-4">
      <Button variant="ghost" disabled={busy} onClick={() => connection ? navigate("/apps") : step ? setStep(0) : navigate("/apps")}>{!connection && step ? t("agents.AiConnectionPoolConnector.back") : t("agents.AiConnectionPoolConnector.cancel")}</Button>
      <Button disabled={disabled || draft.members.length === 0 || !Number.isInteger(draft.thresholdPercent) || draft.thresholdPercent < 1 || draft.thresholdPercent > 100} onClick={() => !connection && step === 0 ? setStep(1) : void save()}>{busy && <Loader2 className="size-4 animate-spin" />}{busy ? t("agents.AiConnectionPoolConnector.saving") : connection ? t("agents.AiConnectionPoolConnector.saveChanges") : step ? t("agents.AiConnectionPoolConnector.createPool") : t("agents.AiConnectionPoolConnector.continue")}</Button>
    </div>
    <Dialog open={pickerOpen} onOpenChange={setPickerOpen}><DialogContent className="sm:max-w-2xl"><DialogHeader><DialogTitle>{t("agents.AiConnectionPoolConnector.addConnections")}</DialogTitle><DialogDescription>{t("agents.AiConnectionPoolConnector.chooseConnections")}</DialogDescription></DialogHeader><ConnectionPicker accounts={accounts} selected={pickerMembers} disabled={disabled} onChange={setPickerMembers} onRefresh={() => void accountsQuery.refetch()} /><div className="flex items-center justify-between gap-3"><Button variant="ghost" onClick={() => setPickerOpen(false)}>{t("agents.AiConnectionPoolConnector.cancel")}</Button><Button onClick={() => { setDraft({ ...draft, members: pickerMembers }); setPickerOpen(false); }}>{t("agents.AiConnectionPoolConnector.done")}</Button></div></DialogContent></Dialog>
    <AlertDialog open={removing} onOpenChange={open => { if (!busy) setRemoving(open); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{t("agents.AiConnectionPoolConnector.removeTitle", { name: draft.name })}</AlertDialogTitle><AlertDialogDescription>{t("agents.AiConnectionPoolConnector.poolKept")}</AlertDialogDescription></AlertDialogHeader>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<AlertDialogFooter className="sm:justify-between"><AlertDialogCancel disabled={busy}>{t("agents.AiConnectionPoolConnector.cancel")}</AlertDialogCancel><AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={busy} onClick={event => { event.preventDefault(); void remove(); }}>{busy ? t("agents.AiConnectionPoolConnector.removing") : t("agents.AiConnectionPoolConnector.removeConnection")}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </div>;
}
function ConnectionPicker({ accounts, selected, disabled, onChange, onRefresh }: { accounts: AiManagedConnectionSummary[]; selected: AiConnectionPoolMember[]; disabled: boolean; onChange: (members: AiConnectionPoolMember[]) => void; onRefresh: () => void }) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const filtered = accounts.filter(account => `${account.name} ${AI_PROVIDERS[account.provider].name}`.toLowerCase().includes(search.toLowerCase()));
  return <div className="space-y-4">
    <div className="relative"><Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" /><Input aria-label={t("agents.AiConnectionPoolConnector.searchConnections")} placeholder={t("agents.AiConnectionPoolConnector.searchPlaceholder")} value={search} onChange={event => setSearch(event.target.value)} className="pl-9" /></div>
    <div className="max-h-80 overflow-y-auto rounded-lg border border-border divide-y divide-border">
      {filtered.map(account => { const existing = selected.find(member => member.binding.connectionId === account.id); const checked = existing?.binding.grantId === account.grantId; return <label key={account.grantId} className="flex cursor-pointer items-center gap-3 px-4 py-3 hover:bg-accent/50"><Checkbox checked={checked} disabled={disabled || (!checked && (account.status !== "connected" || Boolean(existing)))} onCheckedChange={value => onChange(value ? [...selected, memberOf(account)] : selected.filter(member => member.binding.connectionId !== account.id))} aria-label={account.name} /><AppLogo name={AI_PROVIDERS[account.provider].name} logoUrl={AI_PROVIDERS[account.provider].logo} size={32} /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{account.name}</span><span className="block text-xs text-muted-foreground">{aiMethodLabel(account.provider, account.method)} · {account.ownership === "shared" ? t("agents.AiConnectionPoolConnector.shared") : t("agents.AiConnectionPoolConnector.personal")}</span></span>{account.status !== "connected" && <span className="text-xs text-muted-foreground">{t("agents.AiConnectionPoolConnector.needsAttention")}</span>}</label>; })}
      {filtered.length === 0 && <p className="px-4 py-6 text-sm text-muted-foreground">{accounts.length ? t("agents.AiConnectionPoolConnector.noMatching") : t("agents.AiConnectionPoolConnector.noAiConnections")}</p>}
    </div>
    <div className="flex items-center justify-between gap-3 text-sm"><Link to="/apps" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">{t("agents.AiConnectionPoolConnector.connectNew")}<ExternalLink className="size-3.5" /></Link><Button variant="ghost" size="sm" onClick={onRefresh}>{t("agents.AiConnectionPoolConnector.refresh")}</Button></div>
  </div>;
}
