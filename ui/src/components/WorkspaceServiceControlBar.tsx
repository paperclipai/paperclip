import { useEffect, useRef, useState } from "react";
import type {
  WorkspaceRuntimeConfigSource,
  WorkspaceRuntimeDesiredState,
  WorkspaceRuntimeFailureEvidence,
} from "@paperclipai/shared";
import {
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  Loader2,
  Play,
  RotateCcw,
  Square,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { copyTextToClipboard } from "@/lib/clipboard";
import { timeAgo } from "@/lib/timeAgo";

export type WorkspaceServiceControlState =
  | "stopped"
  | "provisioning"
  | "starting"
  | "running"
  | "stopping"
  | "retrying"
  | "restarting"
  | "failed";

export type WorkspaceServiceControlAction = "start" | "stop" | "restart";

export type WorkspaceServiceControlEntry = {
  key: string;
  name: string;
  state: WorkspaceServiceControlState;
  actualState?: "provisioning" | "starting" | "running" | "stopped" | "failed";
  desiredState?: WorkspaceRuntimeDesiredState | null;
  configSource?: WorkspaceRuntimeConfigSource | null;
  healthStatus?: "unknown" | "healthy" | "unhealthy" | null;
  url?: string | null;
  port?: number | null;
  /** Short human-readable failure summary, e.g. "dev exited with code 1, 12s ago". */
  failureDetail?: string | null;
  latestFailure?: WorkspaceRuntimeFailureEvidence | null;
  canStart?: boolean;
};

export type WorkspaceServiceControlBarProps = {
  services: WorkspaceServiceControlEntry[];
  /** serviceKey is null when the action targets all services (aggregate bar / popover footer). */
  onAction: (action: WorkspaceServiceControlAction, serviceKey: string | null) => void;
  onViewLogs?: () => void;
  onViewOperation?: (operationId: string) => void;
  getOperationHref?: (operationId: string) => string | null;
  /** Optional link target for "Manage in Services tab" in the multi-service popover. */
  onManageServices?: () => void;
  /** Initial open state for the multi-service popover (used by Storybook/static captures). */
  defaultServicesOpen?: boolean;
  className?: string;
};

const TRANSITIONAL_STATES: WorkspaceServiceControlState[] = ["provisioning", "starting", "stopping", "retrying", "restarting"];

function isTransitional(state: WorkspaceServiceControlState) {
  return TRANSITIONAL_STATES.includes(state);
}

function formatServiceUrl(url: string | null | undefined) {
  if (!url) return null;
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function statusMeta(entry: WorkspaceServiceControlEntry): { label: string; unhealthy: boolean } {
  switch (entry.state) {
    case "provisioning":
      return { label: "Provisioning…", unhealthy: false };
    case "starting":
      return { label: "Starting…", unhealthy: false };
    case "stopping":
      return { label: "Stopping…", unhealthy: false };
    case "retrying":
      return { label: "Retrying…", unhealthy: false };
    case "restarting":
      return { label: "Restarting…", unhealthy: false };
    case "failed":
      return { label: "Failed", unhealthy: false };
    case "running":
      return entry.healthStatus === "unhealthy"
        ? { label: "Unhealthy", unhealthy: true }
        : { label: "Running", unhealthy: false };
    default:
      return { label: "Stopped", unhealthy: false };
  }
}

function titleCase(value: string) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function desiredStateLabel(value: WorkspaceRuntimeDesiredState | null | undefined) {
  return value ? titleCase(value) : "Not set";
}

function sourceLabel(source: WorkspaceRuntimeConfigSource | null | undefined) {
  if (source?.type === "project_workspace") return "Inherited from project workspace";
  if (source?.type === "execution_workspace") return "Execution workspace override";
  return null;
}

function healthLabel(entry: WorkspaceServiceControlEntry) {
  const actualState = entry.actualState ?? entry.state;
  if (actualState === "stopped" || actualState === "failed") return "Not reporting";
  if (entry.healthStatus === "healthy") return "Healthy";
  if (entry.healthStatus === "unhealthy") return "Unhealthy";
  return "Not reporting";
}

function actualStateLabel(entry: WorkspaceServiceControlEntry) {
  const actualState = entry.actualState
    ?? (entry.state === "retrying" || entry.state === "restarting" || entry.state === "stopping"
      ? "stopped"
      : entry.state);
  return actualState === "provisioning" ? "Starting" : titleCase(actualState);
}

function StatusIndicator({ entry, className }: { entry: WorkspaceServiceControlEntry; className?: string }) {
  if (isTransitional(entry.state)) {
    return <Loader2 className={cn("size-3 shrink-0 animate-spin text-muted-foreground", className)} />;
  }
  if (entry.state === "failed") {
    return <TriangleAlert className={cn("size-3 shrink-0 text-destructive", className)} />;
  }
  const unhealthy = entry.state === "running" && entry.healthStatus === "unhealthy";
  return (
    <span
      className={cn(
        "size-2 shrink-0 rounded-full",
        entry.state === "running"
          ? unhealthy
            ? "bg-amber-500 ring-2 ring-amber-500/30"
            : "bg-emerald-500"
          : "border border-muted-foreground/60 bg-transparent",
        className,
      )}
    />
  );
}

function CopyUrlButton({ url, disabled }: { url: string; disabled?: boolean }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
  }, []);
  const copyLabel = copyState === "copied" ? "URL copied" : copyState === "failed" ? "Copy failed" : "Copy URL";
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      disabled={disabled}
      aria-label={copyLabel}
      title={copyLabel}
      className="text-muted-foreground hover:text-foreground"
      onClick={async () => {
        try {
          await copyTextToClipboard(url);
          setCopyState("copied");
        } catch {
          setCopyState("failed");
        }
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        timeoutRef.current = setTimeout(() => setCopyState("idle"), 1500);
      }}
    >
      {copyState === "copied" ? (
        <Check className="size-3" />
      ) : copyState === "failed" ? (
        <TriangleAlert className="size-3 text-destructive" />
      ) : (
        <Copy className="size-3" />
      )}
      <span className="sr-only" aria-live="polite">{copyLabel}</span>
    </Button>
  );
}

function UrlSegment({ entry, compact }: { entry: WorkspaceServiceControlEntry; compact?: boolean }) {
  const displayUrl = formatServiceUrl(entry.url);
  const live = (entry.actualState ?? entry.state) === "running" && Boolean(entry.url);

  return (
    <div className={cn("flex min-w-0 items-center gap-2", compact ? "flex-wrap" : null)}>
      <span className="shrink-0 font-mono text-xs text-muted-foreground">
        {entry.port ? `Port ${entry.port}` : "No port"}
      </span>
      {live && displayUrl ? (
        <a
          href={entry.url ?? undefined}
          target="_blank"
          rel="noreferrer"
          title={entry.url ?? undefined}
          className={cn("min-w-0 truncate font-mono text-xs text-foreground hover:underline", compact ? "max-w-44" : "max-w-56")}
        >
          {displayUrl}
        </a>
      ) : (
        <span className="text-xs text-muted-foreground">No live URL</span>
      )}
      <span className={cn("flex items-center", live ? null : "invisible")} aria-hidden={live ? undefined : true}>
        <CopyUrlButton url={entry.url ?? ""} disabled={!live} />
        <Button
          asChild={live}
          variant="ghost"
          size="icon-xs"
          disabled={!live}
          className="text-muted-foreground hover:text-foreground"
          title="Open in new tab"
        >
          {live ? (
            <a href={entry.url ?? undefined} target="_blank" rel="noreferrer" aria-label="Open in new tab">
              <ExternalLink className="size-3" />
            </a>
          ) : (
            <ExternalLink className="size-3" />
          )}
        </Button>
      </span>
    </div>
  );
}

function ActionSlots({
  entry,
  onAction,
}: {
  entry: Pick<WorkspaceServiceControlEntry, "state" | "canStart">;
  onAction: (action: WorkspaceServiceControlAction) => void;
}) {
  const transitional = isTransitional(entry.state);
  const canStart = entry.canStart ?? true;

  if (
    entry.state === "stopped"
    || entry.state === "failed"
    || entry.state === "starting"
    || entry.state === "provisioning"
    || entry.state === "retrying"
  ) {
    const isRetry = entry.state === "failed" || entry.state === "retrying";
    const pending = entry.state === "starting" || entry.state === "provisioning" || entry.state === "retrying";
    const label = isRetry ? (pending ? "Retrying…" : "Retry") : pending ? "Starting…" : "Start";
    return (
      <Button
        variant="cta"
        size="sm"
        disabled={!canStart || pending}
        onClick={() => onAction("start")}
        aria-label={label}
        aria-live={pending ? "polite" : undefined}
        aria-busy={pending || undefined}
        title={label}
      >
        {pending ? <Loader2 className="size-3 animate-spin" /> : isRetry ? <RotateCcw className="size-3" /> : <Play className="size-3" />}
        {label}
      </Button>
    );
  }

  return (
    <>
      <Button
        variant="ghost"
        size="icon-xs"
        disabled={transitional}
        onClick={() => onAction("stop")}
        aria-label="Stop"
        title="Stop"
        className="border border-border text-foreground"
      >
        <Square className="size-3" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        disabled={transitional || !canStart}
        onClick={() => onAction("restart")}
        aria-label="Restart"
        title="Restart"
        className="border border-border text-foreground"
      >
        <RotateCcw className="size-3" />
      </Button>
    </>
  );
}

function FailureDetail({
  entry,
  onViewLogs,
  onViewOperation,
  getOperationHref,
}: {
  entry: WorkspaceServiceControlEntry;
  onViewLogs?: () => void;
  onViewOperation?: (operationId: string) => void;
  getOperationHref?: (operationId: string) => string | null;
}) {
  const failure = entry.latestFailure;
  if (!failure || (entry.actualState ?? entry.state) === "running") return null;
  const failedPort = failure.details?.port ?? entry.port;
  const operationHref = getOperationHref?.(failure.operationId) ?? null;
  return (
    <div className="w-full rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs" role="alert">
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 size-3 shrink-0 text-destructive" aria-hidden />
        <div className="min-w-0 space-y-1">
          <div className="font-medium text-destructive">
            Couldn’t start {entry.name}{failedPort ? <> on port <span className="font-mono">{failedPort}</span></> : null}
          </div>
          <p className="text-foreground">{failure.message}</p>
          <p className="text-foreground">
            {failure.remediation} Paperclip will not stop another workspace.
          </p>
          <div className="flex flex-wrap items-center gap-1 text-muted-foreground">
            {operationHref ? (
              <a
                href={operationHref}
                className="font-medium text-foreground underline underline-offset-2 hover:text-foreground/80"
              >
                View operation
              </a>
            ) : onViewOperation ? (
              <button
                type="button"
                onClick={() => onViewOperation(failure.operationId)}
                className="font-medium text-foreground underline underline-offset-2 hover:text-foreground/80"
              >
                View operation
              </button>
            ) : onViewLogs ? (
              <button
                type="button"
                onClick={onViewLogs}
                className="font-medium text-foreground underline underline-offset-2 hover:text-foreground/80"
              >
                View operation
              </button>
            ) : null}
            {operationHref || onViewOperation || onViewLogs ? <span aria-hidden>·</span> : null}
            <span>{timeAgo(failure.failedAt)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function SingleServiceBar({
  entry,
  onAction,
  onViewLogs,
  onViewOperation,
  getOperationHref,
  className,
}: {
  entry: WorkspaceServiceControlEntry;
  onAction: (action: WorkspaceServiceControlAction, serviceKey: string | null) => void;
  onViewLogs?: () => void;
  onViewOperation?: (operationId: string) => void;
  getOperationHref?: (operationId: string) => string | null;
  className?: string;
}) {
  return (
    <div className={cn("flex w-full flex-col items-stretch gap-2 sm:w-auto sm:items-end", className)}>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 self-start sm:self-end">
        <span className="text-sm font-medium text-foreground">{entry.name}</span>
        {sourceLabel(entry.configSource) ? (
          <span className="text-xs text-muted-foreground">{sourceLabel(entry.configSource)}</span>
        ) : null}
      </div>
      <div className="rounded-lg border border-border bg-background">
        <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-2 p-2 pl-3">
          <div className="flex items-center gap-2">
            <StatusIndicator entry={entry} />
            <span className="whitespace-nowrap text-xs font-medium text-foreground">Actual: {actualStateLabel(entry)}</span>
          </div>
          <span className="text-xs text-muted-foreground">
            Desired: {desiredStateLabel(entry.desiredState)}
          </span>
          <span className="text-xs text-muted-foreground">Health: {healthLabel(entry)}</span>
          <div className="hidden w-56 min-w-0 shrink-0 items-center sm:flex" data-service-endpoint-segment>
            <UrlSegment entry={entry} />
          </div>
          <div className="ml-auto flex items-center gap-1">
            <ActionSlots
              entry={entry}
              onAction={(action) => onAction(action, entry.key)}
            />
          </div>
        </div>
        <div className="flex min-h-9 items-center justify-between gap-0.5 border-t border-border px-3 py-1 sm:hidden">
          <UrlSegment entry={entry} compact />
        </div>
      </div>
      <FailureDetail
        entry={entry}
        onViewLogs={onViewLogs}
        onViewOperation={onViewOperation}
        getOperationHref={getOperationHref}
      />
    </div>
  );
}

function ServicePopoverRow({
  entry,
  onAction,
  onViewOperation,
  getOperationHref,
}: {
  entry: WorkspaceServiceControlEntry;
  onAction: (action: WorkspaceServiceControlAction, serviceKey: string | null) => void;
  onViewOperation?: (operationId: string) => void;
  getOperationHref?: (operationId: string) => string | null;
}) {
  const meta = statusMeta(entry);
  const displayUrl = formatServiceUrl(entry.url);
  const live = (entry.actualState ?? entry.state) === "running" && Boolean(entry.url);
  const secondary = live
    ? displayUrl
    : entry.state === "starting" && entry.port
      ? `starting on :${entry.port}…`
      : entry.state === "failed" && entry.failureDetail
        ? entry.failureDetail
        : `${meta.label.toLowerCase().replace(/…$/, "")}${entry.port ? ` · :${entry.port}` : ""}`;

  return (
    <div className="flex flex-col gap-2 py-2.5">
      <div className="flex items-start gap-3">
      <StatusIndicator entry={entry} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">{entry.name}</div>
        {sourceLabel(entry.configSource) ? <div className="text-xs text-muted-foreground">{sourceLabel(entry.configSource)}</div> : null}
        <div className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
          <span>Actual: {actualStateLabel(entry)}</span>
          <span>Desired: {desiredStateLabel(entry.desiredState)}</span>
          <span>Health: {healthLabel(entry)}</span>
        </div>
        <div className="flex min-w-0 items-center gap-0.5">
          {live && entry.url ? (
            <>
              <a
                href={entry.url}
                target="_blank"
                rel="noreferrer"
                title={entry.url}
                className="min-w-0 truncate font-mono text-xs text-muted-foreground hover:text-foreground hover:underline"
              >
                {displayUrl}
              </a>
              <CopyUrlButton url={entry.url} />
            </>
          ) : (
            <span className="min-w-0 truncate text-xs text-muted-foreground">{secondary}</span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <ActionSlots entry={entry} onAction={(action) => onAction(action, entry.key)} />
      </div>
      </div>
      <FailureDetail entry={entry} onViewOperation={onViewOperation} getOperationHref={getOperationHref} />
    </div>
  );
}

function MultiServiceBar({
  services,
  onAction,
  onManageServices,
  onViewOperation,
  getOperationHref,
  defaultServicesOpen,
  className,
}: {
  services: WorkspaceServiceControlEntry[];
  onAction: (action: WorkspaceServiceControlAction, serviceKey: string | null) => void;
  onManageServices?: () => void;
  onViewOperation?: (operationId: string) => void;
  getOperationHref?: (operationId: string) => string | null;
  defaultServicesOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultServicesOpen ?? false);
  const runningCount = services.filter((entry) => entry.state === "running").length;
  const anyTransitional = services.some((entry) => isTransitional(entry.state));
  const anyFailed = services.some((entry) => entry.state === "failed");
  const failedCount = services.filter((entry) => entry.state === "failed").length;
  const anyRunning = runningCount > 0;
  const primary = services.find((entry) => entry.state === "running" && entry.url) ?? null;

  const aggregateEntry: WorkspaceServiceControlEntry = {
    key: "__all__",
    name: "All services",
    state: anyTransitional
      ? "starting"
      : anyFailed
        ? "failed"
        : anyRunning
          ? "running"
          : "stopped",
    healthStatus: services.some((entry) => entry.state === "running" && entry.healthStatus === "unhealthy")
      ? "unhealthy"
      : "healthy",
  };

  return (
    <div className={cn("flex w-full flex-col items-stretch gap-1 sm:w-auto sm:items-end", className)}>
      <div className="rounded-lg border border-border bg-background">
        <div className="flex h-9 items-center pl-3 pr-1.5">
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="flex h-full items-center gap-2 rounded-l-lg pr-1 text-xs font-medium text-foreground hover:bg-accent"
                aria-label={`${runningCount} of ${services.length} services running — show services`}
              >
                <StatusIndicator entry={aggregateEntry} />
                <span className="whitespace-nowrap">
                  {runningCount}/{services.length} running{failedCount > 0 ? ` · ${failedCount} failed` : ""}
                </span>
                <ChevronDown className="size-3 text-muted-foreground" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80 p-0 sm:w-96" onOpenAutoFocus={(event) => event.preventDefault()}>
              <div className="px-4 pb-1 pt-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Services · {services.length}
              </div>
              <div className="divide-y divide-border px-4">
                {services.map((entry) => (
                  <ServicePopoverRow
                    key={entry.key}
                    entry={entry}
                    onAction={onAction}
                    onViewOperation={onViewOperation}
                    getOperationHref={getOperationHref}
                  />
                ))}
              </div>
              <div className="flex items-center gap-1 border-t border-border px-4 py-2">
                <Button variant="ghost" size="xs" onClick={() => onAction("start", null)}>Start all</Button>
                <Button variant="ghost" size="xs" onClick={() => onAction("stop", null)}>Stop all</Button>
                <Button variant="ghost" size="xs" onClick={() => onAction("restart", null)}>Restart all</Button>
                {onManageServices ? (
                  <Button
                    variant="link"
                    size="xs"
                    className="ml-auto text-muted-foreground"
                    onClick={onManageServices}
                  >
                    Manage in Services tab →
                  </Button>
                ) : null}
              </div>
            </PopoverContent>
          </Popover>
          <div className="mx-3 hidden h-5 w-px bg-border sm:block" />
          <div className="hidden min-w-0 items-center gap-0.5 sm:flex">
            {primary ? (
              <>
                <span className="mr-1 shrink-0 text-xs text-muted-foreground">{primary.name}</span>
                <UrlSegment entry={primary} />
              </>
            ) : (
              <span className="font-mono text-xs text-muted-foreground/70">no url</span>
            )}
          </div>
          <div className="mx-3 hidden h-5 w-px bg-border sm:block" />
          <div className="ml-auto flex items-center gap-1 pl-3 sm:pl-0">
            <ActionSlots
              entry={{ state: aggregateEntry.state, canStart: true }}
              onAction={(action) => onAction(action, null)}
            />
          </div>
        </div>
        {primary ? (
          <div className="flex h-8 items-center justify-between gap-0.5 border-t border-border px-3 sm:hidden">
            <UrlSegment entry={primary} compact />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Segmented control bar for execution-workspace services: status · URL · actions.
 * Geometry is identical in every state — transitions are announced by the status
 * segment (spinner + label) instead of buttons appearing and disappearing.
 */
export function WorkspaceServiceControlBar({
  services,
  onAction,
  onViewLogs,
  onViewOperation,
  getOperationHref,
  onManageServices,
  defaultServicesOpen,
  className,
}: WorkspaceServiceControlBarProps) {
  if (services.length === 0) return null;
  if (services.length === 1) {
    return (
      <SingleServiceBar
        entry={services[0]}
        onAction={onAction}
        onViewLogs={onViewLogs}
        onViewOperation={onViewOperation}
        getOperationHref={getOperationHref}
        className={className}
      />
    );
  }
  return (
    <MultiServiceBar
      services={services}
      onAction={onAction}
      onManageServices={onManageServices}
      onViewOperation={onViewOperation}
      getOperationHref={getOperationHref}
      defaultServicesOpen={defaultServicesOpen}
      className={className}
    />
  );
}
