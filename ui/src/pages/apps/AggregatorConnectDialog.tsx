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
        <DialogTitle>{provider ? `Connect ${app.name} through ${provider.name}` : `Connect ${app.name}`}</DialogTitle>
        <DialogDescription className={selected?.provider === "composio" ? "sr-only" : undefined}>{selected?.provider === "composio"
          ? `Choose a saved Composio account or connect a new one to use ${app.name}.`
          : provider
          ? `Your ${provider.name} gateway is already saved. ${app.name} authorization is managed inside ${provider.name}.`
          : "Which service would you like to use? This service handles the connection and requests to this app."}</DialogDescription>
      </DialogHeader>
      {!selected ? <div className="space-y-2">{[...app.routes].sort((a, b) => Number(Boolean(connections[b.provider]?.length)) - Number(Boolean(connections[a.provider]?.length))).map((route) => {
        const accounts = connections[route.provider] ?? [];
        const name = remoteMcpProviders[route.provider].name;
        const status = accounts.some((connection) => connection.status === "active" && connection.enabled && !isToolConnectionAttentionHealth(connection.healthStatus))
          ? "Already connected" : accounts.some((connection) => connection.status === "draft") ? "Setup incomplete" : accounts.length ? "Needs attention" : "Set up a connection";
        return <button type="button" key={route.provider} onClick={() => choose(route)}
          className="flex w-full items-center gap-3 rounded-lg border border-border px-4 py-3 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <AppLogo name={name} brandKey={route.provider} size={24} />
          <div className="min-w-0 flex-1"><div className="text-sm font-medium">{name}</div><div className="text-xs text-muted-foreground">{status}</div></div>
          <span className="text-xs text-muted-foreground">Continue →</span>
        </button>;
      })}</div> : <div className="space-y-4">
        {selected.provider !== "composio" ? <div className="space-y-2"><Label htmlFor="aggregator-account">{provider!.name} account</Label>
          <select id="aggregator-account" value={account?.id ?? ""} onChange={event => setSelectedAccountId(event.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
            {existing.map(connection => <option key={connection.id} value={connection.id}>{connection.name}</option>)}
          </select>
        </div> : null}
        {selected.provider === "composio" ? <ComposioAppSetup name={app.name} toolkit={selected.toolkit} connections={existing.filter(connection => connection.status === "active" && connection.enabled && !isToolConnectionAttentionHealth(connection.healthStatus))} onClose={onClose}
          onBack={canChooseProvider ? () => setSelected(null) : undefined} onConnectNew={() => { onNavigate(`${aggregatorAppConnectHref(selected)}&new=1`); onClose(); }} /> : null}

      </div>}
      {selected?.provider !== "composio" ? <DialogFooter className="sm:items-center sm:justify-between">
        <Button variant="ghost" onClick={selected && canChooseProvider ? () => setSelected(null) : onClose}>{selected && canChooseProvider ? "Back" : "Cancel"}</Button>
        {selected ? <div className="flex flex-wrap items-center gap-3">
          {managementUrl ? <Button asChild><a href={managementUrl} target="_blank" rel="noopener noreferrer" onClick={onClose}>Continue<ExternalLink className="size-4" /></a></Button> : null}
          <Button variant="link" size="sm" className="h-auto p-0 text-xs text-muted-foreground hover:text-foreground" onClick={() => { onNavigate(`${aggregatorAppConnectHref(selected)}&new=1`); onClose(); }}>Connect a new account</Button>
        </div> : null}
      </DialogFooter> : null}
    </DialogContent>
  </Dialog>;
}
