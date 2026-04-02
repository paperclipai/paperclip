/**
 * Fleet Agent Detail page (RAA-292, RAA-293).
 *
 * Shows a single FleetOS container with:
 * - Header: agent name, status, lifecycle action buttons
 * - Health panel: CPU, memory, disk gauges (auto-refresh 10s)
 * - Info panel: tenant, container ID, uptime, IP, image
 * - Confirmation dialogs for stop/restart actions
 */

import { useEffect, useState } from "react";
import { useParams } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fleetosApi, type FleetAction } from "../api/fleetos";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { PageSkeleton } from "../components/PageSkeleton";
import { StatusBadge } from "../components/StatusBadge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Server,
  Play,
  Square,
  RotateCcw,
  Cpu,
  MemoryStick,
  HardDrive,
  Globe,
  Hash,
  Clock,
  Box,
  Users,
  RefreshCw,
  ArrowLeft,
} from "lucide-react";
import { Link } from "@/lib/router";

// ---------------------------------------------------------------------------
// Gauge (same as FleetOverview, extracted for reuse)
/**
 * Renders a circular percentage gauge with a label and color-coded thresholds.
 *
 * The `value` is clamped to the range 0–100 and shown as a rounded percentage in the center;
 * the stroke color switches based on `warn` and `danger` thresholds.
 *
 * @param value - Input percentage (will be clamped to 0–100)
 * @param label - Text to display beneath the gauge
 * @param size - Visual size variant: `"lg"` (default) or `"sm"`
 * @param warn - Percentage at or above which the gauge shows a warning color (default: 80)
 * @param danger - Percentage at or above which the gauge shows a danger color (default: 95)
 * @returns The rendered gauge JSX element containing an SVG circle, the percentage text, and the label
 */

function Gauge({
  value,
  label,
  size = "lg",
  warn = 80,
  danger = 95,
}: {
  value: number;
  label: string;
  size?: "sm" | "lg";
  warn?: number;
  danger?: number;
}) {
  const pct = Math.min(100, Math.max(0, value));
  const color =
    pct >= danger
      ? "text-red-500"
      : pct >= warn
        ? "text-amber-500"
        : "text-green-500";

  const dim = size === "lg" ? "h-20 w-20" : "h-10 w-10";
  const textSize = size === "lg" ? "text-sm font-semibold" : "text-[10px] font-medium";
  const labelSize = size === "lg" ? "text-xs" : "text-[10px]";

  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className={cn("relative", dim)}>
        <svg className={cn(dim, "-rotate-90")} viewBox="0 0 36 36">
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
        <span className={cn("absolute inset-0 flex items-center justify-center", textSize)}>
          {Math.round(pct)}%
        </span>
      </div>
      <span className={cn("text-muted-foreground", labelSize)}>{label}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Info row
/**
 * Render a single info row with an icon, a fixed-width label, and a monospace value.
 *
 * @param icon - Icon component to render at the start of the row
 * @param label - Label text displayed in a fixed-width area to the left of the value
 * @param value - Value to display in monospace; renders `"--"` when `null` or `undefined`
 * @returns The rendered row element containing the icon, label, and value
 */

function InfoRow({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Server;
  label: string;
  value: string | null | undefined;
}) {
  return (
    <div className="flex items-center gap-3 py-2">
      <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
      <span className="text-xs text-muted-foreground w-24 shrink-0">{label}</span>
      <span className="text-sm font-mono truncate">{value ?? "--"}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Confirmation dialog
/**
 * Render a modal dialog that confirms a fleet lifecycle action for a container.
 *
 * @param open - Whether the dialog is visible
 * @param onOpenChange - Callback invoked with the new open state when the dialog is opened or closed
 * @param action - The lifecycle action being confirmed (`"start"`, `"stop"`, or `"restart"`)
 * @param containerName - The container name shown in the dialog description
 * @param onConfirm - Callback invoked when the user confirms the action
 * @param isPending - When `true`, disables controls and shows a processing state
 * @returns The dialog JSX element that prompts the user to confirm the specified action
 */

function ActionConfirmDialog({
  open,
  onOpenChange,
  action,
  containerName,
  onConfirm,
  isPending,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  action: FleetAction;
  containerName: string;
  onConfirm: () => void;
  isPending: boolean;
}) {
  const titles: Record<FleetAction, string> = {
    start: "Start Container",
    stop: "Stop Container",
    restart: "Restart Container",
  };
  const descriptions: Record<FleetAction, string> = {
    start: `Start container "${containerName}"? The agent process will begin running.`,
    stop: `Stop container "${containerName}"? The agent process will be terminated and the container will be shut down.`,
    restart: `Restart container "${containerName}"? The container will stop and start, resetting the agent process.`,
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{titles[action]}</DialogTitle>
          <DialogDescription>{descriptions[action]}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button
            variant={action === "stop" ? "destructive" : "default"}
            onClick={onConfirm}
            disabled={isPending}
          >
            {isPending ? "Processing..." : titles[action]}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Format uptime
/**
 * Format an uptime duration (in seconds) into a compact human-readable string.
 *
 * @param seconds - Uptime duration expressed in seconds
 * @returns A compact string:
 * - `<60`: `Ns` (seconds)
 * - `<3600`: `Mm Ss` (minutes and seconds)
 * - `<86400`: `Hh Mm` (hours and minutes)
 * - `>=86400`: `Dd Hh` (days and hours)
 */

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

// ---------------------------------------------------------------------------
// Main page
/**
 * Renders the Fleet agent detail page for a container, showing status, health gauges, container info, labels, and lifecycle controls.
 *
 * Fetches container details and, when the container is running, health data (both polled every 10 seconds). Updates breadcrumbs from the container metadata, shows a loading skeleton or an error state as appropriate, and provides Start/Restart/Stop actions via a confirmation dialog that invalidate relevant queries on success.
 *
 * @returns The rendered Fleet agent detail page view.
 */

export function FleetAgentDetail() {
  const { containerId } = useParams<{ containerId: string }>();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [confirmAction, setConfirmAction] = useState<FleetAction | null>(null);

  // Container detail
  const {
    data: container,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: queryKeys.fleet.container(containerId!),
    queryFn: () => fleetosApi.getContainer(containerId!),
    enabled: !!containerId,
    refetchInterval: 10_000,
  });

  // Health polling (faster for running containers)
  const { data: health } = useQuery({
    queryKey: queryKeys.fleet.health(containerId!),
    queryFn: () => fleetosApi.getHealth(containerId!),
    enabled: !!containerId && container?.status === "running",
    refetchInterval: 10_000,
  });

  // Lifecycle action mutation
  const actionMutation = useMutation({
    mutationFn: ({ action }: { action: FleetAction }) =>
      fleetosApi.containerAction(containerId!, action),
    onSuccess: () => {
      setConfirmAction(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.fleet.container(containerId!) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.fleet.health(containerId!) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.fleet.containers });
    },
    onError: () => {
      setConfirmAction(null);
    },
  });

  useEffect(() => {
    const name = container?.labels?.agent_name ?? container?.name ?? containerId ?? "Container";
    setBreadcrumbs([
      { label: "Fleet", href: "/fleet" },
      { label: name },
    ]);
  }, [setBreadcrumbs, container, containerId]);

  if (isLoading) {
    return <PageSkeleton variant="detail" />;
  }

  if (error || !container) {
    return (
      <div className="space-y-4">
        <Link to="/fleet" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to Fleet
        </Link>
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4">
          <p className="text-sm text-destructive">
            {error instanceof Error ? error.message : "Container not found"}
          </p>
        </div>
      </div>
    );
  }

  const agentName = container.labels?.agent_name ?? container.name;
  const isRunning = container.status === "running";
  const h = health ?? container.health;

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Link to="/fleet" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground no-underline">
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to Fleet
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <Server className="h-5 w-5 text-muted-foreground shrink-0" />
            <h1 className="text-lg font-semibold truncate">{agentName}</h1>
            <StatusBadge status={container.status} />
          </div>
          <p className="mt-1 text-sm text-muted-foreground font-mono">{container.id}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
          >
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            Refresh
          </Button>
          {!isRunning && (
            <Button
              size="sm"
              onClick={() => setConfirmAction("start")}
              disabled={actionMutation.isPending}
            >
              <Play className="h-3.5 w-3.5 mr-1.5" />
              Start
            </Button>
          )}
          {isRunning && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmAction("restart")}
                disabled={actionMutation.isPending}
              >
                <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                Restart
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setConfirmAction("stop")}
                disabled={actionMutation.isPending}
              >
                <Square className="h-3.5 w-3.5 mr-1.5" />
                Stop
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Action error */}
      {actionMutation.error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3">
          <p className="text-sm text-destructive">
            {actionMutation.error instanceof Error
              ? actionMutation.error.message
              : "Action failed"}
          </p>
        </div>
      )}

      {/* Health panel */}
      {h && (
        <div className="rounded-lg border border-border bg-card p-6">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-4">
            Health
          </h2>
          <div className="flex items-center justify-around">
            <Gauge value={h.cpu_percent} label="CPU" size="lg" />
            <Gauge value={h.mem_percent} label="Memory" size="lg" />
            <Gauge value={h.disk_percent} label="Disk" size="lg" />
          </div>
          <div className="mt-4 flex items-center justify-center gap-6 text-xs text-muted-foreground">
            <span>
              Agent: <span className="font-medium">{h.agent_status}</span>
            </span>
            <span>
              Uptime: <span className="font-medium">{formatUptime(h.uptime_seconds)}</span>
            </span>
            <span>
              Last heartbeat: <span className="font-medium">{new Date(h.last_heartbeat).toLocaleTimeString()}</span>
            </span>
          </div>
        </div>
      )}

      {/* Info panel */}
      <div className="rounded-lg border border-border bg-card p-6">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          Container Info
        </h2>
        <div className="divide-y divide-border">
          <InfoRow icon={Hash} label="Container ID" value={container.id} />
          <InfoRow icon={Server} label="Name" value={container.name} />
          <InfoRow icon={Users} label="Tenant" value={container.tenant_id} />
          <InfoRow icon={Globe} label="IP Address" value={container.ip_address} />
          <InfoRow icon={Box} label="Image" value={container.image} />
          <InfoRow
            icon={Clock}
            label="Created"
            value={new Date(container.created_at).toLocaleString()}
          />
          <InfoRow
            icon={Clock}
            label="Updated"
            value={new Date(container.updated_at).toLocaleString()}
          />
        </div>
      </div>

      {/* Labels */}
      {Object.keys(container.labels).length > 0 && (
        <div className="rounded-lg border border-border bg-card p-6">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
            Labels
          </h2>
          <div className="flex flex-wrap gap-2">
            {Object.entries(container.labels).map(([k, v]) => (
              <span
                key={k}
                className="inline-flex items-center rounded-full border border-border bg-muted/50 px-2.5 py-0.5 text-xs"
              >
                <span className="text-muted-foreground">{k}:</span>
                <span className="ml-1 font-medium">{v}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Confirmation dialog */}
      {confirmAction && (
        <ActionConfirmDialog
          open={!!confirmAction}
          onOpenChange={(open) => {
            if (!open) setConfirmAction(null);
          }}
          action={confirmAction}
          containerName={agentName}
          onConfirm={() => actionMutation.mutate({ action: confirmAction })}
          isPending={actionMutation.isPending}
        />
      )}
    </div>
  );
}
