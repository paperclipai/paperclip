/**
 * Fleet Overview page (RAA-292).
 *
 * Displays a grid of all FleetOS containers with status, health gauges,
 * and links to individual container detail views.
 */

import { useEffect } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { fleetosApi, type FleetContainer } from "../api/fleetos";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { StatusBadge } from "../components/StatusBadge";
import { Server, Cpu, HardDrive, MemoryStick, RefreshCw, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";

// ---------------------------------------------------------------------------
// Gauge component — a small radial-style progress bar for CPU / mem / disk
/**
 * Render a compact radial percentage gauge with a label.
 *
 * The displayed percentage is clamped to the range 0–100. The gauge color indicates severity:
 * it is red at or above `danger`, amber at or above `warn`, and green otherwise.
 *
 * @param value - Numeric value (percentage) to display; values outside 0–100 are clamped
 * @param label - Text shown beneath the gauge
 * @param warn - Threshold at or above which the gauge becomes amber (default: 80)
 * @param danger - Threshold at or above which the gauge becomes red (default: 95)
 * @returns A JSX element containing the radial gauge with the rounded percentage centered and the label below
 */

function Gauge({ value, label, warn = 80, danger = 95 }: { value: number; label: string; warn?: number; danger?: number }) {
  const pct = Math.min(100, Math.max(0, value));
  const color =
    pct >= danger
      ? "text-red-500"
      : pct >= warn
        ? "text-amber-500"
        : "text-green-500";

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative h-10 w-10">
        <svg className="h-10 w-10 -rotate-90" viewBox="0 0 36 36">
          <circle
            className="text-muted-foreground/20"
            strokeWidth="3"
            stroke="currentColor"
            fill="none"
            r="15.9155"
            cx="18"
            cy="18"
          />
          <circle
            className={color}
            strokeWidth="3"
            strokeDasharray={`${pct}, 100`}
            strokeLinecap="round"
            stroke="currentColor"
            fill="none"
            r="15.9155"
            cx="18"
            cy="18"
          />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center text-[10px] font-medium">
          {Math.round(pct)}%
        </span>
      </div>
      <span className="text-[10px] text-muted-foreground">{label}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Container card
/**
 * Render a clickable card for a FleetContainer that links to the container's detail page.
 *
 * Displays the agent name (from `labels.agent_name` or `name`), container id, and a status badge.
 * If health data is present, shows CPU/MEM/DISK gauges and uptime; if health is missing, shows either
 * "Health unavailable" for running containers or "Container is {status}" for others. Also shows the tenant ID.
 *
 * @param container - The FleetContainer to render
 * @returns The card element linking to `/fleet/:id` for the provided container
 */

function ContainerCard({ container }: { container: FleetContainer }) {
  const agentName = container.labels?.agent_name ?? container.name;
  const h = container.health;

  return (
    <Link
      to={`/fleet/${encodeURIComponent(container.id)}`}
      className="group block rounded-lg border border-border bg-card p-4 shadow-sm hover:border-foreground/20 hover:shadow-md transition-all no-underline text-inherit"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Server className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="text-sm font-semibold truncate">{agentName}</span>
          </div>
          <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono truncate">{container.id}</span>
          </div>
        </div>
        <StatusBadge status={container.status} />
      </div>

      {h && (
        <div className="mt-4 flex items-center justify-around">
          <Gauge value={h.cpu_percent} label="CPU" />
          <Gauge value={h.mem_percent} label="MEM" />
          <Gauge value={h.disk_percent} label="DISK" />
        </div>
      )}

      {!h && container.status === "running" && (
        <div className="mt-4 flex items-center justify-center py-3">
          <span className="text-xs text-muted-foreground">Health unavailable</span>
        </div>
      )}

      {!h && container.status !== "running" && (
        <div className="mt-4 flex items-center justify-center py-3">
          <span className="text-xs text-muted-foreground">Container is {container.status}</span>
        </div>
      )}

      <div className="mt-3 flex items-center justify-between text-[11px] text-muted-foreground">
        <span>Tenant: {container.tenant_id}</span>
        {h && <span>Up: {h.uptime_display}</span>}
      </div>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Main page
/**
 * Render the Fleet page that lists FleetOS containers, summary metrics, and controls.
 *
 * Handles loading, error, and empty states; polls container data periodically and
 * exposes manual refresh/retry controls. When data is available it splits containers
 * into running and stopped groups, computes average CPU/Memory/Disk from available
 * health data, and renders a grid of container cards with status and metrics.
 *
 * @returns The rendered Fleet overview page as a JSX element
 */

export function FleetOverview() {
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Fleet" }]);
  }, [setBreadcrumbs]);

  const {
    data: containers,
    isLoading,
    error,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: queryKeys.fleet.containers,
    queryFn: () => fleetosApi.listContainers(),
    refetchInterval: 15_000,
  });

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  if (error) {
    return (
      <div className="space-y-4">
        <h1 className="text-lg font-semibold">Fleet</h1>
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4">
          <p className="text-sm text-destructive">
            {error instanceof Error ? error.message : "Failed to load fleet data"}
          </p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  if (!containers || containers.length === 0) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold">Fleet</h1>
          <Button size="sm" asChild>
            <Link to="/fleet/provision" className="no-underline">
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              New Agent
            </Link>
          </Button>
        </div>
        <EmptyState
          icon={Server}
          message="No containers found. Provision your first Hermes agent to get started."
        />
      </div>
    );
  }

  const running = containers.filter((c) => c.status === "running");
  const stopped = containers.filter((c) => c.status !== "running");

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Fleet</h1>
          <p className="text-sm text-muted-foreground">
            {containers.length} container{containers.length === 1 ? "" : "s"} &middot;{" "}
            {running.length} running
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            <RefreshCw className={cn("h-3.5 w-3.5 mr-1.5", isFetching && "animate-spin")} />
            Refresh
          </Button>
          <Button size="sm" asChild>
            <Link to="/fleet/provision" className="no-underline">
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              New Agent
            </Link>
          </Button>
        </div>
      </div>

      {/* Summary gauges */}
      {(() => {
        const withHealth = running.filter((c) => c.health != null);
        const healthCount = withHealth.length;
        return (
          <div className="grid grid-cols-3 gap-4">
            <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-3">
              <Cpu className="h-5 w-5 text-muted-foreground" />
              <div>
                <p className="text-lg font-semibold">
                  {healthCount > 0
                    ? `${Math.round(
                        withHealth.reduce((sum, c) => sum + c.health!.cpu_percent, 0) / healthCount,
                      )}%`
                    : "--"}
                </p>
                <p className="text-xs text-muted-foreground">Avg CPU</p>
              </div>
            </div>
            <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-3">
              <MemoryStick className="h-5 w-5 text-muted-foreground" />
              <div>
                <p className="text-lg font-semibold">
                  {healthCount > 0
                    ? `${Math.round(
                        withHealth.reduce((sum, c) => sum + c.health!.mem_percent, 0) / healthCount,
                      )}%`
                    : "--"}
                </p>
                <p className="text-xs text-muted-foreground">Avg Memory</p>
              </div>
            </div>
            <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-3">
              <HardDrive className="h-5 w-5 text-muted-foreground" />
              <div>
                <p className="text-lg font-semibold">
                  {healthCount > 0
                    ? `${Math.round(
                        withHealth.reduce((sum, c) => sum + c.health!.disk_percent, 0) / healthCount,
                      )}%`
                    : "--"}
                </p>
                <p className="text-xs text-muted-foreground">Avg Disk</p>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Container grid */}
      {running.length > 0 && (
        <div>
          <h2 className="text-xs font-medium uppercase tracking-widest text-muted-foreground/60 mb-3">
            Running ({running.length})
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {running.map((c) => (
              <ContainerCard key={c.id} container={c} />
            ))}
          </div>
        </div>
      )}

      {stopped.length > 0 && (
        <div>
          <h2 className="text-xs font-medium uppercase tracking-widest text-muted-foreground/60 mb-3">
            Stopped / Other ({stopped.length})
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {stopped.map((c) => (
              <ContainerCard key={c.id} container={c} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
