import { useTranslation } from "@/i18n";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import type { ToolConnection } from "@paperclipai/shared";
import { findComposioCatalogApp, type AggregatorAppCatalogEntry } from "@paperclipai/shared/aggregator-app-catalog";
import { toolsApi } from "@/api/tools";
import { queryKeys } from "@/lib/queryKeys";
import { COMPOSIO_APP_MANAGEMENT_URL } from "@/lib/aggregator-app-setup";
import { Link } from "@/lib/router";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { describeError } from "@/api/errors";

export function ComposioAppManager({ app, connections, initialConnectionId, onClose }: {
  app: AggregatorAppCatalogEntry; connections: ToolConnection[]; initialConnectionId?: string; onClose: () => void;
}) {
  const { t } = useTranslation();
  const [connectionId, setConnectionId] = useState(initialConnectionId ?? connections[0]?.id ?? "");
  const connection = connections.find(candidate => candidate.id === connectionId);
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent>
    <DialogHeader><DialogTitle>{t("apps.ComposioAppManager.title", { name: app.name })}</DialogTitle><DialogDescription>{t("apps.ComposioAppManager.description")}</DialogDescription></DialogHeader>
    {connections.length > 1 ? <div className="space-y-2"><Label htmlFor="composio-manage-gateway">{t("apps.ComposioAppManager.accountLabel")}</Label>
      <select id="composio-manage-gateway" value={connectionId} onChange={event => setConnectionId(event.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
        {connections.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
      </select></div> : null}
    {connection ? <ComposioAccountObservations key={connection.id} app={app} connection={connection} onClose={onClose} /> : <p role="alert">{t("apps.ComposioAppManager.unavailable")}</p>}
  </DialogContent></Dialog>;
}

function ComposioAccountObservations({ app, connection, onClose }: { app: AggregatorAppCatalogEntry; connection: ToolConnection; onClose: () => void }) {
  const { t } = useTranslation();
  const queries = useQueryClient();
  const key = queryKeys.tools.composioApps(connection.id);
  const accountsQuery = useQuery({ queryKey: key, queryFn: () => toolsApi.listComposioApps(connection.id), staleTime: Infinity, refetchOnWindowFocus: false });
  const accountsView = useQueryView(accountsQuery);
  const snapshots = accountsQuery.data?.apps.filter(candidate => findComposioCatalogApp(candidate.toolkit)?.slug === app.slug) ?? [];
  const accounts = snapshots.flatMap(snapshot => snapshot.accounts.map(account => ({ account, snapshot })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function refresh() {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const toolkits = snapshots.length ? snapshots.map(snapshot => snapshot.toolkit) : [app.routes.find(route => route.provider === "composio")!.toolkit];
      queries.setQueryData(key, await toolsApi.refreshComposioApps(connection.id, toolkits));
    } catch (cause) {
      setError(describeError(cause).body);
      await queries.invalidateQueries({ queryKey: key });
    } finally { setBusy(false); }
  }
  return <>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    {accountsView.kind === "error" ? <QueryErrorState error={accountsQuery.error} action={t("errorActions.loadComposioAccounts")} onRetry={accountsView.retry} retrying={accountsView.isFetching} /> : null}
    {accountsQuery.isLoading || accountsView.kind === "reconnecting" ? <p role="status" className="text-sm text-muted-foreground">{t("apps.ComposioAccountObservations.loadingAccounts")}</p> : accounts.length === 0 ? <p className="text-sm text-muted-foreground">{t("apps.ComposioAccountObservations.noAccounts", { name: app.name })}</p> : <div className="divide-y divide-border">
      {accounts.map(({ account, snapshot }) => <div key={`${snapshot.toolkit}:${account.id}`} className="py-3">
        <p className="truncate text-sm font-medium">{account.alias || t("apps.ComposioAccountObservations.accountFallback", { name: app.name })}</p>
        <p className="text-xs text-muted-foreground">{snapshot.errorAt || Date.now() - new Date(snapshot.checkedAt).getTime() > 5 * 60_000
          ? t("apps.ComposioAccountObservations.lastKnown") : account.status === "ACTIVE" ? t("apps.ComposioAccountObservations.connected") : account.status === "INITIATED" ? t("apps.ComposioAccountObservations.waitingSignIn") : t("apps.ComposioAccountObservations.needsSignIn")}{account.isDefault ? ` · ${t("apps.ComposioAccountObservations.defaultAccount")}` : ""}</p>
      </div>)}
    </div>}
    <div className="space-y-1 text-xs text-muted-foreground">
      <p>{t("apps.ComposioAccountObservations.via")} <Link to={`/apps/${connection.id}/permissions`} onClick={onClose} className="underline underline-offset-2">“{connection.name}”</Link></p>
      <p>{t("apps.ComposioAccountObservations.permissionsNotice")}</p>
    </div>
    <DialogFooter className="sm:items-center sm:justify-between"><Button variant="ghost" onClick={onClose}>{t("apps.ComposioAccountObservations.close")}</Button>
      <div className="flex items-center gap-2"><Button variant="ghost" disabled={busy} onClick={() => void refresh()}>{busy ? t("apps.ComposioAccountObservations.checking") : t("apps.ComposioAccountObservations.refresh")}</Button>
        <Button asChild><a href={COMPOSIO_APP_MANAGEMENT_URL} target="_blank" rel="noopener noreferrer">{t("apps.ComposioAccountObservations.openInComposio")}<ExternalLink className="size-4" /></a></Button></div>
    </DialogFooter>
  </>;
}
