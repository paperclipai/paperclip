import { t, useTranslation, Trans } from "@/i18n";
import type {
  WorkspaceCommandDefinition,
  RuntimeExposureStatus,
  WorkspaceRuntimeControlTarget,
  WorkspaceRuntimeService,
} from "@paperclipai/shared";
import {
  listWorkspaceCommandDefinitions,
  matchWorkspaceRuntimeServiceToCommand,
} from "@paperclipai/shared";
import { Activity, ExternalLink, Loader2, Play, RotateCcw, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useManagedSandboxOnly } from "@/hooks/useManagedSandboxOnly";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { timeAgo } from "@/lib/timeAgo";
import type {
  WorkspaceServiceControlAction,
  WorkspaceServiceControlEntry,
} from "@/components/WorkspaceServiceControlBar";

export type WorkspaceRuntimeAction = "start" | "stop" | "restart" | "run";

export type WorkspaceRuntimeControlRequest = WorkspaceRuntimeControlTarget & {
  action: WorkspaceRuntimeAction;
};

export type WorkspaceRuntimeControlItem = {
  key: string;
  title: string;
  kind: "service" | "job";
  statusLabel: string;
  lifecycle: "shared" | "ephemeral" | null;
  healthStatus: "unknown" | "healthy" | "unhealthy" | null;
  exposure: RuntimeExposureStatus | null;
  command: string | null;
  cwd: string | null;
  port: number | null;
  url: string | null;
  canStart: boolean;
  canRun: boolean;
  workspaceCommandId?: string | null;
  runtimeServiceId?: string | null;
  serviceIndex?: number | null;
  disabledReason?: string | null;
  disabledReasonKey?: string;
};

export type WorkspaceRuntimeControlSections = {
  services: WorkspaceRuntimeControlItem[];
  jobs: WorkspaceRuntimeControlItem[];
  otherServices: WorkspaceRuntimeControlItem[];
};

type WorkspaceRuntimeControlsProps = {
  sections: WorkspaceRuntimeControlSections;
  isPending?: boolean;
  pendingRequest?: WorkspaceRuntimeControlRequest | null;
  serviceEmptyMessage?: string;
  jobEmptyMessage?: string;
  disabledHint?: string | null;
  onAction: (request: WorkspaceRuntimeControlRequest) => void;
  className?: string;
  square?: boolean;
};

export function hasRunningRuntimeServices(
  runtimeServices: Array<{ status: string }> | null | undefined,
) {
  return (runtimeServices ?? []).some((service) => service.status === "starting" || service.status === "running");
}

function buildServiceItem(
  command: WorkspaceCommandDefinition,
  runtimeService: WorkspaceRuntimeService | null,
  canStartServices: boolean,
): WorkspaceRuntimeControlItem {
  return {
    key: `command:${command.id}:${runtimeService?.id ?? "idle"}`,
    get title() { return [command.rawConfig.name, command.rawConfig.label, command.rawConfig.title].some(value => typeof value === "string" && value.trim()) ? command.name : t(command.kind === "job" ? "final-components-a:jobNumber" : "final-components-a:serviceNumber", { number: command.source.index + 1 }); },
    kind: "service",
    statusLabel: runtimeService?.status ?? "stopped",
    lifecycle: runtimeService?.lifecycle ?? command.lifecycle,
    healthStatus: runtimeService?.healthStatus ?? "unknown",
    exposure: runtimeService?.exposure ?? null,
    command: runtimeService?.command ?? command.command,
    cwd: runtimeService?.cwd ?? command.cwd,
    port: runtimeService?.port ?? null,
    url: runtimeService?.url ?? null,
    canStart: canStartServices && !command.disabledReason,
    canRun: false,
    workspaceCommandId: command.id,
    runtimeServiceId: runtimeService?.id ?? null,
    serviceIndex: command.serviceIndex,
    disabledReason: command.disabledReason,
  };
}

function buildJobItem(
  command: WorkspaceCommandDefinition,
  canRunJobs: boolean,
): WorkspaceRuntimeControlItem {
  return {
    key: `command:${command.id}`,
    get title() { return [command.rawConfig.name, command.rawConfig.label, command.rawConfig.title].some(value => typeof value === "string" && value.trim()) ? command.name : t(command.kind === "job" ? "final-components-a:jobNumber" : "final-components-a:serviceNumber", { number: command.source.index + 1 }); },
    kind: "job",
    statusLabel: "run once",
    lifecycle: null,
    healthStatus: null,
    exposure: null,
    command: command.command,
    cwd: command.cwd,
    port: null,
    url: null,
    canStart: false,
    canRun: canRunJobs && !command.disabledReason && Boolean(command.command),
    workspaceCommandId: command.id,
    runtimeServiceId: null,
    serviceIndex: null,
    disabledReason: command.disabledReason ?? (!command.command ? "This job is missing a command." : null),
    disabledReasonKey: !command.disabledReason && !command.command ? "final-components-a:missingJobCommand" : undefined,
  };
}

export function buildWorkspaceRuntimeControlSections(input: {
  runtimeConfig: Record<string, unknown> | null | undefined;
  runtimeServices: WorkspaceRuntimeService[] | null | undefined;
  canStartServices: boolean;
  canRunJobs?: boolean;
}): WorkspaceRuntimeControlSections {
  const commands = listWorkspaceCommandDefinitions(input.runtimeConfig);
  const runtimeServices = [...(input.runtimeServices ?? [])];
  const matchedRuntimeServiceIds = new Set<string>();
  const services: WorkspaceRuntimeControlItem[] = [];
  const jobs: WorkspaceRuntimeControlItem[] = [];

  for (const command of commands) {
    if (command.kind === "job") {
      jobs.push(buildJobItem(command, input.canRunJobs ?? input.canStartServices));
      continue;
    }

    const runtimeService = matchWorkspaceRuntimeServiceToCommand(command, runtimeServices);
    if (runtimeService) matchedRuntimeServiceIds.add(runtimeService.id);
    services.push(buildServiceItem(command, runtimeService, input.canStartServices));
  }

  const otherServices = runtimeServices
    .filter((runtimeService) =>
      !matchedRuntimeServiceIds.has(runtimeService.id)
      && (runtimeService.status === "provisioning"
        || runtimeService.status === "starting"
        || runtimeService.status === "running"))
    .map((runtimeService) => ({
      key: `runtime:${runtimeService.id}`,
      title: runtimeService.serviceName,
      kind: "service" as const,
      statusLabel: runtimeService.status,
      lifecycle: runtimeService.lifecycle,
      healthStatus: runtimeService.healthStatus,
      exposure: runtimeService.exposure ?? null,
      command: runtimeService.command ?? null,
      cwd: runtimeService.cwd ?? null,
      port: runtimeService.port ?? null,
      url: runtimeService.url ?? null,
      canStart: false,
      canRun: false,
      workspaceCommandId: null,
      runtimeServiceId: runtimeService.id,
      serviceIndex: runtimeService.configIndex ?? null,
      disabledReason: "This runtime service no longer matches a configured workspace command.",
      disabledReasonKey: "final-components-a:runtimeCommandMismatch",
    }));

  return {
    services,
    jobs,
    otherServices,
  };
}

export function getRunningRuntimeServiceUrl(
  sections: WorkspaceRuntimeControlSections,
) {
  const runningService = [...sections.services, ...sections.otherServices].find(
    (item) => (item.statusLabel === "running" || item.statusLabel === "starting") && item.url,
  );
  return runningService?.url ?? null;
}

function isActiveStatusLabel(statusLabel: string) {
  return statusLabel === "running" || statusLabel === "starting" || statusLabel === "provisioning";
}

function exposureFailureCopy(exposure: RuntimeExposureStatus | null) {
  if (exposure?.state === "failed") {
    return {
      label: t("task-components:httpsUnavailable_0c011e77"),
      remediation: t("final-components-a:checkTheTailscaleBrokerAnd_2a9c4daf"),
    };
  }
  if (exposure?.state === "cleanup_pending") {
    return {
      label: t("task-components:httpsCleanupPending_6727ed53"),
      remediation: t("final-components-a:restartTheHostBrokerBefore_b6326652"),
    };
  }
  return null;
}

function ExposureFailureDetail({ exposure }: { exposure: RuntimeExposureStatus | null }) {
  useTranslation("task-components");
  const copy = exposureFailureCopy(exposure);
  if (!copy) return null;
  return (
    <div className="space-y-1 break-words text-xs text-destructive" role="alert">
      <div
        className="line-clamp-3 font-medium"
        title={exposure?.lastError ?? undefined}
      >
        {copy.label}
        {exposure?.lastError ? ` · ${exposure.lastError}` : ""}
      </div>
      <div>{copy.remediation}</div>
    </div>
  );
}

/**
 * Maps runtime control sections onto the fixed-geometry service control bar
 * model. In-flight mutations overlay the transitional states (starting /
 * stopping / restarting) that the server status enum does not carry.
 */
export function buildWorkspaceServiceControlEntries(input: {
  sections: WorkspaceRuntimeControlSections;
  runtimeServices?: WorkspaceRuntimeService[] | null;
  isPending?: boolean;
  pendingRequest?: WorkspaceRuntimeControlRequest | null;
  pendingRequests?: WorkspaceRuntimeControlRequest[];
}): WorkspaceServiceControlEntry[] {
  const runtimeServicesById = new Map(
    (input.runtimeServices ?? []).map((runtimeService) => [runtimeService.id, runtimeService]),
  );
  const pendingRequests = input.pendingRequests
    ?? (input.isPending && input.pendingRequest ? [input.pendingRequest] : []);

  return [...input.sections.services, ...input.sections.otherServices].map((item) => {
    let state: WorkspaceServiceControlEntry["state"] =
      item.statusLabel === "running"
        ? "running"
        : item.statusLabel === "provisioning"
          ? "provisioning"
          : item.statusLabel === "starting"
            ? "starting"
            : item.statusLabel === "failed"
              ? "failed"
              : "stopped";

    const pendingRequest = pendingRequests.find((request) =>
      request.action !== "run"
      && (request.workspaceCommandId ?? null) === (item.workspaceCommandId ?? null)
      && (request.runtimeServiceId ?? null) === (item.runtimeServiceId ?? null)
      && (request.serviceIndex ?? null) === (item.serviceIndex ?? null));
    if (pendingRequest) {
      state = pendingRequest.action === "stop"
        ? "stopping"
        : pendingRequest.action === "restart"
          ? "restarting"
          : "starting";
    }

    const runtimeService = item.runtimeServiceId ? runtimeServicesById.get(item.runtimeServiceId) ?? null : null;
    const failureDetail = state === "failed"
      ? runtimeService?.stoppedAt ? t("final-components-a:serviceFailedTime_f0bc8d6e", { time: timeAgo(runtimeService.stoppedAt) }) : t("final-components-a:serviceFailed_c37124e2")
      : null;
    const exposure = runtimeService?.exposure ?? item.exposure;
    const exposureFailure = exposureFailureCopy(exposure);
    const exposureDetail = exposure?.state === "pending"
      ? t("final-components-a:provisioningHTTPS_038fbe1d")
      : exposure?.state === "ready"
        ? t("final-components-a:httpsReady_b796de5c")
        : exposureFailure
          ? `${exposureFailure.label} · ${exposureFailure.remediation}`
          : null;

    return {
      key: item.key,
      name: item.title,
      state,
      healthStatus: item.healthStatus,
      url: item.url,
      port: item.port,
      failureDetail,
      exposureState: exposure?.state ?? null,
      exposureDetail,
      canStart: item.canStart,
    };
  });
}

/**
 * Resolves a control-bar action into the runtime control requests to fire.
 * A null serviceKey targets every applicable service (the aggregate bar and
 * popover bulk actions).
 */
export function resolveWorkspaceServiceControlRequests(
  sections: WorkspaceRuntimeControlSections,
  action: WorkspaceServiceControlAction,
  serviceKey: string | null,
): WorkspaceRuntimeControlRequest[] {
  const items = [...sections.services, ...sections.otherServices];
  if (serviceKey !== null) {
    const item = items.find((candidate) => candidate.key === serviceKey);
    return item ? [buildRequest(item, action)] : [];
  }
  if (action === "stop") {
    return items
      .filter((item) => isActiveStatusLabel(item.statusLabel))
      .map((item) => buildRequest(item, "stop"));
  }
  if (action === "start") {
    return items
      .filter((item) => !isActiveStatusLabel(item.statusLabel) && item.canStart)
      .map((item) => buildRequest(item, "start"));
  }
  return items.flatMap((item) => {
    if (isActiveStatusLabel(item.statusLabel)) return [buildRequest(item, "restart")];
    if (item.canStart) return [buildRequest(item, "start")];
    return [];
  });
}

function requestMatchesPending(
  pendingRequest: WorkspaceRuntimeControlRequest | null | undefined,
  nextRequest: WorkspaceRuntimeControlRequest,
) {
  return pendingRequest?.action === nextRequest.action
    && (pendingRequest?.workspaceCommandId ?? null) === (nextRequest.workspaceCommandId ?? null)
    && (pendingRequest?.runtimeServiceId ?? null) === (nextRequest.runtimeServiceId ?? null)
    && (pendingRequest?.serviceIndex ?? null) === (nextRequest.serviceIndex ?? null);
}

function buildRequest(item: WorkspaceRuntimeControlItem, action: WorkspaceRuntimeAction): WorkspaceRuntimeControlRequest {
  return {
    action,
    workspaceCommandId: item.workspaceCommandId ?? null,
    runtimeServiceId: item.runtimeServiceId ?? null,
    serviceIndex: item.serviceIndex ?? null,
  };
}

function CommandActionButtons({
  item,
  isPending,
  pendingRequest,
  onAction,
  square,
  iconOnly,
}: {
  item: WorkspaceRuntimeControlItem;
  isPending: boolean;
  pendingRequest: WorkspaceRuntimeControlRequest | null | undefined;
  onAction: (request: WorkspaceRuntimeControlRequest) => void;
  square?: boolean;
  iconOnly?: boolean;
}) {
  useTranslation("task-components");
  const actions: WorkspaceRuntimeAction[] =
    item.kind === "job"
      ? ["run"]
      : item.statusLabel === "running" || item.statusLabel === "starting"
        ? ["stop", ...(item.canStart ? ["restart" as const] : [])]
        : ["start"];

  return (
    <div className={cn("flex gap-2", iconOnly ? "w-auto flex-row flex-wrap" : "w-full flex-col sm:w-auto sm:flex-row sm:flex-wrap")}>
      {actions.map((action) => {
        const request = buildRequest(item, action);
        const Icon = action === "stop" ? Square : action === "restart" ? RotateCcw : Play;
        const label = action === "run"
          ? t("final-components-a:run_00d60e31")
          : action === "start"
            ? t("final-components-a:start_e4bb9f1e")
            : action === "stop"
              ? t("final-components-a:stop_cae7d57b")
              : t("final-components-a:restart_6b983a81");
        const showSpinner = isPending && requestMatchesPending(pendingRequest, request);
        const disabled =
          isPending
          || (action === "run" && !item.canRun)
          || ((action === "start" || action === "restart") && !item.canStart);

        return (
          <Button
            key={`${item.key}:${action}`}
            variant={iconOnly ? "outline" : action === "stop" ? "destructive" : action === "restart" ? "outline" : "default"}
            size={iconOnly ? "icon-xs" : "sm"}
            className={cn(
              iconOnly ? "shrink-0" : "w-full justify-start sm:w-auto",
              square ? "rounded-none" : null,
            )}
            disabled={disabled}
            onClick={() => onAction(request)}
            aria-label={label}
            title={label}
          >
            {showSpinner ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}
            {iconOnly ? <span className="sr-only">{label}</span> : label}
          </Button>
        );
      })}
    </div>
  );
}

function CommandSection({
  title,
  description,
  items,
  emptyMessage,
  disabledHint,
  isPending,
  pendingRequest,
  onAction,
  square,
  iconOnly,
}: {
  title: string;
  description: string;
  items: WorkspaceRuntimeControlItem[];
  emptyMessage: string;
  disabledHint?: string | null;
  isPending: boolean;
  pendingRequest: WorkspaceRuntimeControlRequest | null | undefined;
  onAction: (request: WorkspaceRuntimeControlRequest) => void;
  square?: boolean;
  iconOnly?: boolean;
}) {
  useTranslation("task-components");
  // Managed-sandbox-only policy: the working directory is a path on the
  // execution host, so the command rows drop it, and keep dropping it until the
  // policy is known. The URL, the port, and the command itself stay — they
  // describe the service, not the host filesystem.
  const { hideHostPaths } = useManagedSandboxOnly();
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <div className="text-sm font-medium">{title}</div>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      {items.length === 0 ? (
        <div className={cn("border border-dashed border-border/80 bg-background px-3 py-4 text-sm text-muted-foreground", square ? "rounded-none" : "rounded-xl")}>
          {emptyMessage}
          {disabledHint ? <p className="mt-2 text-xs">{disabledHint}</p> : null}
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <div key={item.key} className={cn("border border-border/80 bg-background px-3 py-3", square ? "rounded-none" : "rounded-xl")}>
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="space-y-1">
                    <div className="text-sm font-medium">{item.title}</div>
                    <div className="text-xs text-muted-foreground">
                      {item.kind} · {item.statusLabel}
                      {item.lifecycle ? ` · ${item.lifecycle}` : ""}
                    </div>
                  </div>
                  <CommandActionButtons
                    item={item}
                    isPending={isPending}
                    pendingRequest={pendingRequest}
                    onAction={onAction}
                    square={square}
                    iconOnly={iconOnly}
                  />
                </div>
                <div className="space-y-1 text-xs text-muted-foreground">
                  {item.url ? (
                    <a href={item.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:underline">
                      {item.url}
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  ) : null}
                  {item.port ? <div><Trans ns="final-components-a" i18nKey="numeric_98e1e9fb584a" values={{ port: item.port }} /></div> : null}
                  {item.command ? <div className="break-all font-mono">{item.command}</div> : null}
                  {item.cwd && !hideHostPaths ? <div className="break-all font-mono">{item.cwd}</div> : null}
                  {item.disabledReason ? <div>{item.disabledReasonKey ? t(item.disabledReasonKey) : item.disabledReason}</div> : null}
                </div>
                <ExposureFailureDetail exposure={item.exposure} />
                {item.healthStatus && item.statusLabel !== "stopped" ? (
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className={cn(
                      "px-2.5 py-1 text-(length:--text-micro)",
                      item.healthStatus === "healthy"
                        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                        : item.healthStatus === "unhealthy"
                          ? "border-destructive/30 bg-destructive/10 text-destructive"
                          : "border-border text-muted-foreground",
                    )}>
                      {item.healthStatus}
                    </Badge>
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function WorkspaceRuntimeControls({
  sections,
  isPending = false,
  pendingRequest = null,
  serviceEmptyMessage = t("final-components-a:noServicesAreConfiguredFor_ce2b2ba3"),
  jobEmptyMessage = t("final-components-a:noOneShotJobsAre_f58bf336"),
  disabledHint = null,
  onAction,
  className,
  square,
}: WorkspaceRuntimeControlsProps) {
  useTranslation("task-components");
  const runningCount = [...sections.services, ...sections.otherServices].filter(
    (item) => item.statusLabel === "running" || item.statusLabel === "starting",
  ).length;
  const visibleDisabledHint = runningCount > 0 || disabledHint === null ? null : disabledHint;

  return (
    <div className={cn("space-y-4", className)}>
      <div className={cn("border border-border/70 bg-background p-3", square ? "rounded-none" : "rounded-xl")}>
        <div className="space-y-1">
          <div className="text-xs font-medium uppercase tracking-(--tracking-eyebrow) text-muted-foreground">{t("task-components:workspaceCommands_6cc6282c")}</div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline"
              className={cn(
                "gap-1.5 px-2.5 py-1",
                runningCount > 0
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                  : "border-border bg-background text-muted-foreground",
              )}
            >
              <Activity className="h-3.5 w-3.5" />
              {runningCount > 0 ? t("task-components:servicesRunning_9e46aac7", { value1: runningCount }) : t("task-components:noServicesRunning_03916b31")}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {sections.jobs.length > 0
                ? t("task-components:jobAvailableToRunOnDemand_7e3832df", { value1: sections.jobs.length, value2: t("task-components:pluralSuffix", { count: sections.jobs.length }) })
                : t("task-components:eachCommandCanBeControlledIndependently_9a0e7981")}
            </span>
          </div>
          {visibleDisabledHint ? <p className="text-xs text-muted-foreground">{visibleDisabledHint}</p> : null}
        </div>
      </div>

      <CommandSection
        title={t("task-components:services_604dce44")}
        description={t("task-components:longRunningCommandsThatPaperclipCanSupervise_ed1be5cc")}
        items={sections.services}
        emptyMessage={serviceEmptyMessage}
        disabledHint={visibleDisabledHint}
        isPending={isPending}
        pendingRequest={pendingRequest}
        onAction={onAction}
        square={square}
      />

      <CommandSection
        title={t("task-components:jobs_2f17a0f8")}
        description={t("task-components:oneShotCommandsThatRunNowAnd_9b358ae2")}
        items={sections.jobs}
        emptyMessage={jobEmptyMessage}
        isPending={isPending}
        pendingRequest={pendingRequest}
        onAction={onAction}
        square={square}
      />

      {sections.otherServices.length > 0 ? (
        <CommandSection
          title={t("task-components:untrackedServices_87bd9a2e")}
          description={t("task-components:runningServicesThatNoLongerMatchThe_b3169d3d")}
          items={sections.otherServices}
          emptyMessage=""
          isPending={isPending}
          pendingRequest={pendingRequest}
          onAction={onAction}
          square={square}
        />
      ) : null}
    </div>
  );
}

export function WorkspaceRuntimeQuickControls({
  sections,
  isPending = false,
  pendingRequest = null,
  onAction,
  square,
  align = "end",
  iconOnly = false,
}: {
  sections: WorkspaceRuntimeControlSections;
  isPending?: boolean;
  pendingRequest?: WorkspaceRuntimeControlRequest | null;
  onAction: (request: WorkspaceRuntimeControlRequest) => void;
  square?: boolean;
  align?: "start" | "end";
  iconOnly?: boolean;
}) {
  useTranslation("task-components");
  const controlItems = sections.services.length > 0 ? sections.services : sections.otherServices;
  const serviceUrl = getRunningRuntimeServiceUrl(sections);
  const alignEnd = align === "end";

  if (controlItems.length === 0 && !serviceUrl) return null;

  return (
    <div className={cn("flex min-w-0 flex-col items-stretch gap-2", alignEnd ? "sm:items-end" : "sm:items-start")}>
      {controlItems.length > 0 ? (
        <div className={cn("flex max-w-full flex-col gap-2 sm:flex-row sm:flex-wrap", alignEnd ? "sm:justify-end" : "sm:justify-start")}>
          {controlItems.map((item) => (
            <div key={item.key} className={cn("flex min-w-0 flex-col gap-1", alignEnd ? "sm:items-end" : "sm:items-start")}>
              {controlItems.length > 1 ? (
                <span className="truncate text-xs text-muted-foreground">{item.title}</span>
              ) : null}
              <CommandActionButtons
                item={item}
                isPending={isPending}
                pendingRequest={pendingRequest}
                onAction={onAction}
                square={square}
                iconOnly={iconOnly}
              />
            </div>
          ))}
        </div>
      ) : null}
      {serviceUrl ? (
        <a
          href={serviceUrl}
          target="_blank"
          rel="noreferrer"
          className={cn(
            "inline-flex min-w-0 items-center gap-1 self-start break-all text-xs text-muted-foreground hover:text-foreground hover:underline",
            alignEnd ? "sm:self-end" : "sm:self-start",
          )}
        >
          {serviceUrl}
          <ExternalLink className="h-3.5 w-3.5 shrink-0" />
        </a>
      ) : null}
    </div>
  );
}
