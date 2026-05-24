import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  CloudUpload,
  ExternalLink,
  FileJson,
  History,
  Loader2,
  RefreshCcw,
  ShieldAlert,
} from "lucide-react";
import type { TFunction } from "i18next";
import type {
  CloudUpstreamActivationDecision,
  CloudUpstreamActivationEntityType,
  CloudUpstreamPreview,
  CloudUpstreamRun,
  CloudUpstreamStep,
} from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cloudUpstreamsApi } from "@/api/cloudUpstreams";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { applyCompanyPrefix, extractCompanyPrefixFromPath } from "@/lib/company-routes";
import { Link, useLocation } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { useTranslation } from "@/i18n";

const PENDING_CONNECTION_KEY = "paperclip-cloud-upstream-pending-connection";

function getSteps(t: TFunction): Array<{ key: CloudUpstreamStep; label: string }> {
  return [
    { key: "connect", label: t("cloudUpstream.steps.connect", { defaultValue: "Connect" }) },
    { key: "scan", label: t("cloudUpstream.steps.scan", { defaultValue: "Scan" }) },
    { key: "preview", label: t("cloudUpstream.steps.preview", { defaultValue: "Preview" }) },
    { key: "push", label: t("cloudUpstream.steps.push", { defaultValue: "Push" }) },
    { key: "verify", label: t("cloudUpstream.steps.verify", { defaultValue: "Verify" }) },
    { key: "activate", label: t("cloudUpstream.steps.activate", { defaultValue: "Activate" }) },
  ];
}

function getActivationCategories(t: TFunction): Array<{
  key: CloudUpstreamActivationEntityType;
  label: string;
  singular: string;
  detail: string;
}> {
  return [
    {
      key: "agents",
      label: t("cloudUpstream.activation.agents.label", { defaultValue: "Agents" }),
      singular: t("cloudUpstream.activation.agents.singular", { defaultValue: "agent" }),
      detail: t("cloudUpstream.activation.agents.detail", {
        defaultValue: "Confirm cloud secrets and adapter credentials before unpausing imported agents.",
      }),
    },
    {
      key: "routines",
      label: t("cloudUpstream.activation.routines.label", { defaultValue: "Routines" }),
      singular: t("cloudUpstream.activation.routines.singular", { defaultValue: "routine" }),
      detail: t("cloudUpstream.activation.routines.detail", {
        defaultValue: "Review schedules and trigger settings before enabling imported routines.",
      }),
    },
    {
      key: "monitors",
      label: t("cloudUpstream.activation.monitors.label", { defaultValue: "Monitors" }),
      singular: t("cloudUpstream.activation.monitors.singular", { defaultValue: "monitor" }),
      detail: t("cloudUpstream.activation.monitors.detail", {
        defaultValue: "Activate after the target stack has been smoke tested.",
      }),
    },
  ];
}

export function CloudUpstream() {
  const { t } = useTranslation();
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const location = useLocation();
  const [remoteUrl, setRemoteUrl] = useState("");
  const [preview, setPreview] = useState<CloudUpstreamPreview | null>(null);
  const [activeRun, setActiveRun] = useState<CloudUpstreamRun | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? t("cloudUpstream.breadcrumb.company", { defaultValue: "Company" }), href: "/dashboard" },
      { label: t("cloudUpstream.breadcrumb.settings", { defaultValue: "Settings" }), href: "/company/settings" },
      { label: t("cloudUpstream.breadcrumb.cloudUpstream", { defaultValue: "Cloud upstream" }) },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs, t]);

  const experimentalQuery = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  const cloudSyncEnabled = experimentalQuery.data?.enableCloudSync === true;

  const upstreamQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.cloudUpstreams(selectedCompanyId) : ["cloud-upstreams", "__disabled__"],
    queryFn: () => cloudUpstreamsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && cloudSyncEnabled,
  });

  const connection = upstreamQuery.data?.connections[0] ?? null;
  const latestRun = activeRun ?? upstreamQuery.data?.runs[0] ?? null;

  const callbackParams = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const code = callbackParams.get("code");
  const state = callbackParams.get("state");
  const callbackError = callbackParams.get("error");

  const settingsPath = useMemo(() => {
    const pathPrefix = extractCompanyPrefixFromPath(location.pathname);
    return applyCompanyPrefix("/company/settings/cloud-upstream", pathPrefix ?? selectedCompany?.issuePrefix ?? null);
  }, [location.pathname, selectedCompany?.issuePrefix]);

  const finishMutation = useMutation({
    mutationFn: (input: { pendingConnectionId: string; code: string; state: string }) =>
      cloudUpstreamsApi.finishConnect(input),
    onSuccess: async () => {
      localStorage.removeItem(PENDING_CONNECTION_KEY);
      setNotice(t("cloudUpstream.notice.connectionApproved", { defaultValue: "Cloud upstream connection approved." }));
      setActionError(null);
      await invalidateUpstreams();
      window.history.replaceState(null, "", settingsPath);
    },
    onError: (error) =>
      setActionError(
        error instanceof Error
          ? error.message
          : t("cloudUpstream.error.finishConnection", { defaultValue: "Failed to finish connection." }),
      ),
  });
  const {
    mutate: finishConnect,
    isError: finishConnectFailed,
    isPending: finishConnectPending,
    isSuccess: finishConnectSucceeded,
  } = finishMutation;

  useEffect(() => {
    if (!cloudSyncEnabled || !code || !state || finishConnectPending || finishConnectSucceeded || finishConnectFailed) return;
    const pendingConnectionId = localStorage.getItem(PENDING_CONNECTION_KEY);
    if (!pendingConnectionId) {
      setActionError(
        t("cloudUpstream.error.noPendingConnection", {
          defaultValue: "No pending cloud upstream connection was found. Start the connection again.",
        }),
      );
      return;
    }
    finishConnect({ pendingConnectionId, code, state });
  }, [cloudSyncEnabled, code, finishConnect, finishConnectFailed, finishConnectPending, finishConnectSucceeded, state, t]);

  useEffect(() => {
    if (callbackError) {
      setActionError(
        t("cloudUpstream.error.connectionNotApproved", {
          defaultValue: "Cloud upstream connection was not approved: {{reason}}",
          reason: callbackError,
        }),
      );
    }
  }, [callbackError, t]);

  const startMutation = useMutation({
    mutationFn: () =>
      cloudUpstreamsApi.startConnect({
        companyId: selectedCompanyId!,
        remoteUrl,
        redirectUri: `${window.location.origin}${settingsPath}`,
      }),
    onSuccess: (result) => {
      localStorage.setItem(PENDING_CONNECTION_KEY, result.pendingConnectionId);
      setActionError(null);
      window.location.assign(result.authorizationUrl);
    },
    onError: (error) =>
      setActionError(
        error instanceof Error
          ? error.message
          : t("cloudUpstream.error.startConnection", { defaultValue: "Failed to start connection." }),
      ),
  });

  const previewMutation = useMutation({
    mutationFn: (input: { connectionId: string; companyId: string }) =>
      cloudUpstreamsApi.preview(input.connectionId, { companyId: input.companyId }),
    onSuccess: (nextPreview) => {
      setPreview(nextPreview);
      setActionError(null);
    },
    onError: (error) => setActionError(previewErrorMessage(error, t)),
  });

  const runMutation = useMutation({
    mutationFn: (input: { connectionId: string; companyId: string; retryOfRunId?: string | null }) =>
      cloudUpstreamsApi.createRun(input.connectionId, {
        companyId: input.companyId,
        retryOfRunId: input.retryOfRunId ?? null,
      }),
    onSuccess: async (run) => {
      setActiveRun(run);
      setNotice(
        run.status === "succeeded"
          ? t("cloudUpstream.notice.pushSucceeded", {
              defaultValue: "Push run completed. Review activation before unpausing automations.",
            })
          : t("cloudUpstream.notice.pushFailed", {
              defaultValue: "Push run failed. Review the run events and retry after correcting the issue.",
            }),
      );
      setActionError(null);
      await invalidateUpstreams();
    },
    onError: (error) =>
      setActionError(
        error instanceof Error
          ? error.message
          : t("cloudUpstream.error.runPush", { defaultValue: "Failed to run push." }),
      ),
  });
  const activationMutation = useMutation({
    mutationFn: (input: { run: CloudUpstreamRun; entityType: CloudUpstreamActivationEntityType }) =>
      cloudUpstreamsApi.activateEntities(input.run.connectionId, input.run.id, {
        companyId: input.run.companyId,
        entityType: input.entityType,
      }),
    onSuccess: async (run) => {
      setActiveRun(run);
      setNotice(t("cloudUpstream.notice.activationUpdated", { defaultValue: "Activation checklist updated." }));
      setActionError(null);
      await invalidateUpstreams();
    },
    onError: (error) =>
      setActionError(
        error instanceof Error
          ? error.message
          : t("cloudUpstream.error.activateEntities", { defaultValue: "Failed to activate imported entities." }),
      ),
  });

  async function invalidateUpstreams() {
    if (!selectedCompanyId) return;
    await queryClient.invalidateQueries({ queryKey: queryKeys.cloudUpstreams(selectedCompanyId) });
  }

  if (!selectedCompanyId || !selectedCompany) {
    return (
      <div className="text-sm text-muted-foreground">
        {t("cloudUpstream.empty.selectCompany", { defaultValue: "Select a company to configure cloud upstream." })}
      </div>
    );
  }

  if (experimentalQuery.isLoading) {
    return (
      <div className="text-sm text-muted-foreground">
        {t("cloudUpstream.empty.loadingExperimental", { defaultValue: "Loading experimental settings..." })}
      </div>
    );
  }

  if (!cloudSyncEnabled) {
    return (
      <div className="max-w-2xl space-y-4">
        <div className="flex items-center gap-2">
          <CloudUpload className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">
            {t("cloudUpstream.heading.title", { defaultValue: "Cloud upstream" })}
          </h1>
        </div>
        <div className="rounded-md border border-border px-4 py-4 text-sm text-muted-foreground">
          {t("cloudUpstream.disabled.prefix", { defaultValue: "Cloud sync is disabled. Enable it in" })}{" "}
          <Link className="text-primary underline-offset-2 hover:underline" to="/instance/settings/experimental">
            {t("cloudUpstream.disabled.instanceSettingsLink", { defaultValue: "Instance Settings" })}
          </Link>{" "}
          {t("cloudUpstream.disabled.suffix", { defaultValue: "to show upstream connection and push tools." })}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <CloudUpload className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-lg font-semibold">
              {t("cloudUpstream.heading.title", { defaultValue: "Cloud upstream" })}
            </h1>
          </div>
          <p className="max-w-2xl text-sm text-muted-foreground">
            {t("cloudUpstream.heading.description", {
              defaultValue: "Push {{name}} into a Paperclip Cloud stack. Automations stay paused until activation.",
              name: selectedCompany.name,
            })}
          </p>
        </div>
        {connection?.target.origin ? (
          <Button variant="outline" size="sm" asChild>
            <a href={connection.target.origin} target="_blank" rel="noreferrer">
              <ExternalLink className="h-4 w-4" />
              {t("cloudUpstream.action.openCloud", { defaultValue: "Open cloud" })}
            </a>
          </Button>
        ) : null}
      </div>

      {notice ? (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
          {notice}
        </div>
      ) : null}
      {actionError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      ) : null}

      <Stepper activeStep={latestRun?.activeStep ?? (preview ? "preview" : connection?.tokenStatus === "connected" ? "scan" : "connect")} />

      <section className="space-y-3">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("cloudUpstream.section.connection", { defaultValue: "Connection" })}
        </div>
        <div className="rounded-md border border-border px-4 py-4">
          {connection ? (
            <div className="grid gap-3 lg:grid-cols-[1fr_auto] lg:items-start">
              <div>
                <div className="text-sm font-medium">
                  {connection.target.stackDisplayName ?? connection.target.stackSlug ?? connection.target.stackId}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {t("cloudUpstream.connection.meta", {
                    defaultValue: "{{product}} · {{origin}} · token {{tokenStatus}}",
                    product: connection.target.product,
                    origin: connection.target.origin,
                    tokenStatus: connection.tokenStatus,
                  })}
                </div>
                <div className="mt-2 text-xs text-muted-foreground">
                  {t("cloudUpstream.connection.schema", {
                    defaultValue: "Schema {{schemaMajor}}. Max chunk {{chunkSize}}.",
                    schemaMajor: connection.target.schemaMajor,
                    chunkSize: formatBytes(connection.target.maxChunkBytes),
                  })}
                </div>
              </div>
              <div className="flex flex-col items-end gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => previewMutation.mutate({ connectionId: connection.id, companyId: connection.companyId })}
                  disabled={previewMutation.isPending || connection.tokenStatus !== "connected"}
                >
                  {previewMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
                  {t("cloudUpstream.action.previewPush", { defaultValue: "Preview push" })}
                </Button>
                {previewMutation.isPending ? <PreviewProgressHint /> : null}
              </div>
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-[1fr_auto]">
              <Input
                value={remoteUrl}
                onChange={(event) => setRemoteUrl(event.target.value)}
                placeholder="https://paperclip.paperclip.app/PC521D/dashboard"
                aria-label={t("cloudUpstream.input.remoteUrlAria", { defaultValue: "Paperclip Cloud stack URL" })}
              />
              <Button onClick={() => startMutation.mutate()} disabled={startMutation.isPending || !remoteUrl.trim()}>
                {startMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CloudUpload className="h-4 w-4" />}
                {t("cloudUpstream.action.connect", { defaultValue: "Connect" })}
              </Button>
            </div>
          )}
        </div>
      </section>

      {preview ? (
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("cloudUpstream.section.preview", { defaultValue: "Preview" })}
            </div>
            <Button
              onClick={() => runMutation.mutate({ connectionId: preview.connectionId, companyId: preview.sourceCompanyId })}
              disabled={runMutation.isPending || !preview.schemaCompatible}
            >
              {runMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CloudUpload className="h-4 w-4" />}
              {t("cloudUpstream.action.pushToCloud", { defaultValue: "Push to cloud" })}
            </Button>
          </div>
          <SummaryGrid summary={preview.summary} />
          <WarningsPanel warnings={preview.warnings} />
          <ConflictTable conflicts={preview.conflicts} />
        </section>
      ) : null}

      {latestRun ? (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("cloudUpstream.section.progressAndFinish", { defaultValue: "Progress and finish" })}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => downloadRunReport(latestRun)}>
                <FileJson className="h-4 w-4" />
                {t("cloudUpstream.action.downloadReport", { defaultValue: "Download report" })}
              </Button>
              {latestRun.status === "failed" || latestRun.status === "cancelled" ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => runMutation.mutate({
                    connectionId: latestRun.connectionId,
                    companyId: latestRun.companyId,
                    retryOfRunId: latestRun.id,
                  })}
                  disabled={runMutation.isPending}
                >
                  <RefreshCcw className="h-4 w-4" />
                  {t("cloudUpstream.action.retry", { defaultValue: "Retry" })}
                </Button>
              ) : latestRun.status === "succeeded" ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => runMutation.mutate({ connectionId: latestRun.connectionId, companyId: latestRun.companyId })}
                  disabled={runMutation.isPending}
                >
                  <RefreshCcw className="h-4 w-4" />
                  {t("cloudUpstream.action.reRun", { defaultValue: "Re-run" })}
                </Button>
              ) : null}
            </div>
          </div>
          <div className="rounded-md border border-border px-4 py-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium capitalize">
                  {translateRunStatus(latestRun.status, t)}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {latestRun.completedAt
                    ? t("cloudUpstream.run.metaCompleted", {
                        defaultValue: "Run {{id}} · completed {{date}}",
                        id: latestRun.id.slice(0, 8),
                        date: formatDate(latestRun.completedAt),
                      })
                    : t("cloudUpstream.run.metaInProgress", {
                        defaultValue: "Run {{id}} · in progress",
                        id: latestRun.id.slice(0, 8),
                      })}
                </div>
              </div>
              <div className="text-sm tabular-nums">
                {t("cloudUpstream.run.progressPercent", {
                  defaultValue: "{{percent}}%",
                  percent: latestRun.progressPercent,
                })}
              </div>
            </div>
            <div className="mt-3 h-2 rounded-full bg-muted">
              <div className="h-2 rounded-full bg-primary" style={{ width: `${latestRun.progressPercent}%` }} />
            </div>
            <div className="mt-4 divide-y divide-border">
              {latestRun.events.map((event) => (
                <div key={event.id} className="grid gap-2 py-2 text-sm sm:grid-cols-[7rem_8rem_1fr]">
                  <span className="text-xs text-muted-foreground">{formatDate(event.at)}</span>
                  <span className="text-xs capitalize text-muted-foreground">{event.phase}</span>
                  <span>{event.message}</span>
                </div>
              ))}
            </div>
          </div>

          {latestRun.status === "succeeded" ? (
            <ActivationChecklist
              run={latestRun}
              pendingEntityType={activationMutation.variables?.entityType ?? null}
              isPending={activationMutation.isPending}
              onActivate={(entityType) => activationMutation.mutate({ run: latestRun, entityType })}
            />
          ) : null}
        </section>
      ) : null}

      {upstreamQuery.data?.runs.length ? (
        <section className="space-y-3">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <History className="h-3.5 w-3.5" />
            {t("cloudUpstream.section.history", { defaultValue: "History" })}
          </div>
          <div className="divide-y divide-border rounded-md border border-border">
            {upstreamQuery.data.runs.map((run) => (
              <button
                key={run.id}
                type="button"
                className="grid w-full gap-1 px-4 py-3 text-left text-sm hover:bg-accent/40 sm:grid-cols-[1fr_auto]"
                onClick={() => setActiveRun(run)}
              >
                <span>
                  {t("cloudUpstream.history.runLabel", {
                    defaultValue: "Run {{id}} · {{status}}",
                    id: run.id.slice(0, 8),
                    status: run.status,
                  })}
                </span>
                <span className="text-xs text-muted-foreground">{formatDate(run.createdAt)}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function PreviewProgressHint() {
  const { t } = useTranslation();
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const startedAt = Date.now();
    const interval = window.setInterval(() => setElapsed(Math.round((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(interval);
  }, []);
  const message = elapsed < 15
    ? t("cloudUpstream.preview.buildingShort", { defaultValue: "Building manifest..." })
    : elapsed < 45
      ? t("cloudUpstream.preview.buildingMedium", {
          defaultValue: "Building manifest... {{seconds}}s. Large companies can take up to a minute.",
          seconds: elapsed,
        })
      : t("cloudUpstream.preview.buildingLong", {
          defaultValue: "Still building manifest... {{seconds}}s. PAP-scale companies routinely take ~60s.",
          seconds: elapsed,
        });
  return <div className="text-xs text-muted-foreground">{message}</div>;
}

function Stepper({ activeStep }: { activeStep: CloudUpstreamStep }) {
  const { t } = useTranslation();
  const steps = getSteps(t);
  const activeIndex = steps.findIndex((step) => step.key === activeStep);
  return (
    <div className="grid gap-2 rounded-md border border-border px-3 py-3 sm:grid-cols-6">
      {steps.map((step, index) => {
        const complete = index < activeIndex;
        const active = index === activeIndex;
        return (
          <div key={step.key} className="flex items-center gap-2 text-xs">
            {complete ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            ) : (
              <span className={active ? "h-4 w-4 rounded-full border-2 border-primary" : "h-4 w-4 rounded-full border border-border"} />
            )}
            <span className={active ? "font-medium text-foreground" : "text-muted-foreground"}>{step.label}</span>
          </div>
        );
      })}
    </div>
  );
}

function SummaryGrid({ summary }: { summary: CloudUpstreamPreview["summary"] }) {
  return (
    <div className="grid gap-2 sm:grid-cols-4">
      {summary.map((item) => (
        <div key={item.key} className="rounded-md border border-border px-3 py-2">
          <div className="text-lg font-semibold tabular-nums">{item.count}</div>
          <div className="text-xs text-muted-foreground">{item.label}</div>
        </div>
      ))}
    </div>
  );
}

function WarningsPanel({ warnings }: { warnings: CloudUpstreamPreview["warnings"] }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-md border border-border px-4 py-3">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">
        <ShieldAlert className="h-4 w-4 text-muted-foreground" />
        {t("cloudUpstream.preview.warnings", { defaultValue: "Warnings" })}
      </div>
      <div className="divide-y divide-border">
        {warnings.map((warning) => (
          <div key={warning.code} className="grid gap-2 py-2 sm:grid-cols-[1.25rem_12rem_1fr]">
            <AlertTriangle className={warning.severity === "blocker" ? "h-4 w-4 text-destructive" : "h-4 w-4 text-amber-600"} />
            <div className="text-sm font-medium">{warning.title}</div>
            <div className="text-sm text-muted-foreground">{warning.detail}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ConflictTable({ conflicts }: { conflicts: CloudUpstreamPreview["conflicts"] }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-md border border-border px-4 py-3">
      <div className="mb-2 text-sm font-medium">
        {t("cloudUpstream.preview.conflicts", { defaultValue: "Conflicts" })}
      </div>
      {conflicts.length === 0 ? (
        <div className="text-sm text-muted-foreground">
          {t("cloudUpstream.preview.noConflicts", { defaultValue: "No target conflicts detected for this preview." })}
        </div>
      ) : (
        <div className="divide-y divide-border">
          {conflicts.map((conflict) => (
            <div key={conflict.id} className="grid gap-2 py-2 text-sm sm:grid-cols-[8rem_1fr_1fr_8rem]">
              <span className="text-muted-foreground">{conflict.entityType}</span>
              <span>{conflict.sourceLabel}</span>
              <span>{conflict.targetLabel}</span>
              <span className="capitalize">{conflict.plannedAction}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ActivationChecklist({
  run,
  pendingEntityType,
  isPending,
  onActivate,
}: {
  run: CloudUpstreamRun;
  pendingEntityType: CloudUpstreamActivationEntityType | null;
  isPending: boolean;
  onActivate: (entityType: CloudUpstreamActivationEntityType) => void;
}) {
  const { t } = useTranslation();
  const rows = buildActivationRows(run, t);
  return (
    <div className="rounded-md border border-border px-4 py-3">
      <div className="mb-2 text-sm font-medium">
        {t("cloudUpstream.activation.checklistTitle", { defaultValue: "Activation checklist" })}
      </div>
      <div className="divide-y divide-border">
        {rows.map((row) => {
          const pending = isPending && pendingEntityType === row.key;
          const activated = row.status === "activated";
          return (
            <div key={row.key} className="grid gap-2 py-2 text-sm sm:grid-cols-[8rem_1fr_auto] sm:items-center">
              <div>
                <div className="font-medium">{row.label}</div>
                <div className="text-xs text-muted-foreground">{row.statusLabel}</div>
              </div>
              <div className="text-muted-foreground">
                {row.count === 0
                  ? t("cloudUpstream.activation.noneImported", {
                      defaultValue: "0 imported {{plural}} in this run.",
                      plural: row.pluralLabel,
                    })
                  : row.detail}
              </div>
              <div className="flex flex-wrap gap-2 sm:justify-end">
                <Button
                  variant={activated ? "secondary" : "default"}
                  size="sm"
                  onClick={() => onActivate(row.key)}
                  disabled={row.count === 0 || activated || isPending}
                >
                  {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {activated
                    ? t("cloudUpstream.activation.activatedButton", { defaultValue: "Activated" })
                    : t("cloudUpstream.activation.activateButton", { defaultValue: "Activate" })}
                </Button>
                <Button variant="ghost" size="sm" disabled={activated || isPending}>
                  {t("cloudUpstream.activation.keepPausedButton", { defaultValue: "Keep paused" })}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function buildActivationRows(run: CloudUpstreamRun, t: TFunction = fallbackT as unknown as TFunction) {
  const activationChecklist = activationChecklistFromReport(run.report);
  const categories = getActivationCategories(t);
  return categories.map((category) => {
    const decision = activationChecklist[category.key];
    const count = summaryCount(run.summary, category.key);
    const status = decision?.status === "activated" ? "activated" : "paused";
    const pluralLabel = count === 1 ? category.singular : `${category.singular}s`;
    return {
      ...category,
      count,
      pluralLabel,
      status,
      detail: t("cloudUpstream.activation.rowDetail", {
        defaultValue: "{{count}} imported {{plural}} are paused by default. {{detail}}",
        count,
        plural: pluralLabel,
        detail: category.detail,
      }),
      statusLabel: status === "activated"
        ? t("cloudUpstream.activation.statusActivated", {
            defaultValue: "{{count}} activated",
            count,
          })
        : count === 0
          ? t("cloudUpstream.activation.statusNoneImported", { defaultValue: "0 imported" })
          : t("cloudUpstream.activation.statusPaused", {
              defaultValue: "{{count}} paused",
              count,
            }),
    };
  });
}

function fallbackT(_key: string, options?: { defaultValue?: string; [key: string]: unknown }): string {
  if (!options || typeof options.defaultValue !== "string") return _key;
  return options.defaultValue.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
    const value = options[name];
    return value === undefined || value === null ? "" : String(value);
  });
}

function translateRunStatus(status: CloudUpstreamRun["status"], t: TFunction): string {
  switch (status) {
    case "succeeded":
      return t("cloudUpstream.run.status.succeeded", { defaultValue: "Succeeded" });
    case "failed":
      return t("cloudUpstream.run.status.failed", { defaultValue: "Failed" });
    case "cancelled":
      return t("cloudUpstream.run.status.cancelled", { defaultValue: "Cancelled" });
    case "running":
      return t("cloudUpstream.run.status.running", { defaultValue: "Running" });
    case "previewed":
      return t("cloudUpstream.run.status.previewed", { defaultValue: "Previewed" });
    default:
      return status;
  }
}

function summaryCount(summary: CloudUpstreamRun["summary"], key: CloudUpstreamActivationEntityType): number {
  return summary.find((item) => item.key === key)?.count ?? 0;
}

function activationChecklistFromReport(report: CloudUpstreamRun["report"]): Partial<Record<CloudUpstreamActivationEntityType, CloudUpstreamActivationDecision>> {
  const value = optionalRecord(report.activationChecklist);
  const decisions: Partial<Record<CloudUpstreamActivationEntityType, CloudUpstreamActivationDecision>> = {};
  for (const key of ["agents", "routines", "monitors"] as const) {
    const item = optionalRecord(value[key]);
    if (!item) continue;
    decisions[key] = {
      entityType: key,
      count: typeof item.count === "number" ? item.count : 0,
      status: item.status === "activated" ? "activated" : "paused",
      activatedAt: typeof item.activatedAt === "string" ? item.activatedAt : null,
    };
  }
  return decisions;
}

function optionalRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function downloadRunReport(run: CloudUpstreamRun) {
  const blob = new Blob([JSON.stringify(run.report, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `cloud-upstream-run-${run.id}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function formatDate(value: string) {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatBytes(value: number) {
  if (value >= 1024 * 1024) return `${Math.round(value / (1024 * 1024))} MiB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KiB`;
  return `${value} B`;
}

function previewErrorMessage(error: unknown, t: TFunction): string {
  const code = error instanceof Error ? error.message : null;
  if (code === "payload_too_large" || code === "bad_request") {
    return t("cloudUpstream.error.previewTooLarge", {
      defaultValue: "Local company is too large to preview as a single request. Click Push to continue (the Push step uploads in chunks), or see the docs for chunked-preview options.",
    });
  }
  return code ?? t("cloudUpstream.error.previewPush", { defaultValue: "Failed to preview push." });
}
