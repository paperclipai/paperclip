import { t, useTranslation } from "@/i18n";
import { Trans } from "react-i18next";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import type { ToolConnection } from "@paperclipai/shared";
import { findComposioCatalogApp, type AggregatorAppCatalogEntry } from "@paperclipai/shared/aggregator-app-catalog";
import { toolsApi } from "@/api/tools";
import { queryKeys } from "@/lib/queryKeys";
import { COMPOSIO_APP_MANAGEMENT_URL } from "@/lib/aggregator-app-setup";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function ComposioAppManager({ app, connections, initialConnectionId, onClose }: {
  app: AggregatorAppCatalogEntry; connections: ToolConnection[]; initialConnectionId?: string; onClose: () => void;
}) {
  useTranslation();
  const [connectionId, setConnectionId] = useState(initialConnectionId ?? connections[0]?.id ?? "");
  const connection = connections.find(candidate => candidate.id === connectionId);
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent>
    <DialogHeader><DialogTitle>{t("localizationAgents.ui44_Manage")} {app.name}</DialogTitle><DialogDescription>{t("oct6Beta.copy260")}</DialogDescription></DialogHeader>
    {connections.length > 1 ? <div className="space-y-2"><Label htmlFor="composio-manage-gateway">{t("oct6Beta.copy261")}</Label>
      <select id="composio-manage-gateway" value={connectionId} onChange={event => setConnectionId(event.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
        {connections.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
      </select></div> : null}
    {connection ? <ComposioAccountObservations key={connection.id} app={app} connection={connection} onClose={onClose} /> : <p role="alert">{t("oct6Beta.copy262")}</p>}
  </DialogContent></Dialog>;
}

function ComposioAccountObservations({ app, connection, onClose }: { app: AggregatorAppCatalogEntry; connection: ToolConnection; onClose: () => void }) {
  useTranslation();
  const queries = useQueryClient();
  const key = queryKeys.tools.composioApps(connection.id);
  const accountsQuery = useQuery({ queryKey: key, queryFn: () => toolsApi.listComposioApps(connection.id), staleTime: Infinity, refetchOnWindowFocus: false });
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
      setError(cause instanceof Error ? cause.message : t("oct6Beta.copy263"));
      await queries.invalidateQueries({ queryKey: key });
    } finally { setBusy(false); }
  }
  return <>
    {error || accountsQuery.isError ? <p role="alert" className="text-sm text-destructive">{error ?? t("oct6Beta.copy264")}</p> : null}
    {accountsQuery.isLoading ? <p role="status" className="text-sm text-muted-foreground">{t("oct6Beta.copy200")}</p> : accounts.length === 0 ? <p className="text-sm text-muted-foreground">{t("oct6Beta.dynamic105", { v0: app.name })}</p> : <div className="divide-y divide-border">
      {accounts.map(({ account, snapshot }) => <div key={`${snapshot.toolkit}:${account.id}`} className="py-3">
        <p className="truncate text-sm font-medium">{account.alias || t("oct6Beta.dynamic127", { v0: app.name })}</p>
        <p className="text-xs text-muted-foreground">{snapshot.errorAt || Date.now() - new Date(snapshot.checkedAt).getTime() > 5 * 60_000
          ? t("oct6Beta.copy252") : account.status === "ACTIVE" ? t("sep13Connections.status_connected") : account.status === "INITIATED" ? t("sep28Apps.waitingSignIn") : t("oct6Beta.copy201")}{account.isDefault ? t("oct6Beta.copy265") : ""}</p>
      </div>)}
    </div>}
    <div className="space-y-1 text-xs text-muted-foreground">
      <p><Trans i18nKey="oct6Beta.viaConnection" values={{ name: connection.name }} components={{ connection: <Link to={`/apps/${connection.id}/permissions`} onClick={onClose} className="underline underline-offset-2" /> }} /></p>
      <p>{t("oct6Beta.copy266")}</p>
    </div>
    <DialogFooter className="sm:items-center sm:justify-between"><Button variant="ghost" onClick={onClose}>{t("sep28Routines.close")}</Button>
      <div className="flex items-center gap-2"><Button variant="ghost" disabled={busy} onClick={() => void refresh()}>{busy ? t("localizationIssueChrome.checking") : t("oct5Core.s0317")}</Button>
        <Button asChild><a href={COMPOSIO_APP_MANAGEMENT_URL} target="_blank" rel="noopener noreferrer">{t("oct6Beta.copy267")}<ExternalLink className="size-4" /></a></Button></div>
    </DialogFooter>
  </>;
}
