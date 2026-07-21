import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw, ShieldCheck, Trash2, User, Building2 } from "lucide-react";
import type { ConnectionGrant } from "@paperclipai/shared";

import { toolsApi } from "@/api/tools";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useToast } from "@/context/ToastContext";

function grantStatusColor(status: ConnectionGrant["status"]): string {
  if (status === "active") return "text-emerald-600 dark:text-emerald-400";
  if (status === "needs_reauthorization") return "text-amber-600 dark:text-amber-400";
  return "text-muted-foreground";
}

function grantStatusLabel(status: ConnectionGrant["status"]): string {
  if (status === "active") return "Active";
  if (status === "needs_reauthorization") return "Needs re-auth";
  if (status === "revoked") return "Revoked";
  if (status === "expired") return "Expired";
  return status;
}

function GrantRow({
  grant,
  onRevoke,
  revoking,
}: {
  grant: ConnectionGrant;
  onRevoke: (id: string) => void;
  revoking: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const isWorkspace = grant.kind === "workspace";
  const label = grant.providerTenant?.name
    ? grant.providerTenant.name
    : isWorkspace
      ? "Workspace installation"
      : grant.subjectUserId
        ? `User ${grant.subjectUserId.slice(0, 8)}…`
        : "User grant";

  const lastUsed = grant.lastUsedAt
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(grant.lastUsedAt))
    : "Never";

  return (
    <div className="flex items-center gap-3 border-b border-border/50 py-3 last:border-0">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
        {isWorkspace ? <Building2 className="h-3.5 w-3.5" /> : <User className="h-3.5 w-3.5" />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{label}</p>
        <p className="text-xs text-muted-foreground">
          <span className={cn("font-medium", grantStatusColor(grant.status))}>
            {grantStatusLabel(grant.status)}
          </span>
          {" · "}Last used {lastUsed}
        </p>
      </div>
      {grant.status !== "revoked" && (
        <div className="flex shrink-0 items-center gap-1.5">
          {confirming ? (
            <>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={revoking}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  onRevoke(grant.id);
                  setConfirming(false);
                }}
                disabled={revoking}
              >
                {revoking && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                Revoke
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-destructive"
              onClick={() => setConfirming(true)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export function GrantsPanel({ connectionId }: { connectionId: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const grantsQuery = useQuery({
    queryKey: queryKeys.tools.connectionGrants(connectionId),
    queryFn: () => toolsApi.listConnectionGrants(connectionId),
  });

  const revokeMutation = useMutation({
    mutationFn: (grantId: string) => toolsApi.revokeConnectionGrant(connectionId, grantId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.tools.connectionGrants(connectionId) });
      pushToast({ title: "Grant revoked", tone: "success" });
    },
    onError: () => {
      pushToast({ title: "Failed to revoke grant", tone: "error" });
    },
  });

  const grants = grantsQuery.data ?? [];
  const activeGrants = grants.filter((g) => g.status !== "revoked");
  const revokedGrants = grants.filter((g) => g.status === "revoked");

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <ShieldCheck className="h-4 w-4 text-muted-foreground" />
            Active grants
            {activeGrants.length > 0 && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                {activeGrants.length}
              </span>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => grantsQuery.refetch()}
            disabled={grantsQuery.isFetching}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", grantsQuery.isFetching && "animate-spin")} />
          </Button>
        </div>
        <div className="px-5">
          {grantsQuery.isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : activeGrants.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No active grants — credentials are issued on first use.
            </p>
          ) : (
            activeGrants.map((grant) => (
              <GrantRow
                key={grant.id}
                grant={grant}
                onRevoke={(id) => revokeMutation.mutate(id)}
                revoking={revokeMutation.isPending && revokeMutation.variables === grant.id}
              />
            ))
          )}
        </div>
      </section>

      {revokedGrants.length > 0 && (
        <section className="rounded-xl border border-border bg-card opacity-60">
          <div className="border-b border-border px-5 py-3 text-sm font-semibold text-muted-foreground">
            Revoked / expired
          </div>
          <div className="px-5">
            {revokedGrants.map((grant) => (
              <GrantRow
                key={grant.id}
                grant={grant}
                onRevoke={(id) => revokeMutation.mutate(id)}
                revoking={false}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
