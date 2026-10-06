import { t, useTranslation } from "@/i18n";
import { Trans } from "react-i18next";
import { aggregatorDiscoveryDisplayText } from "./aggregator-discovery-display";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import type { ToolConnection } from "@paperclipai/shared";
import { AGGREGATOR_NAMES, aggregatorManagementUrl, isAppAggregator } from "@paperclipai/shared/aggregator-apps";
import type { AggregatorAppCatalogEntry } from "@paperclipai/shared/aggregator-app-catalog";
import { toolsApi } from "@/api/tools";
import { useAccountIdentity } from "@/api/companies-query";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function AggregatorAppManager({ app, connections, initialConnectionId, onClose }: {
  app: AggregatorAppCatalogEntry; connections: ToolConnection[]; initialConnectionId?: string; onClose: () => void;
}) {
  useTranslation();
  const [connectionId, setConnectionId] = useState(initialConnectionId ?? connections[0]?.id ?? "");
  const connection = connections.find(candidate => candidate.id === connectionId);
  const provider = connection?.config?.sourceTemplateKey;
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent>
    <DialogHeader><DialogTitle>{t("oct6Beta.dynamic124", { v0: app.name })}</DialogTitle>
      <DialogDescription>{t("oct6Beta.managedAccounts", { provider: isAppAggregator(provider) ? AGGREGATOR_NAMES[provider] : t("oct6Beta.providerFallback") })}</DialogDescription>
    </DialogHeader>
    {connections.length > 1 ? <div className="space-y-2"><Label htmlFor="manage-aggregator-gateway">{t("localizationIssueAux.ui_Connection_2r1h4p")}</Label>
      <select id="manage-aggregator-gateway" className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={connectionId} onChange={event => setConnectionId(event.target.value)}>
        {connections.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
      </select></div> : null}
    {connection ? <AccountObservations key={connection.id} app={app} connection={connection} onClose={onClose} /> : <p role="alert">{t("oct6Beta.copy199")}</p>}
  </DialogContent></Dialog>;
}

function AccountObservations({ app, connection, onClose }: { app: AggregatorAppCatalogEntry; connection: ToolConnection; onClose: () => void }) {
  useTranslation();
  const queries = useQueryClient();
  const { userId, settled } = useAccountIdentity();
  const key = queryKeys.tools.aggregatorApps(connection.id, userId);
  const query = useQuery({ queryKey: key, enabled: settled, queryFn: () => toolsApi.listAggregatorApps(connection.id), refetchInterval: query => query.state.data?.sync.status === "syncing" ? 1500 : false });
  const snapshots = (settled ? query.data?.apps : undefined)?.filter(snapshot => snapshot.appSlug === app.slug) ?? [];
  const accounts = snapshots.flatMap(snapshot => snapshot.accounts.map(account => ({ account, snapshot })));
  const refresh = useMutation({ mutationFn: async () => { const result = await toolsApi.refreshAggregatorApps(connection.id, snapshots.map(snapshot => snapshot.toolkit)); queries.setQueryData(key, result); } });
  const provider = query.data?.provider;
  const name = provider ? AGGREGATOR_NAMES[provider] : t("oct6Beta.providerFallback");
  const managementUrl = provider ? aggregatorManagementUrl(provider, accounts[0]?.account.managementUrl ?? (typeof connection.config?.managementUrl === "string" ? connection.config?.managementUrl : null)) : null;
  return <>
    {query.isError || refresh.isError || query.data?.sync.status === "error" ? <p role="alert" className="text-sm text-destructive">{t("oct6Beta.checkAccountsFailed", { provider: name })}</p> : null}
    {query.isLoading ? <p role="status" className="text-sm text-muted-foreground">{t("oct6Beta.copy200")}</p> : accounts.length ? <div className="divide-y divide-border">
      {accounts.map(({ account, snapshot }) => <div key={`${snapshot.toolkit}:${account.id}`} className="py-3">
        <p className="text-sm font-medium">{account.alias || t("oct6Beta.dynamic104", { v0: app.name })}</p>
        <p className="text-xs text-muted-foreground">{snapshot.freshness === "stale" || snapshot.errorAt || Date.now() - new Date(snapshot.checkedAt).getTime() > 5 * 60_000 || account.status === "UNVERIFIED" ? t("sep28Apps.copy220") : account.status === "ACTIVE" ? t("sep13Connections.status_connected") : account.status === "INITIATED" ? t("sep28Apps.waitingSignIn") : t("oct6Beta.copy201")}</p>
      </div>)}
    </div> : <p className="text-sm text-muted-foreground">{aggregatorDiscoveryDisplayText(provider, query.data?.discovery.message) ?? t("oct6Beta.dynamic105", { v0: app.name })}</p>}
    <p className="text-xs text-muted-foreground"><Trans i18nKey="oct6Beta.viaConnection" values={{ name: connection.name }} components={{ connection: <Link to={`/apps/${connection.id}/permissions`} onClick={onClose} className="underline underline-offset-2" /> }} /></p>
    <DialogFooter className="sm:justify-between"><Button variant="ghost" onClick={onClose}>{t("sep28Routines.close")}</Button><div className="flex flex-wrap items-center gap-2">
      <Button variant="ghost" disabled={!settled || refresh.isPending || query.data?.discovery.availability !== "available"} onClick={() => refresh.mutate()}>{t("oct5Core.s0317")}</Button>
      {managementUrl ? <Button asChild><a href={managementUrl} target="_blank" rel="noopener noreferrer">{t("oct6Beta.openInProvider", { provider: name })}<ExternalLink className="size-4" /></a></Button> : null}
    </div></DialogFooter>
  </>;
}
