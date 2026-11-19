import { type FormEvent, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { McpConnector, McpConnectorEnrollment } from "@paperclipai/shared";
import { Cable, Check, Copy, Plus, RotateCcw, ShieldOff } from "lucide-react";
import { ApiError } from "@/api/client";
import { mcpConnectorsApi } from "@/api/mcp-connectors";
import { toolsApi } from "@/api/tools";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/context/ToastContext";
import { copyTextToClipboard } from "@/lib/clipboard";
import { queryKeys } from "@/lib/queryKeys";
import { ErrorState, HealthBadge, LoadingState, RelativeTime, ToolsPageHeader } from "./shared";

function errorMessage(error: unknown) {
  return error instanceof ApiError ? error.message : String(error);
}

function connectorStatus(connector: McpConnector): { status: string; label: string } {
  if (connector.status === "revoked") return { status: "failed", label: "revoked" };
  if (connector.status === "pending") return { status: "unknown", label: "waiting for enrollment" };
  return connector.online ? { status: "ok", label: "online" } : { status: "degraded", label: "offline" };
}

/** Shown exactly once after create/re-enroll. The token is never readable again. */
function EnrollmentTokenPanel({ enrollment, onDone }: { enrollment: McpConnectorEnrollment; onDone: () => void }) {
  const { pushToast } = useToast();
  const [copied, setCopied] = useState(false);
  const origin = typeof window === "undefined" ? "https://paperclip.example.com" : window.location.origin;
  const snippet = [
    `PAPERCLIP_URL=${origin}`,
    `PAPERCLIP_MCP_CONNECTOR_ENROLLMENT_TOKEN=${enrollment.enrollmentToken}`,
    "PAPERCLIP_MCP_CONNECTOR_UPSTREAMS=name=http://mcp.internal:3000/mcp",
  ].join("\n");
  const copy = async () => {
    try {
      await copyTextToClipboard(snippet);
      setCopied(true);
    } catch {
      pushToast({ title: "Copy failed", body: "Select the text and copy it manually.", tone: "error" });
    }
  };
  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">
          Enrollment token for {enrollment.connector.name}
        </p>
        <p className="text-sm text-muted-foreground">
          Copy it now: it is shown only once, works once, and expires <RelativeTime value={enrollment.enrollmentExpiresAt} />.
          Set these variables on the connector inside your private network. Upstream URLs stay on the connector.
        </p>
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-border bg-background p-3 font-mono text-xs text-foreground">
        {snippet}
      </pre>
      <div className="flex items-center justify-between gap-2">
        <Button type="button" variant="outline" size="sm" onClick={copy}>
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button type="button" size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

class DialogCancelledError extends Error {
  constructor() {
    super("Connection setup was cancelled");
  }
}

/** Create a `transport: "connector"` connection for one published upstream, probe it, then activate it. */
function AddConnectorConnectionDialog({
  companyId,
  connector,
  initialUpstream,
  onClose,
}: {
  companyId: string;
  connector: McpConnector;
  initialUpstream?: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { pushToast } = useToast();
  const [upstream, setUpstream] = useState(initialUpstream ?? connector.upstreams[0] ?? "");
  const [name, setName] = useState(upstream ? `${connector.name} ${upstream}` : "");
  // Refs so an in-flight mutation sees a close that happens after it started
  // and the close handler sees a connection ID the moment it exists.
  const cancelledRef = useRef(false);
  const draftConnectionIdRef = useRef<string | null>(null);

  const invalidateConnections = () => {
    qc.invalidateQueries({ queryKey: queryKeys.tools.connections(companyId) });
    qc.invalidateQueries({ queryKey: queryKeys.tools.applications(companyId) });
  };

  // Removes the connection a cancelled setup left behind. The dialog is
  // usually gone by the time this settles, so a failure is reported through a
  // toast that lets the operator retry instead of being dropped.
  const removeCancelledConnection = async (connectionId: string): Promise<void> => {
    try {
      await toolsApi.archiveConnection(connectionId);
      if (draftConnectionIdRef.current === connectionId) draftConnectionIdRef.current = null;
    } catch (error) {
      // Setup may already have activated it: at least take it out of service.
      const disabled = await toolsApi
        .updateConnection(connectionId, { status: "draft", enabled: false })
        .then(() => true, () => false);
      pushToast({
        title: "Could not remove cancelled connection",
        body: `${errorMessage(error)} ${
          disabled ? "It has been disabled" : "It may still be enabled"
        }. Retry, or remove it under Apps.`,
        tone: "error",
        action: { label: "Retry removal", onClick: () => void removeCancelledConnection(connectionId) },
      });
    } finally {
      invalidateConnections();
    }
  };

  const handleClose = () => {
    cancelledRef.current = true;
    // While a create/probe/activate request is in flight, the mutation archives
    // the connection itself once its current step returns, so cleanup never
    // races activation.
    if (!create.isPending && draftConnectionIdRef.current) {
      void removeCancelledConnection(draftConnectionIdRef.current);
    }
    onClose();
  };

  const create = useMutation({
    mutationFn: async () => {
      cancelledRef.current = false;
      let connectionId = draftConnectionIdRef.current;
      let activated = false;
      const throwIfCancelled = () => {
        if (cancelledRef.current) throw new DialogCancelledError();
      };
      try {
        if (connectionId) {
          await toolsApi.updateConnection(connectionId, {
            name: name.trim(),
            config: { connectorId: connector.id, upstream },
          });
        } else {
          const connection = await toolsApi.createConnection(companyId, {
            applicationName: name.trim(),
            name: name.trim(),
            transport: "connector",
            status: "draft",
            enabled: false,
            config: { connectorId: connector.id, upstream },
          });
          connectionId = connection.id;
          draftConnectionIdRef.current = connection.id;
        }
        throwIfCancelled();
        await toolsApi.checkConnectionHealth(connectionId);
        throwIfCancelled();
        await toolsApi.updateConnection(connectionId, { status: "active", enabled: true });
        activated = true;
        throwIfCancelled();
        const refreshed = await toolsApi.refreshCatalog(connectionId);
        throwIfCancelled();
        return refreshed;
      } catch (error) {
        if (!connectionId) throw error;
        // The operator closed the dialog mid-flight: remove whatever this run
        // created, after its last request settled, so nothing is left active.
        if (cancelledRef.current) {
          await removeCancelledConnection(connectionId);
          throw error;
        }
        // Discovery did not finish: put the connection back to an inactive
        // draft so a retry (or closing the dialog) starts from a clean state.
        if (activated) {
          try {
            await toolsApi.updateConnection(connectionId, { status: "draft", enabled: false });
          } catch (rollbackError) {
            throw new Error(
              `${errorMessage(error)} The connection could not be deactivated (${errorMessage(rollbackError)}) and is still enabled; retry, or close this dialog to remove it.`,
            );
          }
        }
        throw error;
      }
    },
    onSuccess: (refreshed) => {
      draftConnectionIdRef.current = null;
      invalidateConnections();
      pushToast({
        title: "Connection added",
        body: `${refreshed.discoveredCount} actions discovered. Review access for them under Apps.`,
        tone: "success",
      });
      onClose();
    },
    onError: (error) => {
      invalidateConnections();
      if (error instanceof DialogCancelledError) return;
      pushToast({ title: "Could not add connection", body: errorMessage(error), tone: "error" });
    },
  });

  const canCreate = Boolean(upstream) && name.trim().length > 0 && !create.isPending;

  return (
    <Dialog open onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add connection through {connector.name}</DialogTitle>
          <DialogDescription>
            Paperclip addresses the upstream only by name. Profiles, policies, approvals and the audit log apply
            exactly as for any other MCP connection, and the server is labelled Unverified until reviewed.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Upstream</Label>
            <Select value={upstream} onValueChange={setUpstream}>
              <SelectTrigger>
                <SelectValue placeholder="Select an upstream" />
              </SelectTrigger>
              <SelectContent>
                {connector.upstreams.map((entry) => (
                  <SelectItem key={entry} value={entry}>
                    {entry}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="connector-connection-name">Connection name</Label>
            <Input
              id="connector-connection-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. UniFi Network (read-only)"
            />
          </div>
        </div>
        <DialogFooter className="flex-row items-center justify-between sm:justify-between">
          <Button type="button" variant="outline" onClick={handleClose}>
            Cancel
          </Button>
          <Button type="button" onClick={() => create.mutate()} disabled={!canCreate}>
            {create.isPending ? "Connecting…" : "Connect and discover actions"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RevokeConnectorDialog({
  connector,
  pending,
  onConfirm,
  onClose,
}: {
  connector: McpConnector;
  pending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Revoke {connector.name}?</DialogTitle>
          <DialogDescription>
            The connector is disconnected immediately and in-flight calls fail. Connections that use it stop
            working until they are moved to another connector. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex-row items-center justify-between sm:justify-between">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={onConfirm} disabled={pending}>
            {pending ? "Revoking…" : "Revoke connector"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ConnectorsTab({ companyId }: { companyId: string }) {
  const qc = useQueryClient();
  const { pushToast } = useToast();
  const [draftName, setDraftName] = useState("");
  const [enrollment, setEnrollment] = useState<McpConnectorEnrollment | null>(null);
  const [addFor, setAddFor] = useState<{ connector: McpConnector; upstream?: string } | null>(null);
  const [revoking, setRevoking] = useState<McpConnector | null>(null);

  const connectors = useQuery({
    queryKey: queryKeys.tools.mcpConnectors(companyId),
    queryFn: () => mcpConnectorsApi.list(companyId),
    refetchInterval: 15_000,
  });
  const connections = useQuery({
    queryKey: queryKeys.tools.connections(companyId),
    queryFn: () => toolsApi.listConnections(companyId),
  });
  const imported = new Set(
    (connections.data?.connections ?? [])
      .filter((connection) => connection.transport === "connector" && connection.status !== "archived")
      .map((connection) => `${connection.config?.connectorId ?? connection.transportConfig?.connectorId}:${connection.config?.upstream ?? connection.transportConfig?.upstream}`),
  );
  const invalidate = () => qc.invalidateQueries({ queryKey: queryKeys.tools.mcpConnectors(companyId) });

  const create = useMutation({
    mutationFn: () => mcpConnectorsApi.create(companyId, { name: draftName.trim() }),
    onSuccess: (result) => {
      setEnrollment(result);
      setDraftName("");
      invalidate();
    },
    onError: (error) => pushToast({ title: "Could not create connector", body: errorMessage(error), tone: "error" }),
  });
  const reenroll = useMutation({
    mutationFn: (connectorId: string) => mcpConnectorsApi.reenroll(companyId, connectorId),
    onSuccess: (result) => {
      setEnrollment(result);
      invalidate();
    },
    onError: (error) => pushToast({ title: "Could not re-enroll connector", body: errorMessage(error), tone: "error" }),
  });
  const revoke = useMutation({
    mutationFn: (connectorId: string) => mcpConnectorsApi.revoke(companyId, connectorId),
    onSuccess: () => {
      setRevoking(null);
      invalidate();
      pushToast({ title: "Connector revoked", tone: "success" });
    },
    onError: (error) => pushToast({ title: "Could not revoke connector", body: errorMessage(error), tone: "error" }),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (draftName.trim()) create.mutate();
  };

  return (
    <div className="space-y-4">
      <ToolsPageHeader
        title="Connectors"
        description="A connector runs inside your private network, dials out to Paperclip and relays governed MCP calls to the servers named in its own config. No inbound port is opened and Paperclip never learns the upstream addresses."
      />

      {enrollment ? <EnrollmentTokenPanel enrollment={enrollment} onDone={() => setEnrollment(null)} /> : null}

      <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1 space-y-1.5">
          <Label htmlFor="connector-name">New connector</Label>
          <Input
            id="connector-name"
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            placeholder="e.g. Homelab cluster"
          />
        </div>
        <Button type="submit" disabled={!draftName.trim() || create.isPending}>
          <Plus className="h-4 w-4" />
          Create connector
        </Button>
      </form>

      {connectors.isLoading ? (
        <LoadingState label="Loading connectors…" />
      ) : connectors.error ? (
        <ErrorState error={connectors.error} onRetry={() => connectors.refetch()} />
      ) : (connectors.data?.connectors ?? []).length === 0 ? (
        <div className="flex items-center gap-2 rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
          <Cable className="h-4 w-4" />
          No connectors yet. Create one to reach MCP servers on a private network.
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {connectors.data!.connectors.map((connector) => {
            const status = connectorStatus(connector);
            return (
              <li key={connector.id} className="flex flex-wrap items-start justify-between gap-3 p-4">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{connector.name}</span>
                    <HealthBadge status={status.status} label={status.label} />
                    {connector.version ? (
                      <span className="font-mono text-xs text-muted-foreground">v{connector.version}</span>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Upstreams:{" "}
                    {connector.upstreams.length ? (
                      <span className="font-mono">{connector.upstreams.join(", ")}</span>
                    ) : (
                      "none reported yet"
                    )}
                    {" · "}Last seen <RelativeTime value={connector.lastSeenAt} />
                  </p>
                  {connector.upstreams.length > 0 ? (
                    <ul className="space-y-1 pt-2" aria-label={`MCP servers from ${connector.name}`}>
                      {connector.upstreams.map((upstream) => {
                        const isImported = imported.has(`${connector.id}:${upstream}`);
                        return (
                          <li key={upstream} className="flex items-center gap-2 text-sm">
                            <span className="font-mono text-foreground">{upstream}</span>
                            {isImported ? <span className="text-muted-foreground">Already imported</span> : (
                              <Button type="button" size="sm" variant="outline"
                                disabled={!connector.online || connections.isLoading || connections.isError}
                                onClick={() => setAddFor({ connector, upstream })}>
                                Import {upstream}
                              </Button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                </div>
                {connector.status !== "revoked" ? (
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={!connector.online || connector.upstreams.length === 0 || connections.isLoading || connections.isError}
                      onClick={() => setAddFor({ connector })}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Add connection
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={reenroll.isPending}
                      onClick={() => reenroll.mutate(connector.id)}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      Re-enroll
                    </Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => setRevoking(connector)}>
                      <ShieldOff className="h-3.5 w-3.5" />
                      Revoke
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {addFor ? <AddConnectorConnectionDialog companyId={companyId} connector={addFor.connector} initialUpstream={addFor.upstream} onClose={() => setAddFor(null)} /> : null}
      {revoking ? (
        <RevokeConnectorDialog
          connector={revoking}
          pending={revoke.isPending}
          onConfirm={() => revoke.mutate(revoking.id)}
          onClose={() => setRevoking(null)}
        />
      ) : null}
    </div>
  );
}
