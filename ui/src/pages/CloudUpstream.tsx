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
import type {
  CloudUpstreamActivationDecision,
  CloudUpstreamActivationEntityType,
  CloudUpstreamPreview,
  CloudUpstreamRun,
  CloudUpstreamStep,
} from "@valadrien-os/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cloudUpstreamsApi } from "@/api/cloudUpstreams";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { applyCompanyPrefix, extractCompanyPrefixFromPath } from "@/lib/company-routes";
import { Link, useLocation } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";

const PENDING_CONNECTION_KEY = "valadrien-os-cloud-upstream-pending-connection";
const STEPS: Array<{ key: CloudUpstreamStep; label: string }> = [
  { key: "connect", label: "Connect" },
  { key: "scan", label: "Scan" },
  { key: "preview", label: "Preview" },
  { key: "push", label: "Push" },
  { key: "verify", label: "Verify" },
  { key: "activate", label: "Activate" },
];
const ACTIVATION_CATEGORIES: Array<{
  key: CloudUpstreamActivationEntityType;
  label: string;
  singular: string;
  detail: string;
}> = [
  {
    key: "agents",
    label: "Agents",
    singular: "agent",
    detail: "Confirm cloud secrets and adapter credentials before unpausing imported agents.",
  },
  {
    key: "routines",
    label: "Routines",
    singular: "routine",
    detail: "Review schedules and trigger settings before enabling imported routines.",
  },
  {
    key: "monitors",
    label: "Monitors",
    singular: "monitor",
    detail: "Activate after the target stack has been smoke tested.",
  },
];

export function CloudUpstream() {
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
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings", href: "/company/settings" },
      { label: "Cloud upstream" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

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
      setNotice("Cloud upstream connection approved.");
      setActionError(null);
      await invalidateUpstreams();
      window.history.replaceState(null, "", settingsPath);
    },
    onError: (error) => setActionError(error instanceof Error ? error.message : "Failed to finish connection."),
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
      setActionError("No pending cloud upstream connection was found. Start the connection again.");
      return;
    }
    finishConnect({ pendingConnectionId, code, state });
  }, [cloudSyncEnabled, code, finishConnect, finishConnectFailed, finishConnectPending, finishConnectSucceeded, state]);

  useEffect(() => {
    if (callbackError) {
      setActionError(`Cloud upstream connection was not approved: ${callbackError}`);
    }
  }, [callbackError]);

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
    onError: (error) => setActionError(error instanceof Error ? error.message : "Failed to start connection."),
  });

  const previewMutation = useMutation({
    mutationFn: (input: { connectionId: string; companyId: string }) =>
      cloudUpstreamsApi.preview(input.connectionId, { companyId: input.companyId }),
    onSuccess: (nextPreview) => {
      setPreview(nextPreview);
      setActionError(null);
    },
    onError: (error) => setActionError(previewErrorMessage(error)),
  });

  const runMutation = useMutation({
    mutationFn: (input: { connectionId: string; companyId: string; retryOfRunId?: string | null }) =>
      cloudUpstreamsApi.createRun(input.connectionId, {
        companyId: input.companyId,
        retryOfRunId: input.retryOfRunId ?? null,
      }),
    onSuccess: async (run) => {
      setActiveRun(run);
      setNotice(run.status === "succeeded"
        ? "Push run completed. Review activation before unpausing automations."
        : "Push run failed. Review the run events and retry after correcting the issue.");
      setActionError(null);
      await invalidateUpstreams();
    },
    onError: (error) => setActionError(error instanceof Error ? error.message : "Failed to run push."),
  });
  const activationMutation = useMutation({
    mutationFn: (input: { run: CloudUpstreamRun; entityType: CloudUpstreamActivationEntityType }) =>
      cloudUpstreamsApi.activateEntities(input.run.connectionId, input.run.id, {
        companyId: input.run.companyId,
        entityType: input.entityType,
      }),
    onSuccess: async (run) => {
      setActiveRun(run);
      setNotice("Activation checklist updated.");
      setActionError(null);
      await invalidateUpstreams();
    },
    onError: (error) => setActionError(error instanceof Error ? error.message : "Failed to activate imported entities."),
  });

  async function invalidateUpstreams() {
    if (!selectedCompanyId) return;
    await queryClient.invalidateQueries({ queryKey: queryKeys.cloudUpstreams(selectedCompanyId) });
  }

  if (!selectedCompanyId || !selectedCompany) {
    return <div className="text-sm text-muted-foreground">Select a company to configure cloud upstream.</div>;
  }

  if (experimentalQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading experimental settings...</div>;
  }

  if (!cloudSyncEnabled) {
    return (
      <div className="max-w-2xl space-y-4">
        <div className="flex items-center gap-2">
          <CloudUpload className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Cloud upstream</h1>
        </div>
        <div className="rounded-md border border-border px-4 py-4 text-sm text-muted-foreground">
          Cloud sync is disabled. Enable it in{" "}
          <Link className="text-primary underline-offset-2 hover:underline" to="/instance/settings/experimental">
            Instance Settings
          </Link>{" "}
          to show upstream connection and push tools.
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
            <h1 className="text-lg font-semibold">Cloud upstream</h1>
          </div>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Push {selectedCompany.name} into a ValadrienOs Cloud stack. Automations stay paused until activation.
          </p>
        </div>
        {connection?.target.origin ? (
          <Button variant="outline" size="sm" asChild>
            <a href={connection.target.origin} target="_blank" rel="noreferrer">
              <ExternalLink className="h-4 w-4" />
              Open cloud
            </a>
          </Button>
        ) : null}
      </div>

      {notice ? (
        <div className="rounded-md border border-status-success/30 bg-status-success/10 px-3 py-2 text-sm text-status-success">
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
        <div className="font-mono text-[10.5px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Connection</div>
        <div className="rounded-md border border-border px-4 py-4">
          {connection ? (
            <div className="grid gap-3 lg:grid-cols-[1fr_auto] lg:items-start">
              <div>
                <div className="text-sm font-medium">
                  {connection.target.stackDisplayName ?? connection.target.stackSlug ?? connection.target.stackId}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {connection.target.product} · {connection.target.origin} · token {connection.tokenStatus}
                </div>
                <div className="mt-2 text-xs text-muted-foreground">
                  Schema {connection.target.schemaMajor}. Max chunk {formatBytes(connection.target.maxChunkBytes)}.
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
                  Preview push
                </Button>
                {previewMutation.isPending ? <PreviewProgressHint /> : null}
              </div>
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-[1fr_auto]">
              <Input
                value={remoteUrl}
                onChange={(event) => setRemoteUrl(event.target.value)}
                placeholder="https://valadrien-os.valadrien-os.app/PC521D/dashboard"
                aria-label="ValadrienOs Cloud stack URL"
              />
              <Button onClick={() => startMutation.mutate()} disabled={startMutation.isPending || !remoteUrl.trim()}>
                {startMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CloudUpload className="h-4 w-4" />}
                Connect
              </Button>
            </div>
          )}
        </div>
      </section>

      {preview ? (
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="font-mono text-[10.5px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Preview</div>
            <Button
              onClick={() => runMutation.mutate({ connectionId: preview.connectionId, companyId: preview.sourceCompanyId })}
              disabled={runMutation.isPending || !preview.schemaCompatible}
            >
              {runMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CloudUpload className="h-4 w-4" />}
              Push to cloud
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
            <div className="font-mono text-[10.5px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Progress and finish</div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => downloadRunReport(latestRun)}>
                <FileJson className="h-4 w-4" />
                Download report
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
                  Retry
                </Button>
              ) : latestRun.status === "succeeded" ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => runMutation.mutate({ connectionId: latestRun.connectionId, companyId: latestRun.companyId })}
                  disabled={runMutation.isPending}
                >
                  <RefreshCcw className="h-4 w-4" />
                  Re-run
                </Button>
              ) : null}
            </div>
          </div>
          <div className="rounded-md border border-border px-4 py-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium capitalize">{latestRun.status}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Run {latestRun.id.slice(0, 8)} · {latestRun.completedAt ? `completed ${formatDate(latestRun.completedAt)}` : "in progress"}
                </div>
              </div>
              <div className="text-sm tabular-nums">{latestRun.progressPercent}%</div>
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
          <div className="flex items-center gap-2 font-mono text-[10.5px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            <History className="h-3.5 w-3.5" />
            History
          </div>
          <div className="divide-y divide-border rounded-md border border-border">
            {upstreamQuery.data.runs.map((run) => (
              <button
                key={run.id}
                type="button"
                className="grid w-full gap-1 px-4 py-3 text-left text-sm hover:bg-accent/40 sm:grid-cols-[1fr_auto]"
                onClick={() => setActiveRun(run)}
              >
                <span>Run {run.id.slice(0, 8)} · {run.status}</span>
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
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const startedAt = Date.now();
    const interval = window.setInterval(() => setElapsed(Math.round((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(interval);
  }, []);
  const message = elapsed < 15
    ? "Building manifest..."
    : elapsed < 45
      ? `Building manifest... ${elapsed}s. Large companies can take up to a minute.`
      : `Still building manifest... ${elapsed}s. PAP-scale companies routinely take ~60s.`;
  return <div className="text-xs text-muted-foreground">{message}</div>;
}

function Stepper({ activeStep }: { activeStep: CloudUpstreamStep }) {
  const activeIndex = STEPS.findIndex((step) => step.key === activeStep);
  return (
    <div className="grid gap-2 rounded-md border border-border px-3 py-3 sm:grid-cols-6">
      {STEPS.map((step, index) => {
        const complete = index < activeIndex;
        const active = index === activeIndex;
        return (
          <div key={step.key} className="flex items-center gap-2 text-xs">
            {complete ? (
              <CheckCircle2 className="h-4 w-4 text-status-success" />
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
  return (
    <div className="rounded-md border border-border px-4 py-3">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">
        <ShieldAlert className="h-4 w-4 text-muted-foreground" />
        Warnings
      </div>
      <div className="divide-y divide-border">
        {warnings.map((warning) => (
          <div key={warning.code} className="grid gap-2 py-2 sm:grid-cols-[1.25rem_12rem_1fr]">
            <AlertTriangle className={warning.severity === "blocker" ? "h-4 w-4 text-destructive" : "h-4 w-4 text-status-warning"} />
            <div className="text-sm font-medium">{warning.title}</div>
            <div className="text-sm text-muted-foreground">{warning.detail}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ConflictTable({ conflicts }: { conflicts: CloudUpstreamPreview["conflicts"] }) {
  return (
    <div className="rounded-md border border-border px-4 py-3">
      <div className="mb-2 text-sm font-medium">Conflicts</div>
      {conflicts.length === 0 ? (
        <div className="text-sm text-muted-foreground">No target conflicts detected for this preview.</div>
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
  const rows = buildActivationRows(run);
  return (
    <div className="rounded-md border border-border px-4 py-3">
      <div className="mb-2 text-sm font-medium">Activation checklist</div>
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
                {row.count === 0 ? `0 imported ${row.pluralLabel} in this run.` : row.detail}
              </div>
              <div className="flex flex-wrap gap-2 sm:justify-end">
                <Button
                  variant={activated ? "secondary" : "default"}
                  size="sm"
                  onClick={() => onActivate(row.key)}
                  disabled={row.count === 0 || activated || isPending}
                >
                  {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {activated ? "Activated" : "Activate"}
                </Button>
                <Button variant="ghost" size="sm" disabled={activated || isPending}>
                  Keep paused
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function buildActivationRows(run: CloudUpstreamRun) {
  const activationChecklist = activationChecklistFromReport(run.report);
  return ACTIVATION_CATEGORIES.map((category) => {
    const decision = activationChecklist[category.key];
    const count = summaryCount(run.summary, category.key);
    const status = decision?.status === "activated" ? "activated" : "paused";
    const pluralLabel = `${category.singular}${count === 1 ? "" : "s"}`;
    return {
      ...category,
      count,
      pluralLabel,
      status,
      detail: `${count} imported ${pluralLabel} are paused by default. ${category.detail}`,
      statusLabel: status === "activated"
        ? `${count} activated`
        : count === 0
          ? "0 imported"
          : `${count} paused`,
    };
  });
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

function previewErrorMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : null;
  if (code === "payload_too_large" || code === "bad_request") {
    return "Local company is too large to preview as a single request. Click Push to continue (the Push step uploads in chunks), or see the docs for chunked-preview options.";
  }
  return code ?? "Failed to preview push.";
}
