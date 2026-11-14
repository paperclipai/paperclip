import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { TailscaleConnection } from "@paperclipai/shared";
import { tailscaleApi } from "@/api/tailscale";
import { describeError } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { tailscaleConnectionsKey } from "@/hooks/useTailscaleConnections";

export function TailscaleDeviceSignIn({ connection, cancel, disabled }: {
  connection: TailscaleConnection; cancel: () => void; disabled: boolean;
}) {
  const client = useQueryClient();
  const [expired, setExpired] = useState(false);
  const status = useQuery({
    queryKey: ["tailscale-device-login", connection.companyId, connection.id],
    queryFn: () => tailscaleApi.deviceLogin(connection.companyId, connection.id),
    gcTime: 0,
    refetchInterval: query => expired || query.state.error || query.state.data?.connection.status !== "authorizing" ? false : 2000,
    refetchOnWindowFocus: !expired,
  });
  useEffect(() => {
    const next = status.data?.connection;
    if (!next || next.status === "authorizing") return;
    client.setQueryData<TailscaleConnection[]>(tailscaleConnectionsKey(connection.companyId), rows => rows?.map(row => row.id === next.id ? next : row));
  }, [status.data, client, connection.companyId]);
  useEffect(() => {
    const deadline = status.data?.expiresAt ? Date.parse(status.data.expiresAt) : Date.now() + 10 * 60_000;
    const timer = window.setTimeout(() => setExpired(true), Math.max(0, deadline - Date.now()));
    return () => window.clearTimeout(timer);
  }, [status.data?.expiresAt]);
  return <div className="space-y-3">
    <p className="text-sm text-muted-foreground" role="status">{expired ? "Sign-in expired. Cancel and connect again."
      : status.data?.needsApproval ? "Waiting for a Tailscale administrator to approve this device."
        : "Approve the connection in Tailscale. This page will update when you finish."}</p>
    {status.error && <p role="alert" className="text-sm text-destructive">{describeError(status.error, { action: "check Tailscale sign-in" }).body}</p>}
    <div className="flex flex-wrap items-center gap-3">
      {!expired && status.data?.authorizationUrl && <Button variant="outline" asChild><a href={status.data.authorizationUrl} target="_blank" rel="noopener noreferrer">Continue to Tailscale</a></Button>}
      {status.data?.needsApproval && !expired && <Button variant="outline" asChild><a href="https://login.tailscale.com/admin/machines" target="_blank" rel="noopener noreferrer">Open Tailscale devices</a></Button>}
      {status.error && !expired && <Button variant="outline" onClick={() => void status.refetch()}>Check again</Button>}
      <Button variant="ghost" disabled={disabled} onClick={cancel}>Cancel sign-in</Button>
    </div>
  </div>;
}
