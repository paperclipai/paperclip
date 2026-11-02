import { t, useTranslation } from "@/i18n";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ExternalLink, Loader2, MoreHorizontal, Plus, Search, Trash2, X } from "lucide-react";
import { aiConnectionRouterAppDefinition, type AiConnectionPool, type AiConnectionPoolConfig, type AiConnectionPoolMember, type AiManagedConnectionSummary, type ToolConnection } from "@paperclipai/shared";
import { aiConnectionsApi } from "@/api/ai-connections";
import { aiConnectionPoolsApi, type PoolInspection } from "@/api/ai-connection-pools";
import { toolsApi } from "@/api/tools";
import { agentsApi } from "@/api/agents";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useToast } from "@/context/ToastContext";
import { Link, useNavigate } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { AppLogo } from "@/pages/apps/AppLogo";
import { appDefinitionDisplayName, appDefinitionText } from "@/pages/apps/app-definition-display";
import { AppDetailHeader } from "@/pages/apps/AppDetail";
import { StepHeader } from "@/features/connections/ConnectionSetupHeader";
import { Button } from "@/components/ui/button";
import { AgentIdentity } from "@/components/AgentIdentity";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AiConnectionUsagePanel } from "./AiConnectionUsagePanel";
import { AI_PROVIDERS, aiMethodLabel } from "./model";

const configOf = ({ name, enabled, members, mode, thresholdPercent }: AiConnectionPoolConfig): AiConnectionPoolConfig => ({ name, enabled, members, mode, thresholdPercent });
const emptyConfig = (): AiConnectionPoolConfig => ({ name: t("oct6Beta.copy036"), enabled: false, members: [], mode: "round_robin", thresholdPercent: 90 });
function memberOf(account: AiManagedConnectionSummary): AiConnectionPoolMember {
  const profile: AiConnectionPoolMember["profile"] = account.provider === "openai" ? { provider: "codex", model: "gpt-5.6-sol" }
    : account.provider === "anthropic" ? { provider: "acpx", acpxAgent: "claude", model: "claude-sonnet-5" }
    : account.provider === "xai" ? { provider: "acpx", acpxAgent: "grok", model: "grok-4.7" }
    : { provider: "opencode", model: "openrouter/anthropic/claude-sonnet-4.6" };
  return { id: crypto.randomUUID(), binding: { mode: account.ownership === "shared" ? "shared" : "delegated", provider: account.provider, method: account.method, connectionId: account.id, grantId: account.grantId }, profile };
}

/** Native connector surface shared by all plugins implementing the pool contract. */
export function AiConnectionPoolConnector({ pluginKey, connection }: { pluginKey: string; connection?: ToolConnection }) {
  useTranslation();
  const { selectedCompanyId } = useCompany();
  return selectedCompanyId ? <PoolConnector key={`${selectedCompanyId}:${connection?.id ?? pluginKey}`} companyId={selectedCompanyId} pluginKey={pluginKey} connection={connection} /> : <p>{t("oct6Beta.copy037")}</p>;
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
  const usingAgents = (agentsQuery.data ?? []).filter(agent => agent.status !== "terminated" && agent.runtimeConfig?.aiConnection?.mode === "router" && agent.runtimeConfig.aiConnection.connectionId === connection?.id).sort((a, b) => a.name.localeCompare(b.name));
  useEffect(() => {
    if (connection && !editing && canManage) {
      const pool = poolsQuery.data?.find(pool => pool.id === connection.id && pool.pluginKey === pluginKey);
      if (pool) { setEditing(pool); setDraft(configOf(pool)); }
    }
  }, [poolsQuery.data, connection, editing, pluginKey, canManage]);
  useEffect(() => {
    setBreadcrumbs([{ label: t("localizationConnections.connectors16"), href: "/apps" }, { label: connection ? draft.name : t("oct6Beta.copy038") }]);
    return () => setBreadcrumbs([]);
  }, [connection, draft.name, setBreadcrumbs, t]);
  useEffect(() => {
    if (!editing || !canManage) return;
    let alive = true;
    void aiConnectionPoolsApi.inspect(companyId, editing.id).then(value => { if (alive) setInspection(value); }).catch(() => { if (alive) setInspectionError("oct5Apps.copy018"); });
    return () => { alive = false; };
  }, [companyId, editing, canManage]);
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
      pushToast({ title: connection ? t("oct6Beta.copy039") : t("oct6Beta.copy040"), tone: "success" });
      if (!connection) navigate(`/apps/${saved.id}/permissions`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!editing) return;
    setBusy(true); setError("");
    try { await aiConnectionPoolsApi.remove(companyId, editing.id, editing.revision); await invalidate(); navigate("/apps"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  function move(index: number, offset: number) {
    setDraft(value => { const members = [...value.members]; [members[index], members[index + offset]] = [members[index + offset]!, members[index]!]; return { ...value, members }; });
  }
  const loadError = accountsQuery.error ?? poolsQuery.error ?? galleryQuery.error;
  if (accountsQuery.isSuccess && !canManage) return <p role="alert" className="text-sm text-muted-foreground">{t("oct6Beta.copy041")}</p>;
  if (loadError) return <div className="space-y-4"><p role="alert" className="text-sm text-destructive">{loadError.message}</p><Button variant="outline" onClick={() => { void accountsQuery.refetch(); void poolsQuery.refetch(); void galleryQuery.refetch(); }}>{t("oct5Core.s0057")}</Button></div>;
  if (accountsQuery.isPending || poolsQuery.isPending || galleryQuery.isPending || (connection && !editing && poolsQuery.data?.some(pool => pool.id === connection.id))) return <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("oct6Beta.copy042")}</p>;
  if (connection && !editing) return <p role="alert">{t("oct6Beta.copy043")}</p>;
  const name = entry ? appDefinitionDisplayName(entry) : t("oct6Beta.copy036");
  const logoEntry = entry ?? aiConnectionRouterAppDefinition(pluginKey, { name, description: t("oct6Beta.copy044") });
  const orderedMembers = <ol aria-label={t("oct6Beta.copy045")} className="divide-y divide-border rounded-lg border border-border">
    {draft.members.map((member, index) => {
      const account = accounts.find(account => account.id === member.binding.connectionId && account.grantId === member.binding.grantId);
      const provider = AI_PROVIDERS[member.binding.provider];
      return <li key={member.id} className="flex items-center gap-3 px-4 py-3">
        <span className="w-4 text-center text-xs text-muted-foreground">{index + 1}</span>
        <AppLogo name={provider.name} logoUrl={provider.logo} size={32} />
        <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{account?.name ?? t("oct6Beta.copy046")}</p><p className="text-xs text-muted-foreground">{account ? aiMethodLabel(account.provider, account.method) : t("oct6Beta.copy047")}</p>{connection && draft.mode === "usage_aware" && account && <details className="mt-2 text-xs text-muted-foreground"><summary className="cursor-pointer">{t("oct5Apps.copy020")}</summary><div className="pt-3">{inspectionError ? <p role="status">{t(inspectionError)}</p> : <AiConnectionUsagePanel account={account} cachedOnly observation={inspection[member.id]?.usage} />}</div></details>}</div>
        <div className="flex shrink-0 items-center gap-1">
          <Button type="button" variant="ghost" size="icon-sm" disabled={disabled || index === 0} aria-label={t("oct6Beta.dynamic051", { v0: account?.name ?? t("oct6Beta.connectionFallback") })} onClick={() => move(index, -1)}><ArrowUp className="size-4" /></Button>
          <Button type="button" variant="ghost" size="icon-sm" disabled={disabled || index === draft.members.length - 1} aria-label={t("oct6Beta.dynamic052", { v0: account?.name ?? t("oct6Beta.connectionFallback") })} onClick={() => move(index, 1)}><ArrowDown className="size-4" /></Button>
          <Button type="button" variant="ghost" size="icon-sm" disabled={disabled} aria-label={t("oct6Beta.dynamic053", { v0: account?.name ?? t("oct6Beta.connectionFallback") })} onClick={() => setDraft({ ...draft, members: draft.members.filter(item => item.id !== member.id) })}><X className="size-4" /></Button>
        </div>
      </li>;
    })}
    {draft.members.length === 0 && <li className="px-4 py-6 text-sm text-muted-foreground">{t("oct6Beta.copy048")}</li>}
  </ol>;
  return <div className={connection ? "space-y-6" : "mx-auto max-w-2xl"}>
    {connection ? <div className="flex items-start justify-between gap-4">
      <AppDetailHeader appName={draft.name} connection={connection} logoEntry={logoEntry} brandKey={logoEntry.slug} allowRemoteLogo canRename={!disabled} status={editing?.enabled ? { label: t("sep13Connections.status_connected"), tone: "connected" } : { label: t("oct5Core.s0060"), tone: "paused" }} actionCount={null} renaming={renaming} nameDraft={nameDraft} renamePending={disabled} onNameDraftChange={setNameDraft} onRenameStart={() => { if (!disabled) { setNameDraft(draft.name); setRenaming(true); } }} onRenameCancel={() => setRenaming(false)} onRenameSubmit={value => void save({ ...draft, name: value })} />
      <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={t("oct6Beta.copy049")}><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem variant="destructive" disabled={busy || !canManage} onSelect={() => { setError(""); setRemoving(true); }}><Trash2 />{t("localizationApps.removeConnection91")}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
    </div> : <StepHeader title={t("oct6Beta.copy038")} subtitle={step === 0 ? t("oct6Beta.copy050") : t("oct6Beta.copy051")} step="connect" activeIndex={step} labels={[t("pages.apps.connections.title"), t("oct6Beta.poolOrder")]} appIdentity={{ name, logoUrl: logoEntry.branding.logoUrl }} />}
    {unavailable && <p role="alert" className="text-sm text-destructive">{entry?.availability?.reason ? appDefinitionText(entry, entry.availability.reason) : t("oct6Beta.copy052")}</p>}
    {!canManage && <p role="alert" className="text-sm text-muted-foreground">{t("oct6Beta.copy053")}</p>}
    {error && !removing && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!connection && step === 0 ? <ConnectionPicker accounts={accounts} selected={draft.members} disabled={disabled} onChange={members => setDraft({ ...draft, members })} onRefresh={() => void accountsQuery.refetch()} /> : <div className="space-y-4">
      {connection && <div className="flex items-center justify-between gap-3"><h2 className="text-sm font-semibold">{t("pages.apps.connections.title")}</h2><Button variant="outline" size="sm" disabled={disabled} onClick={() => { setPickerMembers(draft.members); setPickerOpen(true); }}><Plus className="size-4" />{t("oct6Beta.copy054")}</Button></div>}
      {orderedMembers}
      <p className="text-xs text-muted-foreground">{connection ? t("oct6Beta.copy055") : t("oct6Beta.copy056")}</p>
      {connection && <>
        <label className="flex items-center gap-2 text-sm"><Checkbox checked={draft.enabled} disabled={disabled} onCheckedChange={checked => setDraft({ ...draft, enabled: checked === true })} />{t("oct6Beta.copy057")}</label>
        <details className="rounded-lg border border-border"><summary className="cursor-pointer px-4 py-3 text-sm font-medium">{t("localizationOperations.ui_Advanced")}</summary><fieldset disabled={disabled} className="space-y-4 border-t border-border p-4">
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={draft.mode === "usage_aware"} onCheckedChange={checked => setDraft({ ...draft, mode: checked ? "usage_aware" : "round_robin" })} />{t("oct6Beta.copy058")}</label>
          {draft.mode === "usage_aware" && <label className="flex items-center gap-3 text-sm">{t("oct6Beta.copy059")}<Input className="w-20" aria-label={t("oct6Beta.copy060")} type="number" min={1} max={100} step={1} value={draft.thresholdPercent} onChange={event => setDraft({ ...draft, thresholdPercent: Number(event.target.value) })} />{t("oct6Beta.copy061")}</label>}
          {draft.members.map((member, index) => <div key={member.id} className="space-y-2"><p className="text-sm font-medium">{accounts.find(account => account.id === member.binding.connectionId)?.name ?? t("oct6Beta.copy046")}</p><div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-xs text-muted-foreground">{t("oct5Core.s0137")}<Input aria-label={t("oct6Beta.dynamic054", { v0: index + 1 })} value={member.profile.model} onChange={event => setDraft({ ...draft, members: draft.members.map(row => row.id === member.id ? { ...row, profile: { ...row.profile, model: event.target.value } } : row) })} /></label><label className="space-y-1 text-xs text-muted-foreground">{t("oct6Beta.copy062")}<Input aria-label={t("oct6Beta.dynamic055", { v0: index + 1 })} value={member.profile.effort ?? ""} onChange={event => { const { effort: _old, ...profile } = member.profile; setDraft({ ...draft, members: draft.members.map(row => row.id === member.id ? { ...row, profile: { ...profile, ...(event.target.value.trim() ? { effort: event.target.value.trim() } : {}) } } : row) }); }} /></label></div></div>)}
        </fieldset></details>
        <section aria-labelledby="pool-used-by" className="space-y-3">
          <h2 id="pool-used-by" className="text-sm font-semibold">{t("localizationSkills.usedBy293")}</h2>
          {agentsQuery.isPending ? <p role="status" className="text-sm text-muted-foreground">{t("oct5Core.s0208")}</p>
            : agentsQuery.isError ? <div className="flex items-center gap-2"><p role="alert" className="text-sm text-muted-foreground">{t("oct6Beta.copy063")}</p><Button variant="ghost" size="sm" onClick={() => void agentsQuery.refetch()}>{t("oct5Core.s0281")}</Button></div>
            : usingAgents.length ? <ul className="flex flex-wrap gap-x-6 gap-y-3">{usingAgents.map(agent => <li key={agent.id} className="min-w-0 max-w-full"><Link to={`/agents/${agent.id}`} className="inline-flex max-w-full rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><AgentIdentity agent={agent} /></Link></li>)}</ul>
            : <p className="text-sm text-muted-foreground">{t("localizationAgentChrome.ui1_No_agents_yet")}</p>}
        </section>
      </>}
    </div>}
    <div className="mt-6 flex items-center justify-between gap-3 border-t border-border pt-4">
      <Button variant="ghost" disabled={busy} onClick={() => connection ? navigate("/apps") : step ? setStep(0) : navigate("/apps")}>{!connection && step ? t("oct5Core.s0344") : t("oct5Core.s0345")}</Button>
      <Button disabled={disabled || draft.members.length === 0 || !Number.isInteger(draft.thresholdPercent) || draft.thresholdPercent < 1 || draft.thresholdPercent > 100} onClick={() => !connection && step === 0 ? setStep(1) : void save()}>{busy && <Loader2 className="size-4 animate-spin" />}{busy ? t("oct5Core.s0466") : connection ? t("localizationSkills.saveChanges265") : step ? t("oct6Beta.copy064") : t("oct5Core.continue")}</Button>
    </div>
    <Dialog open={pickerOpen} onOpenChange={setPickerOpen}><DialogContent className="sm:max-w-2xl"><DialogHeader><DialogTitle>{t("oct6Beta.copy054")}</DialogTitle><DialogDescription>{t("oct6Beta.copy050")}</DialogDescription></DialogHeader><ConnectionPicker accounts={accounts} selected={pickerMembers} disabled={disabled} onChange={setPickerMembers} onRefresh={() => void accountsQuery.refetch()} /><div className="flex items-center justify-between gap-3"><Button variant="ghost" onClick={() => setPickerOpen(false)}>{t("oct5Core.s0345")}</Button><Button onClick={() => { setDraft({ ...draft, members: pickerMembers }); setPickerOpen(false); }}>{t("common.done")}</Button></div></DialogContent></Dialog>
    <AlertDialog open={removing} onOpenChange={open => { if (!busy) setRemoving(open); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{t("oct6Beta.removeNamedConnection", { name: draft.name })}</AlertDialogTitle><AlertDialogDescription>{t("oct6Beta.copy065")}</AlertDialogDescription></AlertDialogHeader>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<AlertDialogFooter className="sm:justify-between"><AlertDialogCancel disabled={busy}>{t("oct5Core.s0345")}</AlertDialogCancel><AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={busy} onClick={event => { event.preventDefault(); void remove(); }}>{busy ? t("pages.secrets.status.removing") : t("localizationApps.removeConnection91")}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </div>;
}
function ConnectionPicker({ accounts, selected, disabled, onChange, onRefresh }: { accounts: AiManagedConnectionSummary[]; selected: AiConnectionPoolMember[]; disabled: boolean; onChange: (members: AiConnectionPoolMember[]) => void; onRefresh: () => void }) {
  useTranslation();
  const [search, setSearch] = useState("");
  const filtered = accounts.filter(account => `${account.name} ${AI_PROVIDERS[account.provider].name}`.toLowerCase().includes(search.toLowerCase()));
  return <div className="space-y-4">
    <div className="relative"><Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" /><Input aria-label={t("oct6Beta.copy066")} placeholder={t("oct6Beta.copy067")} value={search} onChange={event => setSearch(event.target.value)} className="pl-9" /></div>
    <div className="max-h-80 overflow-y-auto rounded-lg border border-border divide-y divide-border">
      {filtered.map(account => { const existing = selected.find(member => member.binding.connectionId === account.id); const checked = existing?.binding.grantId === account.grantId; return <label key={account.grantId} className="flex cursor-pointer items-center gap-3 px-4 py-3 hover:bg-accent/50"><Checkbox checked={checked} disabled={disabled || (!checked && (account.status !== "connected" || Boolean(existing)))} onCheckedChange={value => onChange(value ? [...selected, memberOf(account)] : selected.filter(member => member.binding.connectionId !== account.id))} aria-label={account.name} /><AppLogo name={AI_PROVIDERS[account.provider].name} logoUrl={AI_PROVIDERS[account.provider].logo} size={32} /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{account.name}</span><span className="block text-xs text-muted-foreground">{aiMethodLabel(account.provider, account.method)} · {account.ownership === "shared" ? t("oct6Beta.sharedAccount") : t("sep13Connections.personal")}</span></span>{account.status !== "connected" && <span className="text-xs text-muted-foreground">{t("sep13Connections.status_needs_attention")}</span>}</label>; })}
      {filtered.length === 0 && <p className="px-4 py-6 text-sm text-muted-foreground">{accounts.length ? t("oct6Beta.copy068") : t("oct6Beta.copy069")}</p>}
    </div>
    <div className="flex items-center justify-between gap-3 text-sm"><Link to="/apps" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">{t("oct6Beta.copy070")}<ExternalLink className="size-3.5" /></Link><Button variant="ghost" size="sm" onClick={onRefresh}>{t("oct5Core.s0317")}</Button></div>
  </div>;
}
