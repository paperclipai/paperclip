import { useTranslation } from "@/i18n";
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
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function AggregatorAppManager({ app, connections, initialConnectionId, onClose }: {
  app: AggregatorAppCatalogEntry; connections: ToolConnection[]; initialConnectionId?: string; onClose: () => void;
}) {
  const { t } = useTranslation("connections");
  const [connectionId, setConnectionId] = useState(initialConnectionId ?? connections[0]?.id ?? "");
  const connection = connections.find(candidate => candidate.id === connectionId);
  const provider = connection?.config?.sourceTemplateKey;
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent>
    <DialogHeader><DialogTitle>{t("manage_7cd10b5", { name: app.name })}</DialogTitle>
      <DialogDescription>{t("accounts_and_sign_in_are_managed_in_f7af45b", { providerName: isAppAggregator(provider) ? AGGREGATOR_NAMES[provider] : t("reviewBProvider") })}</DialogDescription>
    </DialogHeader>
    {connections.length > 1 ? <div className="space-y-2"><Label htmlFor="manage-aggregator-gateway">{t("connection_6512ee1")}</Label>
      <select id="manage-aggregator-gateway" className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={connectionId} onChange={event => setConnectionId(event.target.value)}>
        {connections.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
      </select></div> : null}
    {connection ? <AccountObservations key={connection.id} app={app} connection={connection} onClose={onClose} /> : <p role="alert">{t("this_connection_is_no_longer_available_fa7f3a8")}</p>}
  </DialogContent></Dialog>;
}

function AccountObservations({ app, connection, onClose }: { app: AggregatorAppCatalogEntry; connection: ToolConnection; onClose: () => void }) {
  const { t } = useTranslation("connections");
  const queries = useQueryClient();
  const { userId, settled } = useAccountIdentity();
  const key = queryKeys.tools.aggregatorApps(connection.id, userId);
  const query = useQuery({ queryKey: key, enabled: settled, queryFn: () => toolsApi.listAggregatorApps(connection.id), refetchInterval: query => query.state.data?.sync.status === "syncing" ? 1500 : false });
  const queryView = useQueryView(query);
  const snapshots = (settled ? query.data?.apps : undefined)?.filter(snapshot => snapshot.appSlug === app.slug) ?? [];
  const accounts = snapshots.flatMap(snapshot => snapshot.accounts.map(account => ({ account, snapshot })));
  const refresh = useMutation({ mutationFn: async () => { const result = await toolsApi.refreshAggregatorApps(connection.id, snapshots.map(snapshot => snapshot.toolkit)); queries.setQueryData(key, result); } });
  const provider = query.data?.provider;
  const name = provider ? AGGREGATOR_NAMES[provider] : "provider";
  const managementUrl = provider ? aggregatorManagementUrl(provider, accounts[0]?.account.managementUrl ?? (typeof connection.config?.managementUrl === "string" ? connection.config?.managementUrl : null)) : null;
  return <>
    {queryView.kind === "error" ? <QueryErrorState error={query.error} action={`load ${name} accounts`} onRetry={queryView.retry} retrying={queryView.isFetching} /> : null}
    {refresh.error || query.data?.sync.status === "error" ? <p role="alert" className="text-sm text-destructive">{t("couldn_t_check_last_known_accounts_are_9305c83", { name: name })}</p> : null}
    {query.isLoading || queryView.kind === "reconnecting" ? <p role="status" className="text-sm text-muted-foreground">{t("loading_accounts_cef47e9")}</p> : accounts.length ? <div className="divide-y divide-border">
      {accounts.map(({ account, snapshot }) => <div key={`${snapshot.toolkit}:${account.id}`} className="py-3">
        <p className="text-sm font-medium">{account.alias || t("account_5dc82f2", { name: app.name })}</p>
        <p className="text-xs text-muted-foreground">{snapshot.freshness === "stale" || snapshot.errorAt || Date.now() - new Date(snapshot.checkedAt).getTime() > 5 * 60_000 || account.status === "UNVERIFIED" ? t("not_verified_fbc0fa8") : account.status === "ACTIVE" ? t("connected_c2f9b7b") : account.status === "INITIATED" ? t("waiting_for_sign_in_8e02d8c") : t("needs_sign_in_660cb81")}</p>
      </div>)}
    </div> : <p className="text-sm text-muted-foreground">{query.data?.discovery.message ?? t("no_connected_accounts_d707b32", { name: app.name })}</p>}
    <p className="text-xs text-muted-foreground">{t("via_81ffa42")}<Link to={`/apps/${connection.id}/permissions`} onClick={onClose} className="underline underline-offset-2">“{connection.name}”</Link></p>
    <DialogFooter className="sm:justify-between"><Button variant="ghost" onClick={onClose}>{t("close_bbfa773")}</Button><div className="flex flex-wrap items-center gap-2">
      <Button variant="ghost" disabled={!settled || refresh.isPending || query.data?.discovery.availability !== "available"} onClick={() => refresh.mutate()}>{t("refresh_56e3bad")}</Button>
      {managementUrl ? <Button asChild><a href={managementUrl} target="_blank" rel="noopener noreferrer">{t("open_in_001749e", { name })}<ExternalLink className="size-4" /></a></Button> : null}
    </div></DialogFooter>
  </>;
}
