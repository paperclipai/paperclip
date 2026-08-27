import { useEffect, useState } from "react";
import { CheckCircle2, Clock, Loader2, Plug, XCircle } from "lucide-react";
import type {
  ConnectionIntentInteraction,
  ConnectionIntentSetupOptions,
} from "@paperclipai/shared";
import { connectionIntentsApi } from "@/api/connection-intents";
import { Link } from "@/lib/router";
import { AppLogo } from "@/pages/apps/AppLogo";
import { Button } from "./ui/button";

export interface ConnectionIntentInteractionBodyProps {
  interaction: ConnectionIntentInteraction;
  currentUserId?: string | null;
  addresseeLabel: string;
}

export function ConnectionIntentInteractionBody({
  interaction,
  currentUserId,
  addresseeLabel,
}: ConnectionIntentInteractionBodyProps) {
  const [current, setCurrent] = useState(interaction);
  const [options, setOptions] = useState<ConnectionIntentSetupOptions | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setCurrent(interaction), [interaction]);

  const isAddressee = Boolean(currentUserId && current.addresseeUserId === currentUserId);
  const connectHref = `/apps/connect?${new URLSearchParams({
    source: current.payload.serviceSlug,
    intent: current.id,
  }).toString()}`;

  async function loadOptions() {
    setExpanded(true);
    setPendingAction("load");
    setError(null);
    try {
      setOptions(await connectionIntentsApi.setupOptions(current.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn’t load connection options.");
    } finally {
      setPendingAction(null);
    }
  }

  async function complete(connectionId: string) {
    setPendingAction(connectionId);
    setError(null);
    try {
      setCurrent(await connectionIntentsApi.complete(current.id, connectionId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn’t use this connection.");
    } finally {
      setPendingAction(null);
    }
  }

  async function decline() {
    setPendingAction("decline");
    setError(null);
    try {
      setCurrent(await connectionIntentsApi.decline(current.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn’t decline this request.");
    } finally {
      setPendingAction(null);
    }
  }

  if (current.status === "accepted" || current.status === "rejected" || current.status === "expired") {
    const connected = current.status === "accepted";
    const StatusIcon = connected ? CheckCircle2 : XCircle;
    const title = connected
      ? `${current.payload.serviceName} connected`
      : current.status === "rejected"
        ? "Connection declined"
        : "Connection request expired";
    return (
      <div className="flex items-start gap-3" data-testid="connection-intent-terminal">
        <StatusIcon className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
        <div>
          <p className="font-medium text-foreground">{title}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {connected
              ? `${current.payload.requestingAgentName} can use this connection on its continuation run.`
              : `${current.payload.requestingAgentName} can continue without this connection.`}
          </p>
        </div>
      </div>
    );
  }

  if (!isAddressee) {
    return (
      <div className="flex items-start gap-3" data-testid="connection-intent-waiting">
        <Clock className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
        <div>
          <p className="font-medium text-foreground">Waiting for {addresseeLabel}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Only the addressed person can choose or create a connection.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div data-testid="connection-intent-actions">
      <div className="flex items-start gap-3">
        <AppLogo
          name={current.payload.serviceName}
          brandKey={current.payload.serviceSlug}
          logoUrl={current.payload.serviceLogoUrl}
          size={40}
        />
        <div>
          <p className="font-medium text-foreground">
            {current.payload.requestingAgentName} needs {current.payload.serviceName}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Reuse an eligible connection or connect a new identity for this agent.
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="button" onClick={() => void loadOptions()} disabled={pendingAction !== null}>
          {pendingAction === "load" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
          Connect / Use existing
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => void decline()}
          disabled={pendingAction !== null}
        >
          Not now
        </Button>
      </div>

      {expanded && pendingAction === "load" ? (
        <p className="mt-3 text-sm text-muted-foreground">Loading connection options…</p>
      ) : null}
      {expanded && options ? (
        <div className="mt-3 space-y-2 rounded-md border border-border bg-muted/30 p-3">
          {options.existingConnections.map((connection) => (
            <Button
              key={connection.id}
              type="button"
              variant="outline"
              className="w-full justify-start"
              onClick={() => void complete(connection.id)}
              disabled={pendingAction !== null}
            >
              {pendingAction === connection.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
              Use {connection.name}
            </Button>
          ))}
          <Button asChild type="button" variant="outline" className="w-full justify-start">
            <Link to={connectHref}>Connect a new {current.payload.serviceName} identity</Link>
          </Button>
          <p className="text-xs text-muted-foreground">
            After connecting a new identity, return to this card to grant it to the requesting agent.
          </p>
        </div>
      ) : null}
      {error ? <p className="mt-3 text-sm text-destructive" role="alert">{error}</p> : null}
    </div>
  );
}
