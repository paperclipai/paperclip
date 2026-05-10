import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { ConnectionSummary } from "./api";
import { connectionsStrings as t } from "./strings";

interface Props {
  connection: ConnectionSummary | null;
  role: "admin" | "member";
  onRefresh: () => void;
  onDisconnect: () => void;
  onClose: () => void;
  busy?: boolean;
}

function formatDateTime(value: string | null): string {
  if (!value) return "never";
  try {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString();
  } catch {
    return value;
  }
}

function statusVariant(status: ConnectionSummary["status"]) {
  switch (status) {
    case "active":
      return "secondary" as const;
    case "expired":
      return "outline" as const;
    case "error":
      return "outline" as const;
    case "revoked":
      return "destructive" as const;
    default:
      return "outline" as const;
  }
}

export function ConnectionDrawer({
  connection,
  role,
  onRefresh,
  onDisconnect,
  onClose,
  busy = false,
}: Props) {
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const isAdmin = role === "admin";
  const open = connection !== null;

  // Reset confirmation state whenever the drawer changes targets — including
  // switching directly between two connections without closing the drawer.
  // Without this, an admin who clicks Disconnect on connection A and then
  // navigates to connection B without dismissing would see the "Confirm"
  // button and could inadvertently disconnect B.
  useEffect(() => {
    setConfirmDisconnect(false);
  }, [connection?.id]);

  if (!connection) return null;

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        className="w-full sm:max-w-md"
        side="right"
        data-testid="connection-drawer"
      >
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2 text-base">
            <span className="capitalize">{connection.providerId}</span>
            <Badge variant={statusVariant(connection.status)} className="capitalize">
              {connection.status}
            </Badge>
          </SheetTitle>
          <SheetDescription>
            {connection.accountLabel ?? connection.accountId ?? "OAuth connection details"}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-4 overflow-y-auto px-4">
          <DetailRow label="Account">
            {connection.accountLabel ?? connection.accountId ?? "—"}
          </DetailRow>
          <DetailRow label="Account ID">
            <code className="font-mono text-xs">{connection.accountId ?? "—"}</code>
          </DetailRow>
          <DetailRow label="Scopes">
            {connection.scopes.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {connection.scopes.map((scope) => (
                  <Badge key={scope} variant="outline" className="font-mono text-[11px]">
                    {scope}
                  </Badge>
                ))}
              </div>
            ) : (
              <span className="text-muted-foreground">(none)</span>
            )}
          </DetailRow>
          <DetailRow label="Access token expires">
            {formatDateTime(connection.accessTokenExpiresAt)}
          </DetailRow>
          <DetailRow label="Last refreshed">
            {formatDateTime(connection.lastRefreshedAt)}
          </DetailRow>
          <DetailRow label="Refresh attempts">
            {connection.refreshAttemptCount}
          </DetailRow>
          {connection.lastError ? (
            <>
              <Separator />
              <div className="space-y-1 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2">
                <div className="flex items-center gap-2 text-xs font-medium text-destructive">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  Last error
                </div>
                <code className="block text-xs text-destructive">{connection.lastError}</code>
                {connection.lastErrorAt ? (
                  <div className="text-xs text-muted-foreground">
                    {formatDateTime(connection.lastErrorAt)}
                  </div>
                ) : null}
              </div>
            </>
          ) : null}
        </div>

        {isAdmin ? (
          <SheetFooter className="border-t border-border">
            {confirmDisconnect ? (
              <div className="space-y-2">
                <p className="text-sm text-destructive">
                  Disconnecting will break agents currently bound to this connection.
                </p>
                <div className="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setConfirmDisconnect(false)}
                    disabled={busy}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={onDisconnect}
                    disabled={busy}
                  >
                    Confirm
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onRefresh}
                  disabled={busy}
                >
                  {t.refreshNow}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setConfirmDisconnect(true)}
                  disabled={busy}
                >
                  {t.disconnect}
                </Button>
              </div>
            )}
          </SheetFooter>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="text-sm">{children}</div>
    </div>
  );
}
