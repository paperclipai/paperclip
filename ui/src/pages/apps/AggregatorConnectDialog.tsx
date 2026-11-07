import { getPageValueLabel } from "@/pages/tools/shared";
import { t as finalPagesT } from "@/i18n";
import { useTranslation } from "@/i18n";
import { useState } from "react";
import { aggregatorManagementUrl } from "@paperclipai/shared/aggregator-apps";
import { Label } from "@/components/ui/label";
import { ExternalLink } from "lucide-react";
import type { AggregatorAppCatalogEntry, AggregatorAppRoute } from "@paperclipai/shared/aggregator-app-catalog";
import { isToolConnectionAttentionHealth, type ToolConnection } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AppLogo } from "./AppLogo";
import { remoteMcpProviders } from "@/features/connections/remote-mcp/providers";
import { ComposioAppSetup } from "./ComposioAppSetup";

export function aggregatorAppConnectHref(route: AggregatorAppRoute, connection?: ToolConnection) {
  const params = new URLSearchParams({ source: route.provider, targetToolkit: route.toolkit });
  if (connection) params.set(connection.status === "draft" ? "resume" : "reconnect", connection.id);
  return `/apps/connect?${params}`;
}

export function AggregatorConnectDialog({ app, connections, initialProvider, onClose, onNavigate }: {
  app: AggregatorAppCatalogEntry;
  connections: Partial<Record<AggregatorAppRoute["provider"], ToolConnection[]>>;
  initialProvider?: AggregatorAppRoute["provider"];
  onClose: () => void;
  onNavigate: (href: string) => void;
}) {
  const { t } = useTranslation("connections");
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [selected, setSelected] = useState<AggregatorAppRoute | null>(() => app.routes.find(route => route.provider === initialProvider) ?? (app.routes.length === 1 ? app.routes[0] : null));
  const canChooseProvider = app.routes.length > 1;
  const existing = selected ? connections[selected.provider] ?? [] : [];
  const usableConnection = existing.find((connection) => connection.status === "active" && connection.enabled && !isToolConnectionAttentionHealth(connection.healthStatus));
  const account = existing.find(connection => connection.id === selectedAccountId) ?? usableConnection ?? existing[0];
  const managementUrl = selected ? aggregatorManagementUrl(selected.provider, typeof account?.config?.managementUrl === "string" ? account.config.managementUrl : null) : null;
  const provider = selected ? remoteMcpProviders[selected.provider] : null;
  function choose(route: AggregatorAppRoute) {
    const accounts = connections[route.provider] ?? [];
    if (accounts.length === 0) { onNavigate(aggregatorAppConnectHref(route)); onClose(); }
    else setSelected(route);
  }
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{provider ? t("connect_through_870806f", { name: app.name, name2: provider.name }) : t("connect_f7689e7", { name: app.name })}</DialogTitle>
        <DialogDescription className={selected?.provider === "composio" ? "sr-only" : undefined}>{selected?.provider === "composio"
          ? t("choose_a_saved_composio_account_or_connect_d5687c3", { name: app.name })
          : provider
          ? t("your_gateway_is_already_saved_authorization_is_9cb2a14", { name: provider.name, name2: app.name, name3: provider.name })
          : t("which_service_would_you_like_to_use_c00fc57")}</DialogDescription>
      </DialogHeader>
      {!selected ? <div className="space-y-2">{[...app.routes].sort((a, b) => Number(Boolean(connections[b.provider]?.length)) - Number(Boolean(connections[a.provider]?.length))).map((route) => {
        const accounts = connections[route.provider] ?? [];
        const name = remoteMcpProviders[route.provider].name;
        const status = accounts.some((connection) => connection.status === "active" && connection.enabled && !isToolConnectionAttentionHealth(connection.healthStatus))
          ? t("already_connected_15bd633") : accounts.some((connection) => connection.status === "draft") ? t("setup_incomplete_7eeb257") : accounts.length ? t("needs_attention_a126722") : t("set_up_a_connection_91e2133");
        return <button type="button" key={route.provider} onClick={() => choose(route)}
          className="flex w-full items-center gap-3 rounded-lg border border-border px-4 py-3 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <AppLogo name={name} brandKey={route.provider} size={24} />
          <div className="min-w-0 flex-1"><div className="text-sm font-medium">{name}</div><div className="text-xs text-muted-foreground">{getPageValueLabel(status)}</div></div>
          <span className="text-xs text-muted-foreground">{t("continue_6c447f2")}</span>
        </button>;
      })}</div> : <div className="space-y-4">
        {selected.provider !== "composio" ? <div className="space-y-2"><Label htmlFor="aggregator-account">{finalPagesT("final-pages:provider_account_8e0d96", { provider: provider!.name })}</Label>
          <select id="aggregator-account" value={account?.id ?? ""} onChange={event => setSelectedAccountId(event.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
            {existing.map(connection => <option key={connection.id} value={connection.id}>{connection.name}</option>)}
          </select>
        </div> : null}
        {selected.provider === "composio" ? <ComposioAppSetup name={app.name} toolkit={selected.toolkit} connections={existing.filter(connection => connection.status === "active" && connection.enabled && !isToolConnectionAttentionHealth(connection.healthStatus))} onClose={onClose}
          onBack={canChooseProvider ? () => setSelected(null) : undefined} onConnectNew={() => { onNavigate(`${aggregatorAppConnectHref(selected)}&new=1`); onClose(); }} /> : null}

      </div>}
      {selected?.provider !== "composio" ? <DialogFooter className="sm:items-center sm:justify-between">
        <Button variant="ghost" onClick={selected && canChooseProvider ? () => setSelected(null) : onClose}>{selected && canChooseProvider ? t("back_b52b36b") : t("cancel_77dfd21")}</Button>
        {selected ? <div className="flex flex-wrap items-center gap-3">
          {managementUrl ? <Button asChild><a href={managementUrl} target="_blank" rel="noopener noreferrer" onClick={onClose}>{t("continue_2e02623")}<ExternalLink className="size-4" /></a></Button> : null}
          <Button variant="link" size="sm" className="h-auto p-0 text-xs text-muted-foreground hover:text-foreground" onClick={() => { onNavigate(`${aggregatorAppConnectHref(selected)}&new=1`); onClose(); }}>{t("connect_a_new_account_2693b3d")}</Button>
        </div> : null}
      </DialogFooter> : null}
    </DialogContent>
  </Dialog>;
}
