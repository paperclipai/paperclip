import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, FlaskConical, Heart, Play, Search } from "lucide-react";
import type {
  IssueGraphLivenessAutoRecoveryPreview,
  PatchInstanceExperimentalSettings,
} from "@paperclipai/shared";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { instanceExperimentalPage } from "@/lib/i18n";

function issueHref(identifier: string | null, issueId: string) {
  if (!identifier) return `/issues/${issueId}`;
  const prefix = identifier.split("-")[0] || "PAP";
  return `/${prefix}/issues/${identifier}`;
}

function formatRecoveryState(state: string) {
  return state.replace(/_/g, " ");
}

function RecoveryPreviewDialog({
  preview,
  open,
  onOpenChange,
  onEnableOnly,
  onEnableAndRun,
  isPending,
}: {
  preview: IssueGraphLivenessAutoRecoveryPreview | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEnableOnly: () => void;
  onEnableAndRun: () => void;
  isPending: boolean;
}) {
  const count = preview?.recoverableFindings ?? 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{instanceExperimentalPage.recoveryDialogTitle}</DialogTitle>
          <DialogDescription>
            {preview
              ? instanceExperimentalPage.recoveryDialogDesc(count, preview.lookbackHours)
              : instanceExperimentalPage.recoveryDialogChecking}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[min(28rem,65vh)] space-y-3 overflow-y-auto pr-1">
          {preview && preview.items.length === 0 ? (
            <div className="rounded-md border border-border bg-muted/30 px-3 py-4 text-sm text-muted-foreground">
              {instanceExperimentalPage.recoveryEmptyState}
            </div>
          ) : null}

          {preview?.items.map((item) => (
            <div key={item.incidentKey} className="rounded-md border border-border bg-card px-3 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <a
                  href={issueHref(item.identifier, item.issueId)}
                  className="text-sm font-medium text-primary underline-offset-2 hover:underline"
                >
                  {item.identifier ?? item.issueId}
                </a>
                <span className="rounded-sm bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                  {formatRecoveryState(item.state)}
                </span>
              </div>
              <p className="mt-1 text-sm text-foreground">{item.title}</p>
              <p className="mt-1 text-xs text-muted-foreground">{item.reason}</p>
              <div className="mt-2 text-xs text-muted-foreground">
                {instanceExperimentalPage.recoveryTargetPrefix}{" "}
                <a
                  href={issueHref(item.recoveryIdentifier, item.recoveryIssueId)}
                  className="text-primary underline-offset-2 hover:underline"
                >
                  {item.recoveryIdentifier ?? item.recoveryIssueId}
                </a>
              </div>
            </div>
          ))}
        </div>

        {preview && preview.skippedOutsideLookback > 0 ? (
          <p className="text-xs text-muted-foreground">
            {instanceExperimentalPage.recoverySkipped(preview.skippedOutsideLookback)}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            {instanceExperimentalPage.cancel}
          </Button>
          <Button variant="outline" onClick={onEnableOnly} disabled={isPending || !preview}>
            {instanceExperimentalPage.enableOnly}
          </Button>
          <Button onClick={onEnableAndRun} disabled={isPending || !preview}>
            {count > 0 ? instanceExperimentalPage.enableAndCreate(count) : instanceExperimentalPage.enable}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function InstanceExperimentalSettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [lookbackHoursDraft, setLookbackHoursDraft] = useState("24");
  const [previewDialogOpen, setPreviewDialogOpen] = useState(false);
  const [pendingPreview, setPendingPreview] = useState<IssueGraphLivenessAutoRecoveryPreview | null>(null);
  const [timerRolesDraft, setTimerRolesDraft] = useState("ceo, cto");
  const [timerIntervalDraft, setTimerIntervalDraft] = useState("300");
  const [timerDefaultOnDraft, setTimerDefaultOnDraft] = useState(true);

  useEffect(() => {
    setBreadcrumbs([
      { label: "实例设置" },
      { label: instanceExperimentalPage.breadcrumbExperimental },
    ]);
  }, [setBreadcrumbs]);

  const experimentalQuery = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });

  const toggleMutation = useMutation({
    mutationFn: async (patch: PatchInstanceExperimentalSettings) =>
      instanceSettingsApi.updateExperimental(patch),
    onSuccess: async () => {
      setActionError(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.instance.experimentalSettings }),
        queryClient.invalidateQueries({ queryKey: queryKeys.health }),
      ]);
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : instanceExperimentalPage.errorUpdateFallback);
    },
  });

  const previewMutation = useMutation({
    mutationFn: async (lookbackHours: number) =>
      instanceSettingsApi.previewIssueGraphLivenessAutoRecovery({ lookbackHours }),
    onSuccess: (preview) => {
      setActionError(null);
      setPendingPreview(preview);
      setPreviewDialogOpen(true);
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to preview recovery tasks.");
    },
  });

  const runRecoveryMutation = useMutation({
    mutationFn: async (lookbackHours: number) =>
      instanceSettingsApi.runIssueGraphLivenessAutoRecovery({ lookbackHours }),
    onSuccess: async () => {
      setActionError(null);
      setPreviewDialogOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.instance.experimentalSettings }),
        queryClient.invalidateQueries({ queryKey: queryKeys.health }),
      ]);
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to create recovery tasks.");
    },
  });

  useEffect(() => {
    const next = experimentalQuery.data?.issueGraphLivenessAutoRecoveryLookbackHours;
    if (typeof next === "number") {
      setLookbackHoursDraft(String(next));
    }
  }, [experimentalQuery.data?.issueGraphLivenessAutoRecoveryLookbackHours]);

  useEffect(() => {
    const d = experimentalQuery.data;
    if (!d) return;
    setTimerRolesDraft(d.timerHeartbeatEligibleAgentRoles.join(", "));
    setTimerIntervalDraft(String(d.defaultTimerHeartbeatIntervalSec));
    setTimerDefaultOnDraft(d.enableTimerHeartbeatByDefaultForEligibleRoles);
  }, [experimentalQuery.data]);

  if (experimentalQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">{instanceExperimentalPage.loading}</div>;
  }

  if (experimentalQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {experimentalQuery.error instanceof Error
          ? experimentalQuery.error.message
          : instanceExperimentalPage.errorLoading}
      </div>
    );
  }

  const enableEnvironments = experimentalQuery.data?.enableEnvironments === true;
  const enableIsolatedWorkspaces = experimentalQuery.data?.enableIsolatedWorkspaces === true;
  const autoRestartDevServerWhenIdle = experimentalQuery.data?.autoRestartDevServerWhenIdle === true;
  const enableIssueGraphLivenessAutoRecovery =
    experimentalQuery.data?.enableIssueGraphLivenessAutoRecovery === true;
  const lookbackHours =
    experimentalQuery.data?.issueGraphLivenessAutoRecoveryLookbackHours ?? 24;
  const parsedLookbackHours = Number.parseInt(lookbackHoursDraft, 10);
  const lookbackHoursIsValid =
    Number.isInteger(parsedLookbackHours) && parsedLookbackHours >= 1 && parsedLookbackHours <= 720;
  const recoveryActionPending =
    toggleMutation.isPending || previewMutation.isPending || runRecoveryMutation.isPending;

  function previewForEnable() {
    if (!lookbackHoursIsValid) {
      setActionError(instanceExperimentalPage.errorLookbackRange);
      return;
    }
    previewMutation.mutate(parsedLookbackHours);
  }

  function enableOnly() {
    if (!lookbackHoursIsValid) return;
    toggleMutation.mutate({
      enableIssueGraphLivenessAutoRecovery: true,
      issueGraphLivenessAutoRecoveryLookbackHours: parsedLookbackHours,
    }, {
      onSuccess: () => setPreviewDialogOpen(false),
    });
  }

  function enableAndRun() {
    if (!lookbackHoursIsValid) return;
    toggleMutation.mutate({
      enableIssueGraphLivenessAutoRecovery: true,
      issueGraphLivenessAutoRecoveryLookbackHours: parsedLookbackHours,
    }, {
      onSuccess: () => runRecoveryMutation.mutate(parsedLookbackHours),
    });
  }

  return (
    <div className="max-w-4xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <FlaskConical className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">{instanceExperimentalPage.title}</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          {instanceExperimentalPage.subtitle}
        </p>
      </div>

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      )}

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{instanceExperimentalPage.enableEnvironmentsTitle}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {instanceExperimentalPage.enableEnvironmentsDesc}
            </p>
          </div>
          <ToggleSwitch
            checked={enableEnvironments}
            onCheckedChange={() => toggleMutation.mutate({ enableEnvironments: !enableEnvironments })}
            disabled={toggleMutation.isPending}
            aria-label="Toggle environments experimental setting"
          />
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{instanceExperimentalPage.enableIsolatedWorkspacesTitle}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {instanceExperimentalPage.enableIsolatedWorkspacesDesc}
            </p>
          </div>
          <ToggleSwitch
            checked={enableIsolatedWorkspaces}
            onCheckedChange={() => toggleMutation.mutate({ enableIsolatedWorkspaces: !enableIsolatedWorkspaces })}
            disabled={toggleMutation.isPending}
            aria-label="Toggle isolated workspaces experimental setting"
          />
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{instanceExperimentalPage.autoRestartDevServerTitle}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {instanceExperimentalPage.autoRestartDevServerDesc}
            </p>
          </div>
          <ToggleSwitch
            checked={autoRestartDevServerWhenIdle}
            onCheckedChange={() => toggleMutation.mutate({ autoRestartDevServerWhenIdle: !autoRestartDevServerWhenIdle })}
            disabled={toggleMutation.isPending}
            aria-label="Toggle guarded dev-server auto-restart"
          />
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start gap-2 mb-3">
          <Heart className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{instanceExperimentalPage.timerHeartbeatTitle}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {instanceExperimentalPage.timerHeartbeatDesc}
            </p>
          </div>
        </div>
        <div className="grid gap-4 sm:max-w-xl">
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">{instanceExperimentalPage.eligibleRolesLabel}</span>
            <Input
              value={timerRolesDraft}
              onChange={(e) => setTimerRolesDraft(e.target.value)}
              placeholder="ceo, cto"
              disabled={toggleMutation.isPending}
            />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">{instanceExperimentalPage.intervalLabel}</span>
            <Input
              type="number"
              min={30}
              max={86400}
              step={1}
              value={timerIntervalDraft}
              onChange={(e) => setTimerIntervalDraft(e.target.value)}
              disabled={toggleMutation.isPending}
            />
          </label>
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <p className="text-sm font-medium">{instanceExperimentalPage.enableByDefault}</p>
              <p className="text-xs text-muted-foreground">
                {instanceExperimentalPage.enableByDefaultDesc}
              </p>
            </div>
            <ToggleSwitch
              checked={timerDefaultOnDraft}
              onCheckedChange={setTimerDefaultOnDraft}
              disabled={toggleMutation.isPending}
              aria-label="Toggle default timer heartbeat for eligible roles"
            />
          </div>
          <Button
            onClick={() => {
              const roles = timerRolesDraft
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
              const interval = Number.parseInt(timerIntervalDraft, 10);
              if (roles.length === 0) {
                setActionError(instanceExperimentalPage.errorAtLeastOneRole);
                return;
              }
              if (!Number.isFinite(interval) || interval < 30 || interval > 86400) {
                setActionError(instanceExperimentalPage.errorIntervalRange);
                return;
              }
              toggleMutation.mutate({
                timerHeartbeatEligibleAgentRoles: roles,
                defaultTimerHeartbeatIntervalSec: interval,
                enableTimerHeartbeatByDefaultForEligibleRoles: timerDefaultOnDraft,
              });
            }}
            disabled={toggleMutation.isPending}
          >
            {instanceExperimentalPage.saveTimerPolicy}
          </Button>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex flex-col gap-5">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1.5">
              <h2 className="text-sm font-semibold">{instanceExperimentalPage.autoRecoveryTitle}</h2>
              <p className="max-w-2xl text-sm text-muted-foreground">
                {instanceExperimentalPage.autoRecoveryDesc}
              </p>
            </div>
            <ToggleSwitch
              checked={enableIssueGraphLivenessAutoRecovery}
              onCheckedChange={() => {
                if (enableIssueGraphLivenessAutoRecovery) {
                  toggleMutation.mutate({ enableIssueGraphLivenessAutoRecovery: false });
                  return;
                }
                previewForEnable();
              }}
              disabled={recoveryActionPending}
              aria-label="Toggle issue graph liveness auto-recovery"
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-[minmax(10rem,14rem)_1fr] sm:items-end">
            <label className="space-y-1.5">
              <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Clock className="h-3.5 w-3.5" />
                {instanceExperimentalPage.lookbackHours}
              </span>
              <Input
                type="number"
                min={1}
                max={720}
                step={1}
                value={lookbackHoursDraft}
                onChange={(event) => setLookbackHoursDraft(event.target.value)}
                aria-invalid={!lookbackHoursIsValid}
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  if (!lookbackHoursIsValid) {
                    setActionError(instanceExperimentalPage.errorLookbackRange);
                    return;
                  }
                  toggleMutation.mutate({
                    issueGraphLivenessAutoRecoveryLookbackHours: parsedLookbackHours,
                  });
                }}
                disabled={recoveryActionPending || parsedLookbackHours === lookbackHours}
              >
                {instanceExperimentalPage.saveHours}
              </Button>
              <Button
                variant="outline"
                onClick={previewForEnable}
                disabled={recoveryActionPending}
              >
                <Search className="h-4 w-4" />
                {instanceExperimentalPage.preview}
              </Button>
              <Button
                onClick={() => {
                  if (!lookbackHoursIsValid) {
                    setActionError(instanceExperimentalPage.errorLookbackRange);
                    return;
                  }
                  runRecoveryMutation.mutate(parsedLookbackHours);
                }}
                disabled={recoveryActionPending || !enableIssueGraphLivenessAutoRecovery}
              >
                <Play className="h-4 w-4" />
                {instanceExperimentalPage.runNow}
              </Button>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            {instanceExperimentalPage.currentWindow(lookbackHours)}
          </p>
        </div>
      </section>

      <RecoveryPreviewDialog
        open={previewDialogOpen}
        onOpenChange={setPreviewDialogOpen}
        preview={pendingPreview}
        onEnableOnly={enableOnly}
        onEnableAndRun={enableAndRun}
        isPending={recoveryActionPending}
      />
    </div>
  );
}
