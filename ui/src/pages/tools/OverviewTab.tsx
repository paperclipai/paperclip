import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Activity, AlertTriangle, AppWindow, Plug, Server, ShieldAlert } from "lucide-react";
import { Link } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { toolsApi } from "@/api/tools";
import { Card, CardContent } from "@/components/ui/card";
import { MetricCard } from "@/components/MetricCard";
import { EnforcementBanner } from "@/components/EnforcementBanner";
import { ErrorState, LoadingState, RelativeTime, DecisionBadge, HealthBadge } from "./shared";

const DENY_ACTIONS = new Set(["tool_gateway.call_denied", "tool_gateway.call_failed"]);

function formatLatency(value: number | null | undefined) {
  if (typeof value !== "number") return "—";
  return `${value}ms`;
}

/** Label / mono-value row for the runtime-health side panel. */
function PropertyRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-mono text-sm text-foreground">{value}</span>
    </div>
  );
}

export function OverviewTab({ companyId }: { companyId: string }) {
  const apps = useQuery({
    queryKey: queryKeys.tools.applications(companyId),
    queryFn: () => toolsApi.listApplications(companyId),
  });
  const connections = useQuery({
    queryKey: queryKeys.tools.connections(companyId),
    queryFn: () => toolsApi.listConnections(companyId),
  });
  const slots = useQuery({
    queryKey: queryKeys.tools.runtimeSlots(companyId),
    queryFn: () => toolsApi.listRuntimeSlots(companyId),
  });
  const runtimeHealth = useQuery({
    queryKey: queryKeys.tools.runtimeHealth(companyId),
    queryFn: () => toolsApi.getRuntimeHealth(companyId),
  });
  const trustRules = useQuery({
    queryKey: queryKeys.tools.trustRules(companyId),
    queryFn: () => toolsApi.listTrustRules(companyId),
  });
  const audit = useQuery({
    queryKey: queryKeys.tools.audit(companyId, 100),
    queryFn: () => toolsApi.listAudit(companyId, 100),
  });

  const anyError = apps.error || connections.error || slots.error || runtimeHealth.error || audit.error || trustRules.error;
  if (anyError) {
    return (
      <ErrorState
        error={anyError}
        onRetry={() => {
          apps.refetch();
          connections.refetch();
          slots.refetch();
          runtimeHealth.refetch();
          trustRules.refetch();
          audit.refetch();
        }}
      />
    );
  }
  if (apps.isLoading || connections.isLoading || slots.isLoading || runtimeHealth.isLoading || audit.isLoading) {
    return <LoadingState />;
  }

  const appList = apps.data?.applications ?? [];
  const connList = connections.data?.connections ?? [];
  const slotList = slots.data?.runtimeSlots ?? [];

  const mcpApps = appList.filter((a) => a.type === "mcp_http" || a.type === "mcp_stdio").length;
  const pluginApps = appList.filter((a) => a.type === "paperclip_plugin").length;
  const activeConnections = connList.filter(
    (c) => c.enabled && (c.status ?? "active") !== "archived",
  ).length;
  const runningSlots = slotList.filter((s) => s.status === "running" || s.status === "idle").length;

  const allDenials = (audit.data ?? []).filter((row) => DENY_ACTIONS.has(row.action));
  const dayCutoff = Date.now() - 24 * 60 * 60 * 1000;
  const denials24h = allDenials.filter((row) => {
    const ts = new Date(row.createdAt).getTime();
    return !Number.isFinite(ts) || ts >= dayCutoff;
  });
  const deniedCount = denials24h.filter((row) => row.action.endsWith("denied")).length;
  const failedCount = denials24h.length - deniedCount;

  const recentDenials = allDenials.slice(0, 6);
  const health = runtimeHealth.data;
  const metrics = health?.metrics;
  const firingAlerts = health?.alerts ?? [];
  const healthStatusKey =
    health?.status === "critical" ? "error" : health?.status === "degraded" ? "degraded" : "ok";

  return (
    <div className="space-y-5">
      <EnforcementBanner companyId={companyId} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="overflow-hidden py-0">
          <MetricCard
            icon={AppWindow}
            label="Applications"
            value={appList.length}
            description={`${mcpApps} MCP · ${pluginApps} plugin`}
            to="/tools/applications"
          />
        </Card>
        <Card className="overflow-hidden py-0">
          <MetricCard
            icon={Plug}
            label="Active connections"
            value={activeConnections}
            description={`${activeConnections} of ${connList.length} enabled`}
            to="/tools/applications"
          />
        </Card>
        <Card className="overflow-hidden py-0">
          <MetricCard
            icon={Server}
            label="Runtime slots"
            value={slotList.length}
            description={`${runningSlots} running`}
            to="/tools/runtime"
          />
        </Card>
        <Card className="overflow-hidden py-0">
          <MetricCard
            icon={ShieldAlert}
            label="Denials (24h)"
            value={denials24h.length}
            description={`${deniedCount} denied · ${failedCount} failed`}
            to="/tools/audit"
          />
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.6fr_1fr]">
        <Card>
          <CardContent className="py-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
              <ShieldAlert className="h-4 w-4 text-destructive" />
              Recent denials &amp; failures
              <Link
                to="/tools/audit"
                className="ml-auto text-xs font-medium text-primary hover:underline"
              >
                View full audit →
              </Link>
            </div>
            {recentDenials.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">
                No denied or failed tool calls in the last {audit.data?.length ?? 0} audit events.
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Tool</th>
                    <th className="py-2 pr-3 font-medium">Actor</th>
                    <th className="py-2 pr-3 font-medium">Reason</th>
                    <th className="py-2 pr-3 font-medium">Outcome</th>
                    <th className="py-2 pl-3 text-right font-medium">When</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {recentDenials.map((row) => {
                    const tool =
                      (row.details?.tool as string | undefined) ??
                      (row.details?.toolName as string | undefined) ??
                      "—";
                    const runId = row.details?.runId as string | undefined;
                    return (
                      <tr key={row.id} className="align-top">
                        <td className="py-2 pr-3 font-mono text-xs text-foreground">{tool}</td>
                        <td className="py-2 pr-3 text-xs text-muted-foreground">
                          {row.actorType ?? "—"}
                          {runId ? <span className="block font-mono text-[11px]">run {runId.slice(0, 8)}</span> : null}
                        </td>
                        <td className="py-2 pr-3 text-xs text-muted-foreground">
                          {(row.details?.reasonCode as string | undefined) ?? row.action}
                        </td>
                        <td className="py-2 pr-3">
                          <DecisionBadge decision={row.action.endsWith("denied") ? "deny" : "block"} />
                        </td>
                        <td className="py-2 pl-3 text-right text-xs">
                          <RelativeTime value={row.createdAt} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

        <Card className={health?.status === "critical" ? "border-destructive/40" : undefined}>
          <CardContent className="py-4">
            <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
              <Activity className="h-4 w-4 text-muted-foreground" />
              Runtime health
              <HealthBadge status={healthStatusKey} label={health?.status ?? "unknown"} />
              <Link
                to="/tools/runtime"
                className="ml-auto text-xs font-medium text-primary hover:underline"
              >
                View runtime →
              </Link>
            </div>
            <div className="mt-3 divide-y divide-border">
              <PropertyRow label="Active slots" value={metrics?.activeSlots ?? 0} />
              <PropertyRow label="P95 latency" value={formatLatency(metrics?.p95ToolLatencyMsLastHour)} />
              <PropertyRow label="Timeout rate" value={`${metrics?.timeoutRateLastHour ?? 0}%`} />
              <PropertyRow label="Capacity deferrals" value={metrics?.capacityDeferralsLastHour ?? 0} />
            </div>
            {firingAlerts.length > 0 ? (
              <ul className="mt-3 divide-y divide-border border-t border-border">
                {firingAlerts.slice(0, 4).map((alert) => (
                  <li key={alert.name} className="flex items-start gap-2 py-2 text-sm">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                    <div className="min-w-0">
                      <div className="font-mono text-xs text-foreground">{alert.name}</div>
                      <div className="text-xs text-muted-foreground">{alert.observed}</div>
                    </div>
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">{alert.severity}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 border-t border-border pt-3 text-sm text-muted-foreground">
                No active runtime alerts.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
