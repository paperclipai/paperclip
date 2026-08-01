import { useEffect, useRef, useState } from "react";
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

export type WorkspaceServiceControlState =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "restarting"
  | "failed";

export type WorkspaceServiceControlAction = "start" | "stop" | "restart";

export type WorkspaceServiceControlEntry = {
  key: string;
  name: string;
  state: WorkspaceServiceControlState;
  healthStatus?: "unknown" | "healthy" | "unhealthy" | null;
  url?: string | null;
  port?: number | null;
  /** Short human-readable failure summary, e.g. "dev exited with code 1, 12s ago". */
  failureDetail?: string | null;
  canStart?: boolean;
};

export type WorkspaceServiceControlBarProps = {
  services: WorkspaceServiceControlEntry[];
  /** serviceKey is null when the action targets all services (aggregate bar / popover footer). */
  onAction: (action: WorkspaceServiceControlAction, serviceKey: string | null) => void;
  onViewLogs?: () => void;
  /** Optional link target for "Manage in Services tab" in the multi-service popover. */
  onManageServices?: () => void;
  /** Initial open state for the multi-service popover (used by Storybook/static captures). */
  defaultServicesOpen?: boolean;
  className?: string;
};

const TRANSITIONAL_STATES: WorkspaceServiceControlState[] = ["starting", "stopping", "restarting"];

function isTransitional(state: WorkspaceServiceControlState) {
  return TRANSITIONAL_STATES.includes(state);
}

function formatServiceUrl(url: string | null | undefined) {
  if (!url) return null;
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function statusMeta(entry: WorkspaceServiceControlEntry): { label: string; unhealthy: boolean } {
  switch (entry.state) {
    case "starting":
      return { label: "Starting…", unhealthy: false };
    case "stopping":
      return { label: "Stopping…", unhealthy: false };
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
          if (!navigator.clipboard) throw new Error("Clipboard API unavailable");
          await navigator.clipboard.writeText(url);
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
  const displayUrl = formatServiceUrl(entry.url) ?? (entry.port ? `:${entry.port}` : null);
  const live = entry.state === "running" && Boolean(entry.url);

  if (!displayUrl) {
    return <span className="font-mono text-xs text-muted-foreground/70">no url</span>;
  }
  return (
    <>
      {live ? (
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
        <span
          title={entry.url ?? undefined}
          className={cn("min-w-0 truncate font-mono text-xs text-muted-foreground/70", compact ? "max-w-44" : "max-w-56")}
        >
          {displayUrl}
        </span>
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
    </>
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

  if (entry.state === "stopped") {
    return (
      <Button
        variant="cta"
        size="xs"
        className="w-13 justify-center"
        disabled={!canStart}
        onClick={() => onAction("start")}
        aria-label="Start"
        title="Start"
      >
        <Play className="size-3" />
        Start
      </Button>
    );
  }

  if (entry.state === "failed") {
    return (
      <>
        <Button
          variant="cta"
          size="icon-xs"
          disabled={!canStart}
          onClick={() => onAction("start")}
          aria-label="Start"
          title="Start"
        >
          <Play className="size-3" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={!canStart}
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
}: {
  entry: WorkspaceServiceControlEntry;
  onViewLogs?: () => void;
}) {
  if (entry.state !== "failed" || !entry.failureDetail) return null;
  return (
    <div className="flex items-center gap-1 text-xs text-muted-foreground">
      <span>{entry.failureDetail}</span>
      {onViewLogs ? (
        <>
          <span aria-hidden>·</span>
          <button
            type="button"
            onClick={onViewLogs}
            className="font-medium text-foreground underline underline-offset-2 hover:text-foreground/80"
          >
            View logs
          </button>
        </>
      ) : null}
    </div>
  );
}

function SingleServiceBar({
  entry,
  onAction,
  onViewLogs,
  className,
}: {
  entry: WorkspaceServiceControlEntry;
  onAction: (action: WorkspaceServiceControlAction, serviceKey: string | null) => void;
  onViewLogs?: () => void;
  className?: string;
}) {
  const meta = statusMeta(entry);
  return (
    <div className={cn("flex w-full flex-col items-stretch gap-1 sm:w-auto sm:items-end", className)}>
      <div className="rounded-lg border border-border bg-background">
        <div className="flex h-9 items-center pl-3 pr-1.5">
          <div className="flex items-center gap-2 sm:min-w-24">
            <StatusIndicator entry={entry} />
            <span className="whitespace-nowrap text-xs font-medium text-foreground">{meta.label}</span>
          </div>
          <div className="mx-3 hidden h-5 w-px bg-border sm:block" />
          <div className="hidden w-56 min-w-0 shrink-0 items-center gap-0.5 sm:flex">
            <UrlSegment entry={entry} />
          </div>
          <div className="mx-3 hidden h-5 w-px bg-border sm:block" />
          <div className="ml-auto flex items-center gap-1 pl-3 sm:pl-0">
            <ActionSlots
              entry={entry}
              onAction={(action) => onAction(action, entry.key)}
            />
          </div>
        </div>
        <div className="flex h-8 items-center justify-between gap-0.5 border-t border-border px-3 sm:hidden">
          <UrlSegment entry={entry} compact />
        </div>
      </div>
      <FailureDetail entry={entry} onViewLogs={onViewLogs} />
    </div>
  );
}

function ServicePopoverRow({
  entry,
  onAction,
}: {
  entry: WorkspaceServiceControlEntry;
  onAction: (action: WorkspaceServiceControlAction, serviceKey: string | null) => void;
}) {
  const meta = statusMeta(entry);
  const displayUrl = formatServiceUrl(entry.url);
  const live = entry.state === "running" && Boolean(entry.url);
  const secondary = live
    ? displayUrl
    : entry.state === "starting" && entry.port
      ? `starting on :${entry.port}…`
      : entry.state === "failed" && entry.failureDetail
        ? entry.failureDetail
        : `${meta.label.toLowerCase().replace(/…$/, "")}${entry.port ? ` · :${entry.port}` : ""}`;

  return (
    <div className="flex items-center gap-3 py-2.5">
      <StatusIndicator entry={entry} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">{entry.name}</div>
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
  );
}

function MultiServiceBar({
  services,
  onAction,
  onManageServices,
  defaultServicesOpen,
  className,
}: {
  services: WorkspaceServiceControlEntry[];
  onAction: (action: WorkspaceServiceControlAction, serviceKey: string | null) => void;
  onManageServices?: () => void;
  defaultServicesOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultServicesOpen ?? false);
  const runningCount = services.filter((entry) => entry.state === "running").length;
  const anyTransitional = services.some((entry) => isTransitional(entry.state));
  const anyFailed = services.some((entry) => entry.state === "failed");
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
                <span className="whitespace-nowrap">{runningCount}/{services.length} running</span>
                <ChevronDown className="size-3 text-muted-foreground" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-96 p-0" onOpenAutoFocus={(event) => event.preventDefault()}>
              <div className="px-4 pb-1 pt-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Services · {services.length}
              </div>
              <div className="divide-y divide-border px-4">
                {services.map((entry) => (
                  <ServicePopoverRow key={entry.key} entry={entry} onAction={onAction} />
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
        className={className}
      />
    );
  }
  return (
    <MultiServiceBar
      services={services}
      onAction={onAction}
      onManageServices={onManageServices}
      defaultServicesOpen={defaultServicesOpen}
      className={className}
    />
  );
}
