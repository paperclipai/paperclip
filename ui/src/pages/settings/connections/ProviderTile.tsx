import { CheckCircle2, RefreshCw, XCircle, Plug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/timeAgo";
import type { ConnectionSummary, ProviderSummary } from "./api";
import { connectionsStrings as t } from "./strings";

interface Props {
  provider: ProviderSummary;
  connection: ConnectionSummary | null;
  role: "admin" | "member";
  onConnect: () => void;
  onManage: () => void;
}

type TileState = "available" | "connected" | "stalled" | "revoked";

function deriveState(connection: ConnectionSummary | null): TileState {
  if (!connection) return "available";
  if (connection.status === "revoked") return "revoked";
  if (connection.status === "active" && !connection.lastError) return "connected";
  return "stalled";
}

const stateBorder: Record<TileState, string> = {
  available: "border-border",
  connected: "border-emerald-500/40",
  stalled: "border-amber-500/50",
  revoked: "border-destructive/50",
};

export function ProviderTile({ provider, connection, role, onConnect, onManage }: Props) {
  const isMember = role === "member";
  const state = deriveState(connection);

  return (
    <Card
      data-testid={`provider-tile-${provider.id}`}
      className={cn(
        "gap-3 border-2 px-4 py-4 transition-colors hover:border-primary/40",
        stateBorder[state],
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          {provider.iconUrl ? (
            <img src={provider.iconUrl} alt="" className="h-8 w-8 rounded-md" />
          ) : (
            <div className="flex h-8 w-8 items-center justify-center rounded-md border border-border bg-muted/40">
              <Plug className="h-4 w-4 text-muted-foreground" />
            </div>
          )}
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{provider.displayName}</div>
            {connection ? (
              <div className="truncate text-xs text-muted-foreground">
                {connection.accountLabel ?? connection.accountId ?? provider.id}
              </div>
            ) : (
              <div className="truncate text-xs text-muted-foreground">{provider.id}</div>
            )}
          </div>
        </div>
        <StateBadge state={state} />
      </div>

      {connection?.lastRefreshedAt && state === "connected" ? (
        <p className="text-xs text-muted-foreground">
          Refreshed {timeAgo(connection.lastRefreshedAt)}
        </p>
      ) : null}
      {connection?.lastError && state !== "available" ? (
        <p className="text-xs text-destructive truncate" title={connection.lastError}>
          {state === "revoked" ? t.stateRevoked : t.stateRefreshFailed}
        </p>
      ) : null}
      {!connection ? (
        <p className="text-xs text-muted-foreground">
          {provider.scopesDefault.length > 0
            ? `Default scopes: ${provider.scopesDefault.slice(0, 3).join(", ")}${provider.scopesDefault.length > 3 ? "…" : ""}`
            : "No default scopes configured"}
        </p>
      ) : null}

      <div className="flex items-center justify-end pt-1">
        {!connection ? (
          <Button
            size="sm"
            variant={isMember ? "outline" : "default"}
            onClick={onConnect}
            disabled={isMember}
            title={isMember ? t.memberCannotConnect(provider.displayName) : undefined}
          >
            {t.connect}
          </Button>
        ) : state === "revoked" ? (
          // Revoked → start a fresh OAuth flow (the drawer has no
          // initiation path; routing here to onManage would dead-end the
          // user). Members still hit a disabled button per the same
          // RBAC rule the unconnected case applies.
          <Button
            size="sm"
            variant={isMember ? "outline" : "default"}
            onClick={onConnect}
            disabled={isMember}
            title={isMember ? t.memberCannotConnect(provider.displayName) : undefined}
          >
            {t.reconnect}
          </Button>
        ) : (
          <Button size="sm" variant="outline" onClick={onManage}>
            {t.manage}
          </Button>
        )}
      </div>
    </Card>
  );
}

function StateBadge({ state }: { state: TileState }) {
  switch (state) {
    case "connected":
      return (
        <Badge
          variant="outline"
          className="border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
        >
          <CheckCircle2 className="mr-1 h-3 w-3" />
          Connected
        </Badge>
      );
    case "stalled":
      return (
        <Badge
          variant="outline"
          className="border-amber-500/50 bg-amber-500/10 text-amber-600 dark:text-amber-400"
        >
          <RefreshCw className="mr-1 h-3 w-3" />
          Stalled
        </Badge>
      );
    case "revoked":
      return (
        <Badge variant="destructive" className="gap-1">
          <XCircle className="mr-1 h-3 w-3" />
          Revoked
        </Badge>
      );
    case "available":
    default:
      return (
        <Badge variant="outline" className="text-muted-foreground">
          Not connected
        </Badge>
      );
  }
}
