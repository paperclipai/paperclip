import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Clock, FlaskConical, Play, Search } from "lucide-react";
import type {
  InstanceExperimentalSettings,
  IssueGraphLivenessAutoRecoveryPreview,
  PatchInstanceExperimentalSettings,
} from "@paperclipai/shared";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { getWorktreeInstanceId, isWorktreeRuntime } from "../lib/worktree-branding";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

function issueHref(identifier: string | null, issueId: string) {
  if (!identifier) return `/issues/${issueId}`;
  const prefix = identifier.split("-")[0] || "PAP";
  return `/${prefix}/issues/${identifier}`;
}

function formatRecoveryState(state: string) {
  return state.replace(/_/g, " ");
}

type WorktreeRunExecutionDisplayState =
  | { kind: "off" }
  | { kind: "armed"; activatedAt: string }
  | { kind: "fail_closed"; reason: "missing_cutoff" | "missing_instance_id" | "instance_mismatch" };

/**
 * Mirror of the server's `resolveWorktreeRunExecutionActivation` fail-closed
 * ladder (server/src/services/instance-settings.ts) so the card never claims a
 * copied/legacy row is arming execution. The derived fields are display-only —
 * the PATCH the toggle sends still writes just the boolean.
 */
function resolveWorktreeRunExecutionDisplayState(
  settings:
    | Pick<
        InstanceExperimentalSettings,
        | "enableWorktreeRunExecution"
        | "worktreeRunExecutionActivatedAt"
        | "worktreeRunExecutionActivationInstanceId"
      >
    | undefined,
  currentInstanceId: string | null,
): WorktreeRunExecutionDisplayState {
  if (settings?.enableWorktreeRunExecution !== true) return { kind: "off" };
  if (!settings.worktreeRunExecutionActivatedAt) return { kind: "fail_closed", reason: "missing_cutoff" };
  if (!currentInstanceId) return { kind: "fail_closed", reason: "missing_instance_id" };
  if (settings.worktreeRunExecutionActivationInstanceId !== currentInstanceId) {
    return { kind: "fail_closed", reason: "instance_mismatch" };
  }
  return { kind: "armed", activatedAt: settings.worktreeRunExecutionActivatedAt };
}

function formatActivationTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

// PAP-11233: keep Conference Room code intact, but hide the user-facing opt-in for now.
const SHOW_CONFERENCE_ROOM_EXPERIMENTAL_SETTING = false;

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
          <DialogTitle>Confirm auto-recovery</DialogTitle>
          <DialogDescription>
            {preview
              ? `${count} recovery ${count === 1 ? "task" : "tasks"} match the last ${preview.lookbackHours} hours.`
              : "Checking recovery candidates before enabling."}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-(--sz-calc-36) space-y-3 overflow-y-auto pr-1">
          {preview && preview.items.length === 0 ? (
            <div className="rounded-md border border-border bg-muted/30 px-3 py-4 text-sm text-muted-foreground">
              No recovery tasks would be created right now. Auto-recovery can still run for future liveness incidents in
              this window.
            </div>
          ) : null}

          {preview?.items.map((item) => (
            <Card key={item.incidentKey} className="block px-3 py-3">
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
                Recovery target:{" "}
                <a
                  href={issueHref(item.recoveryIdentifier, item.recoveryIssueId)}
                  className="text-primary underline-offset-2 hover:underline"
                >
                  {item.recoveryIdentifier ?? item.recoveryIssueId}
                </a>
              </div>
            </Card>
          ))}
        </div>

        {preview && preview.skippedOutsideLookback > 0 ? (
          <p className="text-xs text-muted-foreground">
            {preview.skippedOutsideLookback} current{" "}
            {preview.skippedOutsideLookback === 1 ? "finding is" : "findings are"} outside the configured lookback and
            will not be touched.
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button variant="outline" onClick={onEnableOnly} disabled={isPending || !preview}>
            Enable only
          </Button>
          <Button onClick={onEnableAndRun} disabled={isPending || !preview}>
            {count > 0 ? `Enable and create ${count}` : "Enable"}
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

  function closeRecoveryPreview() {
    setPreviewDialogOpen(false);
    setPendingPreview(null);
  }

  useEffect(() => {
    setBreadcrumbs([
      { label: "Settings", href: "/company/settings" },
      { label: "Instance settings", href: "/company/settings/instance/general" },
      { label: "Experimental" },
    ]);
  }, [setBreadcrumbs]);

  const experimentalQuery = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });

  const toggleMutation = useMutation<
    InstanceExperimentalSettings,
    Error,
    PatchInstanceExperimentalSettings,
    { previousSettings?: InstanceExperimentalSettings }
  >({
    mutationFn: async (patch: PatchInstanceExperimentalSettings) =>
      instanceSettingsApi.updateExperimental(patch),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.instance.experimentalSettings });
      const previousSettings = queryClient.getQueryData<InstanceExperimentalSettings>(
        queryKeys.instance.experimentalSettings,
      );
      if (previousSettings) {
        queryClient.setQueryData<InstanceExperimentalSettings>(
          queryKeys.instance.experimentalSettings,
          { ...previousSettings, ...patch },
        );
      }
      return { previousSettings };
    },
    onSuccess: async (updatedSettings) => {
      setActionError(null);
      queryClient.setQueryData(queryKeys.instance.experimentalSettings, updatedSettings);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.instance.experimentalSettings }),
        queryClient.invalidateQueries({ queryKey: ["built-in-agents"] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.health }),
      ]);
    },
    onError: (error, _patch, context) => {
      if (context?.previousSettings) {
        queryClient.setQueryData(queryKeys.instance.experimentalSettings, context.previousSettings);
      }
      setActionError(error instanceof Error ? error.message : "Failed to update experimental settings.");
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
      closeRecoveryPreview();
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

  if (experimentalQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading experimental settings...</div>;
  }

  if (experimentalQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {experimentalQuery.error instanceof Error
          ? experimentalQuery.error.message
          : "Failed to load experimental settings."}
      </div>
    );
  }

  const inWorktree = isWorktreeRuntime();
  const enableWorktreeRunExecution = experimentalQuery.data?.enableWorktreeRunExecution === true;
  const worktreeRunExecutionState = resolveWorktreeRunExecutionDisplayState(
    experimentalQuery.data,
    getWorktreeInstanceId(),
  );
  const enableEnvironments = experimentalQuery.data?.enableEnvironments === true;
  const enableIsolatedWorkspaces = experimentalQuery.data?.enableIsolatedWorkspaces === true;
  const enableApps = experimentalQuery.data?.enableApps === true;
  // Streamlined left navigation is now the standard sidebar (PAP-12472); the
  // experimental opt-out was retired, so it no longer surfaces a toggle here.
  const enableConferenceRoomChat = experimentalQuery.data?.enableConferenceRoomChat === true;
  const enableIssuePlanDecompositions =
    experimentalQuery.data?.enableIssuePlanDecompositions === true;
  const enableExperimentalFileViewer =
    experimentalQuery.data?.enableExperimentalFileViewer === true;
  const enableTaskWatchdogs = experimentalQuery.data?.enableTaskWatchdogs === true;
  const enableCloudSync = experimentalQuery.data?.enableCloudSync === true;
  const enableExternalObjects = experimentalQuery.data?.enableExternalObjects === true;
  const enableBuiltInAgents = experimentalQuery.data?.enableBuiltInAgents === true;
  const enableSummaries = experimentalQuery.data?.enableSummaries === true;
  const enableDecisions = experimentalQuery.data?.enableDecisions === true;
  const enableGoalsSidebarLink = experimentalQuery.data?.enableGoalsSidebarLink === true;
  const enableCases = experimentalQuery.data?.enableCases === true;
  const enableServerInfoDebugView = experimentalQuery.data?.enableServerInfoDebugView === true;
  const enableSmokeLab = experimentalQuery.data?.enableSmokeLab === true;
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
      setActionError("Lookback hours must be a whole number from 1 to 720.");
      return;
    }
    closeRecoveryPreview();
    previewMutation.mutate(parsedLookbackHours);
  }

  function enableOnly() {
    if (!lookbackHoursIsValid) return;
    closeRecoveryPreview();
    toggleMutation.mutate({
      enableIssueGraphLivenessAutoRecovery: true,
      issueGraphLivenessAutoRecoveryLookbackHours: parsedLookbackHours,
    });
  }

  function enableAndRun() {
    if (!lookbackHoursIsValid) return;
    closeRecoveryPreview();
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
          <h1 className="text-lg font-semibold">Experimental</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Opt into features that are still being evaluated before they become default behavior.
        </p>
      </div>

      <div
        role="alert"
        className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3"
      >
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
          <div className="space-y-1 text-sm">
            <p className="font-medium text-foreground">Experimental features may break at any time.</p>
            <p className="text-muted-foreground">
              These features are opt-in and come with no compatibility guarantees. They may change, break, or be
              removed without notice. Avoid relying on them for critical or production workflows.
            </p>
          </div>
        </div>
      </div>

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      )}

      {inWorktree ? (
        <Card className="block p-5">
          <div className="flex flex-col gap-4">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1.5">
                <h2 className="text-sm font-semibold">Run tasks in this worktree</h2>
                <p className="max-w-2xl text-sm text-muted-foreground">
                  This is an isolated git-worktree preview instance. Turn this on to let the scheduler execute runs
                  here. Only tasks created after enabling will run automatically — copied/pre-existing tasks stay
                  parked. Toggling off and on resets the cutoff.
                </p>
              </div>
              <ToggleSwitch
                checked={enableWorktreeRunExecution}
                onCheckedChange={(checked) =>
                  toggleMutation.mutate({ enableWorktreeRunExecution: checked })
                }
                disabled={toggleMutation.isPending}
                aria-label="Toggle worktree run execution setting"
              />
            </div>

            {worktreeRunExecutionState.kind === "armed" ? (
              <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-foreground">
                <Play className="h-4 w-4 shrink-0 text-emerald-600" />
                <span>
                  Running tasks created after{" "}
                  <span className="font-medium">
                    {formatActivationTimestamp(worktreeRunExecutionState.activatedAt)}
                  </span>
                  .
                </span>
              </div>
            ) : null}

            {worktreeRunExecutionState.kind === "fail_closed" ? (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
                <div className="space-y-0.5">
                  <p className="font-medium text-foreground">Execution is suppressed — effectively off.</p>
                  <p className="text-muted-foreground">
                    {worktreeRunExecutionState.reason === "instance_mismatch"
                      ? "This setting was armed in a different instance and copied here, so no tasks run automatically."
                      : "This setting is missing its activation cutoff, so no tasks run automatically."}{" "}
                    Toggle it off and back on to arm execution for tasks created here.
                  </p>
                </div>
              </div>
            ) : null}
          </div>
        </Card>
      ) : null}

      <Card className="block p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold">Apps</h2>
              <Badge variant="secondary">Experimental</Badge>
            </div>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Show the Apps navigation and allow access to app connections, gateways, and advanced app tooling.
            </p>
          </div>
          <ToggleSwitch
            checked={enableApps}
            onCheckedChange={() => toggleMutation.mutate({ enableApps: !enableApps })}
            disabled={toggleMutation.isPending}
            aria-label="Toggle apps experimental setting"
          />
        </div>
      </Card>

      <Card className="block p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold">Cases</h2>
              <Badge variant="secondary">Experimental</Badge>
            </div>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Durable work products (blog posts, tweet storms…) that tasks create and iterate on. Adds the
              Cases tab and the agent case API.
            </p>
            <p className="max-w-2xl text-xs text-muted-foreground">
              Turning Cases off hides the tab and blocks the case API; existing case data is kept.
            </p>
          </div>
          <ToggleSwitch
            checked={enableCases}
            onCheckedChange={() => toggleMutation.mutate({ enableCases: !enableCases })}
            disabled={toggleMutation.isPending}
            aria-label="Toggle cases experimental setting"
          />
        </div>
      </Card>

      <Card className="block p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Enable Environments</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Show environment management in company settings and allow project and agent environment assignment
              controls.
            </p>
          </div>
          <ToggleSwitch
            checked={enableEnvironments}
            onCheckedChange={() => toggleMutation.mutate({ enableEnvironments: !enableEnvironments })}
            disabled={toggleMutation.isPending}
            aria-label="Toggle environments experimental setting"
          />
        </div>
      </Card>

      <Card className="block p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Built-in Agents</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Show Paperclip-managed built-in agent surfaces, including built-in roster badges, the Built-in agents
              tab, and built-in agent setup controls.
            </p>
          </div>
          <ToggleSwitch
            checked={enableBuiltInAgents}
            onCheckedChange={() => toggleMutation.mutate({ enableBuiltInAgents: !enableBuiltInAgents })}
            disabled={toggleMutation.isPending}
            aria-label="Toggle built-in agents experimental setting"
          />
        </div>
      </Card>

      <Card className="block p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Summaries</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Show Summarizer-generated status slots on project and workspace pages, with on-demand refresh and
              revision history. Existing summary data is kept when this is disabled.
            </p>
          </div>
          <ToggleSwitch
            checked={enableSummaries}
            onCheckedChange={() => toggleMutation.mutate({ enableSummaries: !enableSummaries })}
            disabled={toggleMutation.isPending}
            aria-label="Toggle summaries experimental setting"
          />
        </div>
      </Card>

      <Card className="block p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Experimental File Viewer</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Show task detail controls for browsing and previewing workspace files relative to a task.
            </p>
          </div>
          <ToggleSwitch
            checked={enableExperimentalFileViewer}
            onCheckedChange={() =>
              toggleMutation.mutate({
                enableExperimentalFileViewer: !enableExperimentalFileViewer,
              })
            }
            disabled={toggleMutation.isPending}
            aria-label="Toggle experimental file viewer setting"
          />
        </div>
      </Card>

      <Card className="block p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Enable External Objects</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Detect external URLs in issues and show resolved status for pull requests, tickets, and other referenced
              work objects.
            </p>
          </div>
          <ToggleSwitch
            checked={enableExternalObjects}
            onCheckedChange={() => toggleMutation.mutate({ enableExternalObjects: !enableExternalObjects })}
            disabled={toggleMutation.isPending}
            aria-label="Toggle external objects experimental setting"
          />
        </div>
      </Card>

      <Card className="block p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Decisions</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Show the Decisions item in the main sidebar — the attention home that surfaces the tasks awaiting your
              input — while the surface is still being evaluated.
            </p>
          </div>
          <ToggleSwitch
            checked={enableDecisions}
            onCheckedChange={() => toggleMutation.mutate({ enableDecisions: !enableDecisions })}
            disabled={toggleMutation.isPending}
            aria-label="Toggle decisions experimental setting"
          />
        </div>
      </Card>

      <Card className="block p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Goals Sidebar Link</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Restore the Goals item in the main sidebar while the goals surface is being evaluated.
            </p>
          </div>
          <ToggleSwitch
            checked={enableGoalsSidebarLink}
            onCheckedChange={() => toggleMutation.mutate({ enableGoalsSidebarLink: !enableGoalsSidebarLink })}
            disabled={toggleMutation.isPending}
            aria-label="Toggle goals sidebar link experimental setting"
          />
        </div>
      </Card>

      <Card className="block p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Enable Isolated Workspaces</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Show execution workspace controls in project configuration and allow isolated workspace behavior for new
              and existing task runs.
            </p>
          </div>
          <ToggleSwitch
            checked={enableIsolatedWorkspaces}
            onCheckedChange={() => toggleMutation.mutate({ enableIsolatedWorkspaces: !enableIsolatedWorkspaces })}
            disabled={toggleMutation.isPending}
            aria-label="Toggle isolated workspaces experimental setting"
          />
        </div>
      </Card>

      {SHOW_CONFERENCE_ROOM_EXPERIMENTAL_SETTING ? (
        <Card className="block p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1.5">
              <h2 className="text-sm font-semibold">Conference Room Chat</h2>
              <p className="max-w-2xl text-sm text-muted-foreground">
                Adds a Conference Room — one chat where you and your whole team work together — plus the live activity
                feed and the redesigned onboarding. Also restyles task threads as chat bubbles. Turn off anytime to
                restore the classic UI.
              </p>
            </div>
            <ToggleSwitch
              checked={enableConferenceRoomChat}
              onCheckedChange={() =>
                toggleMutation.mutate({
                  enableConferenceRoomChat: !enableConferenceRoomChat,
                })
              }
              disabled={toggleMutation.isPending}
              aria-label="Toggle conference room chat experimental setting"
            />
          </div>
        </Card>
      ) : null}

      <Card className="block p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Task Plan Decomposition Panel</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Show accepted-plan decomposition history on task detail pages. Intended for debugging and validating
              subtask creation behavior while the presentation is still being refined.
            </p>
          </div>
          <ToggleSwitch
            checked={enableIssuePlanDecompositions}
            onCheckedChange={() =>
              toggleMutation.mutate({
                enableIssuePlanDecompositions: !enableIssuePlanDecompositions,
              })
            }
            disabled={toggleMutation.isPending}
            aria-label="Toggle task plan decomposition panel experimental setting"
          />
        </div>
      </Card>

      <Card className="block p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Task Watchdogs</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Show task detail controls for configuring watchdog agents that verify stopped task subtrees and restore
              live paths when work should continue.
            </p>
          </div>
          <ToggleSwitch
            checked={enableTaskWatchdogs}
            onCheckedChange={(checked) =>
              toggleMutation.mutate({
                enableTaskWatchdogs: checked,
              })
            }
            disabled={toggleMutation.isPending}
            aria-label="Toggle task watchdogs experimental setting"
          />
        </div>
      </Card>

      <Card className="block p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Cloud Sync</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Show local Paperclip Cloud upstream connection, preview, push, retry, and activation review surfaces.
              Saved connections and run history are preserved when this is disabled.
            </p>
          </div>
          <ToggleSwitch
            checked={enableCloudSync}
            onCheckedChange={() => toggleMutation.mutate({ enableCloudSync: !enableCloudSync })}
            disabled={toggleMutation.isPending}
            aria-label="Toggle cloud sync experimental setting"
          />
        </div>
      </Card>

      <Card className="block p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Server Info Debug View</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Show a "Server" section in the account drawer with the current server restart time and running commit.
            </p>
          </div>
          <ToggleSwitch
            checked={enableServerInfoDebugView}
            onCheckedChange={() =>
              toggleMutation.mutate({
                enableServerInfoDebugView: !enableServerInfoDebugView,
              })
            }
            disabled={toggleMutation.isPending}
            aria-label="Toggle server info debug view experimental setting"
          />
        </div>
      </Card>

      <Card className="block p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Smoke Lab</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Add a "Smoke Lab" tab under Apps → Developer and an "Integration smoke" card on the
              dashboard for exercising every integration path against deterministic local fixtures
              (fake OAuth provider + loopback MCP servers). Private (non-public) deployments only.
            </p>
          </div>
          <ToggleSwitch
            checked={enableSmokeLab}
            onCheckedChange={() => toggleMutation.mutate({ enableSmokeLab: !enableSmokeLab })}
            disabled={toggleMutation.isPending}
            aria-label="Toggle smoke lab experimental setting"
          />
        </div>
      </Card>

      <Card className="block p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Auto-Restart Dev Server When Idle</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              In `pnpm dev:once`, wait for all queued and running local agent runs to finish, then restart the server
              automatically when backend changes or migrations make the current boot stale.
            </p>
          </div>
          <ToggleSwitch
            checked={autoRestartDevServerWhenIdle}
            onCheckedChange={() => toggleMutation.mutate({ autoRestartDevServerWhenIdle: !autoRestartDevServerWhenIdle })}
            disabled={toggleMutation.isPending}
            aria-label="Toggle guarded dev-server auto-restart"
          />
        </div>
      </Card>

      <Card className="block p-5">
        <div className="flex flex-col gap-5">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1.5">
              <h2 className="text-sm font-semibold">Auto-Create Recovery Tasks</h2>
              <p className="max-w-2xl text-sm text-muted-foreground">
                Let the heartbeat scheduler create recovery tasks for task dependency chains found inside the
                configured lookback window.
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
              aria-label="Toggle task graph liveness auto-recovery"
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-(--gtc-35) sm:items-end">
            <label className="space-y-1.5">
              <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Clock className="h-3.5 w-3.5" />
                Lookback hours
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
                    setActionError("Lookback hours must be a whole number from 1 to 720.");
                    return;
                  }
                  toggleMutation.mutate({
                    issueGraphLivenessAutoRecoveryLookbackHours: parsedLookbackHours,
                  });
                }}
                disabled={recoveryActionPending || parsedLookbackHours === lookbackHours}
              >
                Save hours
              </Button>
              <Button
                variant="outline"
                onClick={previewForEnable}
                disabled={recoveryActionPending}
              >
                <Search className="h-4 w-4" />
                Preview
              </Button>
              <Button
                onClick={() => {
                  if (!lookbackHoursIsValid) {
                    setActionError("Lookback hours must be a whole number from 1 to 720.");
                    return;
                  }
                  runRecoveryMutation.mutate(parsedLookbackHours);
                }}
                disabled={recoveryActionPending || !enableIssueGraphLivenessAutoRecovery}
              >
                <Play className="h-4 w-4" />
                Run now
              </Button>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            Current window: last {lookbackHours} {lookbackHours === 1 ? "hour" : "hours"}.
          </p>
        </div>
      </Card>

      {previewDialogOpen ? (
        <RecoveryPreviewDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              closeRecoveryPreview();
            }
          }}
          preview={pendingPreview}
          onEnableOnly={enableOnly}
          onEnableAndRun={enableAndRun}
          isPending={recoveryActionPending}
        />
      ) : null}
    </div>
  );
}
