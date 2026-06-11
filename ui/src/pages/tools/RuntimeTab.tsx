import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Layers, Loader2, RotateCw, Server, Square, Timer } from "lucide-react";
import type { ToolRuntimeSlot } from "@paperclipai/shared";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { MetricCard } from "@/components/MetricCard";
import { EnforcementBanner } from "@/components/EnforcementBanner";
import { queryKeys } from "@/lib/queryKeys";
import { toolsApi } from "@/api/tools";
import { ApiError } from "@/api/client";
import { useToast } from "@/context/ToastContext";
import { EmptyState } from "@/components/EmptyState";
import { ToolsPageHeader, LoadingState, ErrorState, HealthBadge, RelativeTime } from "./shared";

function formatLatency(value: number | null | undefined) {
  if (typeof value !== "number") return "—";
  return `${value}ms`;
}

/**
 * Trust tier is not yet a first-class field on the runtime slot (tracked for a
 * follow-up). Until the server returns it, we derive a best-effort tier from the
 * runtime kind + health so the PAP-10400 trust-tier column is present and honest:
 * a local-stdio slot in an error/failed state reads as `quarantined`.
 */
function trustTier(slot: ToolRuntimeSlot): { label: string; quarantined: boolean } {
  if (slot.runtimeKind === "local_stdio") {
    const quarantined =
      slot.status === "failed" ||
      slot.status === "error" ||
      slot.healthStatus === "error" ||
      slot.healthStatus === "unhealthy";
    return { label: `local-stdio · ${quarantined ? "quarantined" : "trusted"}`, quarantined };
  }
  return { label: "remote-http", quarantined: false };
}

export function RuntimeTab({ companyId }: { companyId: string }) {
  const qc = useQueryClient();
  const { pushToast } = useToast();
  const slots = useQuery({
    queryKey: queryKeys.tools.runtimeSlots(companyId),
    queryFn: () => toolsApi.listRuntimeSlots(companyId),
    refetchInterval: 15_000,
  });
  const health = useQuery({
    queryKey: queryKeys.tools.runtimeHealth(companyId),
    queryFn: () => toolsApi.getRuntimeHealth(companyId),
    refetchInterval: 15_000,
  });

  const invalidateRuntime = () => {
    qc.invalidateQueries({ queryKey: queryKeys.tools.runtimeSlots(companyId) });
    qc.invalidateQueries({ queryKey: queryKeys.tools.runtimeHealth(companyId) });
  };

  const stopSlot = useMutation({
    mutationFn: (slotId: string) => toolsApi.stopRuntimeSlot(companyId, slotId),
    onSuccess: (slot) => {
      invalidateRuntime();
      pushToast({
        title: "Runtime slot stopped",
        body: slot.commandTemplateKey ?? slot.providerRef ?? slot.id,
        tone: "success",
      });
    },
    onError: (err) =>
      pushToast({
        title: "Stop failed",
        body: err instanceof ApiError ? err.message : String(err),
        tone: "error",
      }),
  });

  const restartSlot = useMutation({
    mutationFn: (slotId: string) => toolsApi.restartRuntimeSlot(companyId, slotId),
    onSuccess: (slot) => {
      invalidateRuntime();
      pushToast({
        title: "Runtime slot restarted",
        body: slot.commandTemplateKey ?? slot.providerRef ?? slot.id,
        tone: "success",
      });
    },
    onError: (err) =>
      pushToast({
        title: "Restart failed",
        body: err instanceof ApiError ? err.message : String(err),
        tone: "error",
      }),
  });

  if (slots.isLoading || health.isLoading) return <LoadingState />;
  if (slots.error || health.error) {
    return (
      <ErrorState
        error={slots.error ?? health.error}
        onRetry={() => {
          slots.refetch();
          health.refetch();
        }}
      />
    );
  }

  const list = slots.data?.runtimeSlots ?? [];
  const firingAlerts = health.data?.alerts ?? [];
  const metrics = health.data?.metrics;

  return (
    <div className="space-y-4">
      <ToolsPageHeader
        title="Runtime slots"
        description="Managed lifecycle units for local stdio MCP servers and remote sessions. Slots are pooled and supervised — agents never spawn processes directly. Idle local slots shut down automatically."
      />

      <EnforcementBanner
        tone="warning"
        title="Local stdio is local code execution, not a security sandbox."
        body="A local-stdio slot runs with the orchestrator's privileges on this host. The runtime supervisor pools and isolates lifecycle, but it does not contain a hostile binary — only bind commands you trust, and quarantine anything you would not run yourself."
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="overflow-hidden py-0">
          <MetricCard icon={Server} label="Active slots" value={metrics?.activeSlots ?? 0} />
        </Card>
        <Card className="overflow-hidden py-0">
          <MetricCard icon={Timer} label="P95 latency (1h)" value={formatLatency(metrics?.p95ToolLatencyMsLastHour)} />
        </Card>
        <Card className="overflow-hidden py-0">
          <MetricCard icon={AlertTriangle} label="Timeout rate (1h)" value={`${metrics?.timeoutRateLastHour ?? 0}%`} />
        </Card>
        <Card className="overflow-hidden py-0">
          <MetricCard icon={Layers} label="Capacity deferrals (1h)" value={metrics?.capacityDeferralsLastHour ?? 0} />
        </Card>
      </div>

      {firingAlerts.length > 0 ? (
        <Card className={health.data?.status === "critical" ? "border-destructive/40" : undefined}>
          <CardContent className="space-y-3 py-4">
            <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              Supervisor recommendations
              <HealthBadge
                status={health.data?.status === "critical" ? "error" : health.data?.status === "degraded" ? "degraded" : "ok"}
                label={health.data?.status ?? "unknown"}
              />
              <span className="ml-auto text-xs text-muted-foreground">{health.data?.runbookPath}</span>
            </div>
            <ul className="divide-y divide-border">
              {firingAlerts.map((alert) => (
                <li key={alert.name} className="py-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-foreground">{alert.name}</span>
                    <Badge variant={alert.severity === "critical" ? "destructive" : "secondary"}>
                      {alert.severity}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{alert.observed}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{alert.firstResponderAction}</p>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {list.length === 0 ? (
        <EmptyState
          icon={Server}
          message="No runtime slots"
          description="Local stdio connections lazy-start a runtime slot when a policy-allowed run first needs them. Remote HTTP connections do not use a local process."
        />
      ) : (
        <Card>
          <CardContent className="px-0 py-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2.5 font-medium">Slot</th>
                  <th className="px-3 py-2.5 font-medium">Kind</th>
                  <th className="px-3 py-2.5 font-medium">Trust tier</th>
                  <th className="px-3 py-2.5 font-medium">Status</th>
                  <th className="px-3 py-2.5 font-medium">Health</th>
                  <th className="px-3 py-2.5 font-medium">Last used</th>
                  <th className="px-4 py-2.5 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {list.map((slot) => {
                  const supportsControl = slot.runtimeKind === "local_stdio";
                  const controlsPending = stopSlot.isPending || restartSlot.isPending;
                  const stopPending = stopSlot.isPending && stopSlot.variables === slot.id;
                  const restartPending = restartSlot.isPending && restartSlot.variables === slot.id;
                  const stopDisabled = !supportsControl || controlsPending || slot.status === "stopped";
                  const restartDisabled = !supportsControl || controlsPending;
                  const tier = trustTier(slot);
                  return (
                    <tr key={slot.id} className="align-top">
                      <td className="px-4 py-3">
                        <div className="font-mono text-sm text-foreground">
                          {slot.commandTemplateKey ?? slot.providerRef ?? slot.id.slice(0, 8)}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          scope {slot.ownerScopeType}
                          {slot.processId ? ` · pid ${slot.processId}` : ""}
                          {slot.lastError ? <span className="text-destructive"> · {slot.lastError}</span> : null}
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <Badge variant="outline">{slot.runtimeKind}</Badge>
                      </td>
                      <td className="px-3 py-3">
                        <Badge variant={tier.quarantined ? "destructive" : "outline"}>{tier.label}</Badge>
                      </td>
                      <td className="px-3 py-3">
                        <Badge variant="secondary">{slot.status}</Badge>
                      </td>
                      <td className="px-3 py-3">
                        <HealthBadge status={slot.healthStatus} />
                      </td>
                      <td className="px-3 py-3 text-xs">
                        <RelativeTime value={slot.lastUsedAt} />
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-1.5">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={stopDisabled}
                                  aria-label="Stop runtime slot"
                                  onClick={() => stopSlot.mutate(slot.id)}
                                >
                                  {stopPending ? (
                                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                                  ) : (
                                    <Square className="mr-1 h-3.5 w-3.5" fill="currentColor" />
                                  )}
                                  Stop
                                </Button>
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>
                              {!supportsControl
                                ? "Remote sessions have no local process to stop."
                                : slot.status === "stopped"
                                  ? "This runtime slot is already stopped."
                                  : "Stop this local stdio runtime slot."}
                            </TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={restartDisabled}
                                  aria-label="Restart runtime slot"
                                  onClick={() => restartSlot.mutate(slot.id)}
                                >
                                  {restartPending ? (
                                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                                  ) : (
                                    <RotateCw className="mr-1 h-3.5 w-3.5" />
                                  )}
                                  Restart
                                </Button>
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>
                              {supportsControl
                                ? "Restart this local stdio runtime slot."
                                : "Remote sessions have no local process to restart."}
                            </TooltipContent>
                          </Tooltip>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
      <p className="text-xs text-muted-foreground">
        Health and lifecycle shown here reflect server state. Stop and restart controls apply only to local
        stdio runtime slots. Trust tier is derived client-side until the supervisor returns it as a first-class
        field.
      </p>
    </div>
  );
}
