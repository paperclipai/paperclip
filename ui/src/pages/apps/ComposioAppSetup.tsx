import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import type { ComposioAppSetupInput, ComposioAppSetupResult, ToolConnection } from "@paperclipai/shared";
import { toolsApi } from "@/api/tools";
import { useAccountIdentity } from "@/api/companies-query";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useToast } from "@/context/ToastContext";

/** Provider authorization is performed by the backend; no task or agent run. */
export function ComposioAppSetup({ name, toolkit, connections, onClose, onBack, onConnectNew }: {
  name: string; toolkit: string; connections: ToolConnection[]; onClose: () => void;
  onBack?: () => void; onConnectNew: () => void;
}) {
  const queries = useQueryClient();
  const { userId, settled } = useAccountIdentity();
  const { pushToast } = useToast();
  const [selectedConnectionId, setConnectionId] = useState<string | null>(null);
  const connectionId = selectedConnectionId ?? connections[0]?.id ?? "__new__";
  const [result, setResult] = useState<ComposioAppSetupResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connection = connections.find(candidate => candidate.id === connectionId);

  async function submit(input: ComposioAppSetupInput) {
    if (busy || !connection || !settled) return;
    setConnectionId(connection.id);
    setBusy(true);
    setError(null);
    try {
      const next = await toolsApi.setupComposioApp(connection.id, toolkit, input);
      setResult(next);
      await queries.invalidateQueries({ queryKey: queryKeys.tools.composioApps(connection.id), exact: true });
      await queries.invalidateQueries({ queryKey: queryKeys.tools.aggregatorApps(connection.id, userId), exact: true });
      if (next.status === "connected") {
        pushToast({ title: `${name} is connected through Composio.`, tone: "success" });
        onClose();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn’t configure this app. Try again.");
    } finally { setBusy(false); }
  }

  return <div className="space-y-4">
    <div className="space-y-2">
      <Label htmlFor="composio-app-account">Composio account</Label>
      <select id="composio-app-account" value={connectionId} disabled={busy} onChange={event => {
        setConnectionId(event.target.value); setResult(null); setError(null);
      }} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {connections.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
        <option value="__new__">Connect a new account…</option>
      </select>
    </div>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    {result ? <p role="status" className="text-sm text-muted-foreground">Finish connecting {name} in Composio, then return here.</p> : null}
    {result?.authorizationUrl ? <Button asChild variant="outline" className="w-full">
      <a href={result.authorizationUrl} target="_blank" rel="noopener noreferrer">Connect {name} in Composio<ExternalLink className="size-4" /></a>
    </Button> : null}
    <div className="flex items-center justify-between gap-2">
      <Button variant="ghost" disabled={busy} onClick={onBack ?? onClose}>{onBack ? "Back" : "Cancel"}</Button>
      <div className="flex items-center gap-2">
      {result && result.status !== "connected" ? <Button variant="ghost" disabled={busy} onClick={() => void submit({ action: "start" })}>Get a new link</Button> : null}
      <Button disabled={!settled || busy || (!connection && connectionId !== "__new__")} onClick={() => {
        if (connectionId === "__new__") onConnectNew();
        else void submit(result ? { action: "complete" } : { action: "start" });
      }}>
        {busy ? "Checking…" : connectionId === "__new__" ? "Connect new account" : result ? "I’ve connected it" : "Continue"}
      </Button>
      </div>
    </div>
  </div>;
}
