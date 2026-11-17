import { useEffect, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { tailscaleApi, type TailscaleConnection } from "@/api/tailscale";
import { describeError } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { tailscaleConnectionsKey, useTailscaleConnections } from "@/hooks/useTailscaleConnections";
import { Link, useSearchParams } from "@/lib/router";
import { useAuthorizationWindow } from "@/hooks/useAuthorizationWindow";
import { AppLogo } from "./AppLogo";
import { TailscaleDeviceSignIn } from "./TailscaleDeviceSignIn";

export const TAILSCALE_CONNECTOR_PATH = "/apps/tailscale";

export function TailscaleConnectorCard({ onNavigate }: { onNavigate: (href: string) => void }) {
  const { selectedCompanyId } = useCompany();
  const connections = useTailscaleConnections(selectedCompanyId);
  const connected = connections.data?.filter(connection => connection.status === "connected") ?? [];
  if (!connections.canManage) return null;
  return <div role="listitem" data-app-slug="tailscale" data-connected={String(connected.length > 0)} className="overflow-hidden rounded-xl border border-border">
    <div className="flex flex-wrap items-center gap-3 px-4 py-4">
      <AppLogo name="Tailscale" brandKey="tailscale" size={36} />
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-semibold text-foreground">Tailscale</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">Connect your tailnet to use its machines in SSH environments.</p>
      </div>
      <Button type="button" size="sm" variant="outline" onClick={() => onNavigate(TAILSCALE_CONNECTOR_PATH)} aria-label={`${connected.length ? "Manage" : "Connect"} Tailscale`}>{connected.length ? "Manage" : "Connect"}</Button>
    </div>
    {connected.length > 0 && <p className="border-t border-border px-4 py-3 text-sm text-muted-foreground">{connected.map(connection => connection.name).join(", ")} · Connected</p>}
    {connections.error && <p role="alert" className="border-t border-border px-4 py-3 text-sm text-destructive">{describeError(connections.error, { action: "load Tailscale connections" }).body}</p>}
  </div>;
}

export function TailscaleConnector() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const client = useQueryClient();
  const [searchParams] = useSearchParams();
  const connections = useTailscaleConnections(selectedCompanyId);
  const authorization = useAuthorizationWindow();
  const company = useRef(selectedCompanyId);
  company.current = selectedCompanyId;
  const connect = useMutation({ mutationFn: async (input: { companyId: string; connectionId?: string }) => {
    const result = await tailscaleApi.connect(input.companyId, input.connectionId);
    client.setQueryData<TailscaleConnection[]>(tailscaleConnectionsKey(input.companyId), rows => [
      ...(rows ?? []).filter(row => row.id !== result.connection.id), result.connection,
    ]);
    if (company.current !== input.companyId) return;
    if (result.authorizationUrl) await authorization.open(result.authorizationUrl);
    else authorization.cancel();
  }, onError: () => authorization.cancel() });
  const start = (connectionId?: string) => {
    if (!selectedCompanyId) return;
    authorization.reserve();
    connect.mutate({ companyId: selectedCompanyId, connectionId });
  };
  const disconnect = useMutation({ mutationFn: (connectionId: string) => tailscaleApi.disconnect(selectedCompanyId!, connectionId),
    onSuccess: () => { authorization.cancel(); return client.invalidateQueries({ queryKey: tailscaleConnectionsKey(selectedCompanyId) }); } });
  useEffect(() => authorization.cancel, [selectedCompanyId, authorization.cancel]);
  useEffect(() => {
    setBreadcrumbs([{ label: "Connectors", href: "/apps" }, { label: "Tailscale" }]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs]);
  if (!selectedCompanyId) return <p className="text-sm text-muted-foreground">Select an organization to connect Tailscale.</p>;
  if (connections.access.isPending) return <p className="text-sm text-muted-foreground">Checking Tailscale management access…</p>;
  if (connections.access.error) return <p role="alert" className="text-sm text-destructive">{describeError(connections.access.error, { action: "check Tailscale management access" }).body}</p>;
  if (!connections.canManage) return <p className="text-sm text-muted-foreground">Ask an instance administrator to connect or manage Tailscale networks.</p>;
  const error = connect.error ?? disconnect.error ?? connections.error;
  const outcome = searchParams.get("tailscale_error");
  const returnError = outcome === "cancelled" ? "Tailscale authorization was canceled. Try again to connect your network."
    : outcome === "failed" ? "Tailscale authorization could not be completed. Try again." : null;
  const retryConnection = connections.data?.find(connection => connection.id === searchParams.get("tailscale_connection"));
  return <div className="max-w-3xl space-y-6 pb-8">
    <header className="flex items-center gap-3"><AppLogo name="Tailscale" brandKey="tailscale" size={36} /><h1 className="text-xl font-semibold">Tailscale</h1></header>
    <p className="text-sm text-muted-foreground">Give Paperclip access to your tailnet, then choose one of its machines when creating an SSH environment. Agents can use any harness supported by that environment.</p>
    {connections.isPending && <p className="text-sm text-muted-foreground">Loading tailnet connections…</p>}
    {returnError && <div role="alert" className="space-y-3"><p className="text-sm text-destructive">{returnError}</p>{retryConnection && <Button variant="outline" disabled={connect.isPending} onClick={() => start(retryConnection.id)}>Try again</Button>}</div>}
    {error && <div role="alert" className="space-y-3"><p className="text-sm text-destructive">{describeError(error, { action: "connect Tailscale" }).body}</p><Button variant="outline" onClick={() => void connections.refetch()}>Refresh connections</Button></div>}
    <div className="divide-y divide-border">{(connections.data ?? []).map(connection => <div key={connection.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="min-w-0 flex-1 space-y-1"><p className="font-medium">{connection.name}</p><p className="text-sm text-muted-foreground">{connection.status === "connected" ? "Connected" : connection.status === "authorizing" ? "Waiting for sign-in" : connection.status === "connecting" ? "Connecting" : connection.status === "disconnected" ? "Disconnected" : connection.status === "expired" ? "Sign-in expired" : "Authorization not completed"}</p></div>
      {connection.status === "connected" ? <>
        <Button variant="outline" asChild><Link to={`/company/settings/instance/environments/new?tailscale_connection=${encodeURIComponent(connection.id)}`}>Create SSH environment</Link></Button>
        <Button variant="ghost" disabled={disconnect.isPending} onClick={() => disconnect.mutate(connection.id)}>Disconnect {connection.name}</Button>
      </> : connection.status === "authorizing" ? <TailscaleDeviceSignIn key={`${selectedCompanyId}:${connection.id}`} connection={connection} cancel={() => disconnect.mutate(connection.id)} disabled={disconnect.isPending} />
        : <Button variant="outline" disabled={connect.isPending} onClick={() => start(connection.id)}>Reconnect {connection.name}</Button>}
    </div>)}</div>
    <footer className="flex items-center justify-between gap-3 border-t border-border pt-4">
      <Button variant="ghost" asChild><Link to="/apps">Back to connectors</Link></Button>
      <Button disabled={connect.isPending || connections.isError || connections.data?.some(connection => connection.status === "authorizing")} onClick={() => start()}>{connect.isPending ? "Connecting…" : "Connect Tailscale Network"}</Button>
    </footer>
  </div>;
}
