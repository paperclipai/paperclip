import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "@/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, FlaskConical, Lock, Play } from "lucide-react";
import type {
  InstanceExperimentalSettings,
  InstanceExperimentalSettingsWithManaged,
  InstanceFeatureKey,
  ManagedSettingMetadata,
  PatchInstanceExperimentalSettings,
} from "@paperclipai/shared";
import { experimentalSettingKey } from "@paperclipai/shared";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { useHiddenSettings } from "@/hooks/useHiddenSettings";
import { getWorktreeInstanceId, isWorktreeRuntime } from "../lib/worktree-branding";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Link } from "@/lib/router";
import { ClassicWorkspaceSetting } from "@/components/ClassicWorkspaceSetting";
import { describeError } from "@/api/errors";

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

function ManagedByCloudBadge() {
  return (
    <Badge variant="outline" className="text-muted-foreground">
      <Lock aria-hidden="true" />
      Managed by Paperclip Cloud
    </Badge>
  );
}

function ExperimentalToggleCard({
  title,
  description,
  footnote,
  checked,
  onCheckedChange,
  disabled,
  settingKey,
  managed,
  ariaLabel,
}: {
  title: string;
  description: string;
  footnote?: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled: boolean;
  /** Flag key backing this card; operator-hidden keys render nothing. */
  settingKey: InstanceFeatureKey;
  managed?: ManagedSettingMetadata;
  ariaLabel: string;
}) {
  const { hidden: hiddenSettings } = useHiddenSettings();
  const isManaged = managed?.managed === true;
  if (hiddenSettings.has(experimentalSettingKey(settingKey))) return null;
  return (
    <Card id={`experimental-${settingKey}`} className="block scroll-mt-4 bg-transparent p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">{title}</h3>
            {isManaged ? <ManagedByCloudBadge /> : null}
          </div>
          <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
          {footnote ? <p className="max-w-2xl text-xs text-muted-foreground">{footnote}</p> : null}
        </div>
        <ToggleSwitch
          checked={checked}
          onCheckedChange={(next) => {
            if (isManaged) return;
            onCheckedChange(next);
          }}
          disabled={disabled || isManaged}
          aria-label={ariaLabel}
        />
      </div>
    </Card>
  );
}

export function InstanceExperimentalSettings() {
  const { t } = useTranslation();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const { hidden: hiddenSettings } = useHiddenSettings();
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Settings", href: "/company/settings" },
      { label: "Experimental" },
    ]);
  }, [setBreadcrumbs]);

  const experimentalQuery = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  const experimentalView = useQueryView(experimentalQuery);

  const toggleMutation = useMutation<
    InstanceExperimentalSettingsWithManaged,
    Error,
    PatchInstanceExperimentalSettings,
    { previousSettings?: InstanceExperimentalSettingsWithManaged }
  >({
    mutationFn: async (patch: PatchInstanceExperimentalSettings) =>
      instanceSettingsApi.updateExperimental(patch),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.instance.experimentalSettings });
      const previousSettings = queryClient.getQueryData<InstanceExperimentalSettingsWithManaged>(
        queryKeys.instance.experimentalSettings,
      );
      if (previousSettings) {
        queryClient.setQueryData<InstanceExperimentalSettingsWithManaged>(
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
        queryClient.invalidateQueries({ queryKey: queryKeys.adapters.all }),
        queryClient.invalidateQueries({ queryKey: ["built-in-agents"] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.health }),
        queryClient.invalidateQueries({ queryKey: ["apps"] }),
      ]);
    },
    onError: (error, _patch, context) => {
      if (context?.previousSettings) {
        queryClient.setQueryData(queryKeys.instance.experimentalSettings, context.previousSettings);
      }
      setActionError(describeError(error).body);
    },
  });

  if (experimentalQuery.isLoading || experimentalView.kind === "reconnecting") {
    return (
      <div className="max-w-6xl space-y-6">
        <ClassicWorkspaceSetting key="personal-workspace" />
        <div className="text-sm text-muted-foreground">{t("settings.instanceExperimental.loading")}</div>
      </div>
    );
  }

  if (experimentalView.kind === "error") {
    return (
<div className="max-w-6xl space-y-6"><ClassicWorkspaceSetting key="personal-workspace" />      <QueryErrorState
        size="page"
        error={experimentalQuery.error}
        action={t("settings.instanceExperimental.loadAction")}
        onRetry={experimentalView.retry}
        retrying={experimentalView.isFetching}
      />
</div>
    );
  }

  const inWorktree = isWorktreeRuntime();
  // Present only on cloud-managed instances: keys the managed overlay controls
  // render locked with the "Managed by Paperclip Cloud" badge. Self-hosted
  // responses carry no `managedKeys`, so every card stays editable.
  const managedKeys = experimentalQuery.data?.managedKeys ?? {};
  const enableWorktreeRunExecution = experimentalQuery.data?.enableWorktreeRunExecution === true;
  const worktreeRunExecutionManaged = managedKeys.enableWorktreeRunExecution?.managed === true;
  const worktreeRunExecutionState = resolveWorktreeRunExecutionDisplayState(
    experimentalQuery.data,
    getWorktreeInstanceId(),
  );
  const enableEnvironments = experimentalQuery.data?.enableEnvironments === true;
  const enableNativeRunner = experimentalQuery.data?.enableNativeRunner === true;
  const enableChatConnectors = experimentalQuery.data?.enableChatConnectors === true;
  const enableManagedSandboxOnly = experimentalQuery.data?.enableManagedSandboxOnly === true;
  const enableIsolatedWorkspaces = experimentalQuery.data?.enableIsolatedWorkspaces === true;
  const enableIsolatedWorkspacesByDefault =
    experimentalQuery.data?.enableIsolatedWorkspacesByDefault === true;
  // Streamlined left navigation is now the standard sidebar (PAP-12472); the
  // experimental opt-out was retired, so it no longer surfaces a toggle here.
  const enableStreamlinedUi = experimentalQuery.data?.enableStreamlinedUi !== false;
  const enableConferenceRoomChat = experimentalQuery.data?.enableConferenceRoomChat === true;
  const enableClassicTaskInterface = experimentalQuery.data?.enableClassicTaskInterface === true;
  const enableIssuePlanDecompositions =
    experimentalQuery.data?.enableIssuePlanDecompositions === true;
  const enableExperimentalFileViewer =
    experimentalQuery.data?.enableExperimentalFileViewer === true;
  const enableExternalObjects = experimentalQuery.data?.enableExternalObjects === true;
  const enableBuiltInAgents = experimentalQuery.data?.enableBuiltInAgents === true;
  const enableBetaSkills = experimentalQuery.data?.enableBetaSkills === true;
  const enableSummaries = experimentalQuery.data?.enableSummaries === true;
  const enableStatusCards = experimentalQuery.data?.enableStatusCards === true;
  const summariesManaged = managedKeys.enableSummaries?.managed === true;
  const statusCardsManaged = managedKeys.enableStatusCards?.managed === true;
  const statusCardsBlockedByManagedSummaries = summariesManaged && !enableSummaries;
  const summariesRequiredByManagedStatusCards = statusCardsManaged && enableStatusCards;
  const enableDecisions = experimentalQuery.data?.enableDecisions === true;
  const enableGoalsSidebarLink = experimentalQuery.data?.enableGoalsSidebarLink === true;
  const enableCases = experimentalQuery.data?.enableCases === true;
  const enableServerInfoDebugView = experimentalQuery.data?.enableServerInfoDebugView === true;
  const enablePaperclipDeveloperMode =
    experimentalQuery.data?.enablePaperclipDeveloperMode === true;
  const enableSimplifiedEnglishInteractions =
    experimentalQuery.data?.enableSimplifiedEnglishInteractions === true;
  const enableFirstTaskPlanProposal =
    experimentalQuery.data?.enableFirstTaskPlanProposal === true;
  const enableSmokeLab = experimentalQuery.data?.enableSmokeLab === true;
  const autoRestartDevServerWhenIdle = experimentalQuery.data?.autoRestartDevServerWhenIdle === true;
  const isVisible = (key: InstanceFeatureKey) => !hiddenSettings.has(experimentalSettingKey(key));
  const showWorktreeRunExecution = inWorktree && isVisible("enableWorktreeRunExecution");
  const showDeveloperSection = showWorktreeRunExecution || ([
    "autoRestartDevServerWhenIdle",
    "enableManagedSandboxOnly",
    "enablePaperclipDeveloperMode",
    "enableServerInfoDebugView",
    "enableSmokeLab",
    "enableIssuePlanDecompositions",
  ] satisfies InstanceFeatureKey[]).some(isVisible);
  const showLegacySection = isVisible("enableClassicTaskInterface") || isVisible("enableGoalsSidebarLink");
  return (
    <div className="max-w-6xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <FlaskConical className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">{t("settings.instanceExperimental.title")}</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          {t("settings.instanceExperimental.description")}
        </p>
      </div>

      <ClassicWorkspaceSetting key="personal-workspace" />

      <div
        role="alert"
        className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3"
      >
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
          <div className="space-y-1 text-sm">
            <p className="font-medium text-foreground">{t("settings.instanceExperimental.warningTitle")}</p>
            <p className="text-muted-foreground">
              {t("settings.instanceExperimental.warningBody")}
            </p>
          </div>
        </div>
      </div>

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      )}

      <section className="space-y-3" aria-labelledby="experimental-features-heading">
        <div className="space-y-1">
          <h2 id="experimental-features-heading" className="text-sm font-semibold">
            Experimental features
          </h2>
          <p className="text-sm text-muted-foreground">
            Optional product features that are still being evaluated.
          </p>
        </div>

        <ExperimentalToggleCard
          title={t("settings.instanceExperimental.assistantConnections.title")}
          description={t("settings.instanceExperimental.assistantConnections.description")}
          footnote={<>{t("settings.instanceExperimental.assistantConnections.footnoteText")}{experimentalQuery.data?.enablePublicMcp && <> <Link className="underline" to="/apps/assistant-connection">{t("settings.instanceExperimental.assistantConnections.setUpLink")}</Link></>}</>}
          checked={experimentalQuery.data?.enablePublicMcp === true}
          onCheckedChange={(checked) => toggleMutation.mutate({ enablePublicMcp: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enablePublicMcp"
          managed={managedKeys.enablePublicMcp}
          ariaLabel={t("settings.instanceExperimental.assistantConnections.ariaLabel")}
        />

        <ExperimentalToggleCard
          title={t("settings.instanceExperimental.betaSkills.title")}
          description={t("settings.instanceExperimental.betaSkills.description")}
          checked={enableBetaSkills}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableBetaSkills: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableBetaSkills"
          managed={managedKeys.enableBetaSkills}
          ariaLabel={t("settings.instanceExperimental.betaSkills.ariaLabel")}
        />

        <ExperimentalToggleCard
          title={t("settings.instanceExperimental.builtInAgents.title")}
          description={t("settings.instanceExperimental.builtInAgents.description")}
          checked={enableBuiltInAgents}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableBuiltInAgents: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableBuiltInAgents"
          managed={managedKeys.enableBuiltInAgents}
          ariaLabel={t("settings.instanceExperimental.builtInAgents.ariaLabel")}
        />

        <ExperimentalToggleCard
          title={t("settings.instanceExperimental.cases.title")}
          description={t("settings.instanceExperimental.cases.description")}
          footnote={t("settings.instanceExperimental.cases.footnote")}
          checked={enableCases}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableCases: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableCases"
          managed={managedKeys.enableCases}
          ariaLabel={t("settings.instanceExperimental.cases.ariaLabel")}
        />

        <ExperimentalToggleCard
          title={t("settings.instanceExperimental.chatConnectors.title")}
          description={t("settings.instanceExperimental.chatConnectors.description")}
          footnote={t("settings.instanceExperimental.chatConnectors.footnote")}
          checked={enableChatConnectors}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableChatConnectors: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableChatConnectors"
          managed={managedKeys.enableChatConnectors}
          ariaLabel={t("settings.instanceExperimental.chatConnectors.ariaLabel")}
        />

        <ExperimentalToggleCard
          title="Combined Inbox + Task List"
          description="In the Classic workspace, fold Inbox into Tasks. One Tasks row carries the unread badge, and a Views menu reaches every personal and organization task view."
          footnote="Coordinator always includes personal views in Tasks. For Classic, turning this off restores its separate Inbox. No data changes."
          checked={experimentalQuery.data?.enableCombinedInboxTasks ?? false}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableCombinedInboxTasks: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableCombinedInboxTasks"
          managed={managedKeys.enableCombinedInboxTasks}
          ariaLabel={t("settings.instanceExperimental.combinedInboxTasks.ariaLabel")}
        />

        {SHOW_CONFERENCE_ROOM_EXPERIMENTAL_SETTING ? (
          <ExperimentalToggleCard
            title={t("settings.instanceExperimental.conferenceRoomChat.title")}
            description={t("settings.instanceExperimental.conferenceRoomChat.description")}
            checked={enableConferenceRoomChat}
            onCheckedChange={(checked) => toggleMutation.mutate({ enableConferenceRoomChat: checked })}
            disabled={toggleMutation.isPending}
            settingKey="enableConferenceRoomChat"
            managed={managedKeys.enableConferenceRoomChat}
            ariaLabel={t("settings.instanceExperimental.conferenceRoomChat.ariaLabel")}
          />
        ) : null}

        <ExperimentalToggleCard
          title="Command/Ctrl+Enter to Submit"
          description="Restore the previous keyboard shortcut for task replies and new tasks: Command/Ctrl+Enter submits, and Enter adds a new line."
          footnote="Off by default: Enter submits, and Shift+Enter adds a new line."
          checked={experimentalQuery.data?.enableLegacyComposerSubmit === true}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableLegacyComposerSubmit: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableLegacyComposerSubmit"
          managed={managedKeys.enableLegacyComposerSubmit}
          ariaLabel="Toggle Command/Ctrl+Enter to submit"
        />

        <ExperimentalToggleCard
          title={t("settings.instanceExperimental.decisions.title")}
          description={t("settings.instanceExperimental.decisions.description")}
          checked={enableDecisions}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableDecisions: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableDecisions"
          managed={managedKeys.enableDecisions}
          ariaLabel={t("settings.instanceExperimental.decisions.ariaLabel")}
        />

        <ExperimentalToggleCard
          title={t("settings.instanceExperimental.environments.title")}
          description={t("settings.instanceExperimental.environments.description")}
          checked={enableEnvironments}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableEnvironments: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableEnvironments"
          managed={managedKeys.enableEnvironments}
          ariaLabel={t("settings.instanceExperimental.environments.ariaLabel")}
        />

        <ExperimentalToggleCard
          title={t("settings.instanceExperimental.externalObjects.title")}
          description={t("settings.instanceExperimental.externalObjects.description")}
          checked={enableExternalObjects}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableExternalObjects: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableExternalObjects"
          managed={managedKeys.enableExternalObjects}
          ariaLabel={t("settings.instanceExperimental.externalObjects.ariaLabel")}
        />

        <ExperimentalToggleCard
          title={t("settings.instanceExperimental.isolatedWorkspaces.title")}
          description={t("settings.instanceExperimental.isolatedWorkspaces.description")}
          checked={enableIsolatedWorkspaces}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableIsolatedWorkspaces: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableIsolatedWorkspaces"
          managed={managedKeys.enableIsolatedWorkspaces}
          ariaLabel={t("settings.instanceExperimental.isolatedWorkspaces.ariaLabel")}
        />

        <ExperimentalToggleCard
          title={t("settings.instanceExperimental.fastResponses.title")}
          description={t("settings.instanceExperimental.fastResponses.description")}
          checked={experimentalQuery.data?.enableFastResponses ?? false}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableFastResponses: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableFastResponses"
          managed={managedKeys.enableFastResponses}
          ariaLabel={t("settings.instanceExperimental.fastResponses.ariaLabel")}
        />

        <ExperimentalToggleCard
          title={t("settings.instanceExperimental.fileViewer.title")}
          description={t("settings.instanceExperimental.fileViewer.description")}
          checked={enableExperimentalFileViewer}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableExperimentalFileViewer: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableExperimentalFileViewer"
          managed={managedKeys.enableExperimentalFileViewer}
          ariaLabel={t("settings.instanceExperimental.fileViewer.ariaLabel")}
        />

        <ExperimentalToggleCard
          title={t("settings.instanceExperimental.firstTaskPlanProposal.title")}
          description={t("settings.instanceExperimental.firstTaskPlanProposal.description")}
          checked={enableFirstTaskPlanProposal}
          onCheckedChange={(checked) =>
            toggleMutation.mutate({ enableFirstTaskPlanProposal: checked })
          }
          disabled={toggleMutation.isPending}
          settingKey="enableFirstTaskPlanProposal"
          managed={managedKeys.enableFirstTaskPlanProposal}
          ariaLabel={t("settings.instanceExperimental.firstTaskPlanProposal.ariaLabel")}
        />

        <ExperimentalToggleCard
          title={t("settings.instanceExperimental.githubReviewBots.title")}
          description={t("settings.instanceExperimental.githubReviewBots.description")}
          footnote={t("settings.instanceExperimental.githubReviewBots.footnote")}
          checked={experimentalQuery.data?.enableGitHubReviewBots === true}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableGitHubReviewBots: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableGitHubReviewBots"
          managed={managedKeys.enableGitHubReviewBots}
          ariaLabel={t("settings.instanceExperimental.githubReviewBots.ariaLabel")}
        />

        <ExperimentalToggleCard
          title="Google Workspace connector (Paperclip)"
          description="Show the built-in Google Workspace connector for Gmail, Drive, and Calendar while Google verification is pending."
          footnote="Off by default. While off, Google apps are offered through Composio and Arcade instead, and the built-in connector cannot be set up or run."
          checked={experimentalQuery.data?.enableGoogleWorkspaceConnector === true}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableGoogleWorkspaceConnector: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableGoogleWorkspaceConnector"
          managed={managedKeys.enableGoogleWorkspaceConnector}
          ariaLabel="Toggle Paperclip Google Workspace connector experimental setting"
        />

        <ExperimentalToggleCard
          title={t("settings.instanceExperimental.grokBot.title")}
          description={t("settings.instanceExperimental.grokBot.description")}
          footnote={t("settings.instanceExperimental.grokBot.footnote")}
          checked={experimentalQuery.data?.enableGrokBot === true}
          onCheckedChange={checked => toggleMutation.mutate({ enableGrokBot: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableGrokBot" managed={managedKeys.enableGrokBot}
          ariaLabel={t("settings.instanceExperimental.grokBot.ariaLabel")}
        />


        <ExperimentalToggleCard
          title={t("settings.instanceExperimental.memoryConnectors.title")}
          description={t("settings.instanceExperimental.memoryConnectors.description")}
          footnote={t("settings.instanceExperimental.memoryConnectors.footnote")}
          checked={experimentalQuery.data?.enableMemoryConnectors === true}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableMemoryConnectors: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableMemoryConnectors"
          managed={managedKeys.enableMemoryConnectors}
          ariaLabel={t("settings.instanceExperimental.memoryConnectors.ariaLabel")}
        />

        <ExperimentalToggleCard
          title={t("settings.instanceExperimental.muse.title")}
          description={t("settings.instanceExperimental.muse.description")}
          footnote={t("settings.instanceExperimental.muse.footnote")}
          checked={experimentalQuery.data?.enableMuse === true}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableMuse: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableMuse"
          managed={managedKeys.enableMuse}
          ariaLabel={t("settings.instanceExperimental.muse.ariaLabel")}
        />

        <ExperimentalToggleCard
          title={t("settings.instanceExperimental.openAiDot.title")}
          description={t("settings.instanceExperimental.openAiDot.description")}
          footnote={t("settings.instanceExperimental.openAiDot.footnote")}
          checked={experimentalQuery.data?.enableOpenAiDot === true}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableOpenAiDot: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableOpenAiDot"
          managed={managedKeys.enableOpenAiDot}
          ariaLabel={t("settings.instanceExperimental.openAiDot.ariaLabel")}
        />


        <ExperimentalToggleCard
          title={t("settings.instanceExperimental.nativeRunner.title")}
          description={t("settings.instanceExperimental.nativeRunner.description")}
          checked={enableNativeRunner}
          onCheckedChange={(checked) =>
            toggleMutation.mutate({ enableNativeRunner: checked })
          }
          disabled={toggleMutation.isPending}
          settingKey="enableNativeRunner"
          managed={managedKeys.enableNativeRunner}
          ariaLabel={t("settings.instanceExperimental.nativeRunner.ariaLabel")}
        />

        <ExperimentalToggleCard
          title={t("settings.instanceExperimental.simplifiedEnglish.title")}
          description={t("settings.instanceExperimental.simplifiedEnglish.description")}
          checked={enableSimplifiedEnglishInteractions}
          onCheckedChange={(checked) =>
            toggleMutation.mutate({ enableSimplifiedEnglishInteractions: checked })
          }
          disabled={toggleMutation.isPending}
          settingKey="enableSimplifiedEnglishInteractions"
          managed={managedKeys.enableSimplifiedEnglishInteractions}
          ariaLabel={t("settings.instanceExperimental.simplifiedEnglish.ariaLabel")}
        />

        <ExperimentalToggleCard
          title={t("settings.instanceExperimental.statusCards.title")}
          description={t("settings.instanceExperimental.statusCards.description")}
          footnote={t("settings.instanceExperimental.statusCards.footnote")}
          checked={enableStatusCards}
          onCheckedChange={(checked) =>
            toggleMutation.mutate(
              checked
                ? { enableSummaries: true, enableStatusCards: true }
                : { enableStatusCards: false },
            )
          }
          disabled={toggleMutation.isPending || statusCardsBlockedByManagedSummaries}
          settingKey="enableStatusCards"
          managed={managedKeys.enableStatusCards}
          ariaLabel={t("settings.instanceExperimental.statusCards.ariaLabel")}
        />

        <ExperimentalToggleCard
          title={t("settings.instanceExperimental.streamlinedUi.title")}
          description={t("settings.instanceExperimental.streamlinedUi.description")}
          footnote={t("settings.instanceExperimental.streamlinedUi.footnote")}
          checked={enableStreamlinedUi}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableStreamlinedUi: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableStreamlinedUi"
          managed={managedKeys.enableStreamlinedUi}
          ariaLabel={t("settings.instanceExperimental.streamlinedUi.ariaLabel")}
        />

        <ExperimentalToggleCard
          title={t("settings.instanceExperimental.summaries.title")}
          description={t("settings.instanceExperimental.summaries.description")}
          footnote={t("settings.instanceExperimental.summaries.footnote")}
          checked={enableSummaries}
          onCheckedChange={(checked) =>
            toggleMutation.mutate(
              checked || !enableStatusCards
                ? { enableSummaries: checked }
                : { enableSummaries: false, enableStatusCards: false },
            )
          }
          disabled={toggleMutation.isPending || summariesRequiredByManagedStatusCards}
          settingKey="enableSummaries"
          managed={managedKeys.enableSummaries}
          ariaLabel={t("settings.instanceExperimental.summaries.ariaLabel")}
        />

        {enableIsolatedWorkspaces && (
          <ExperimentalToggleCard
            title={t("settings.instanceExperimental.isolatedWorkspacesByDefault.title")}
            description={t("settings.instanceExperimental.isolatedWorkspacesByDefault.description")}
            checked={enableIsolatedWorkspacesByDefault}
            onCheckedChange={(checked) =>
              toggleMutation.mutate({ enableIsolatedWorkspacesByDefault: checked })
            }
            disabled={toggleMutation.isPending}
            settingKey="enableIsolatedWorkspacesByDefault"
            managed={managedKeys.enableIsolatedWorkspacesByDefault}
            ariaLabel={t("settings.instanceExperimental.isolatedWorkspacesByDefault.ariaLabel")}
          />
        )}
      </section>

      {showDeveloperSection ? (
        <section className="space-y-3" aria-labelledby="developer-mode-heading">
          <div className="space-y-1">
            <h2 id="developer-mode-heading" className="text-sm font-semibold">
              Paperclip Developer Mode
            </h2>
            <p className="text-sm text-muted-foreground">
              Internal tools for developing, testing, and debugging Paperclip.
            </p>
          </div>

          <ExperimentalToggleCard
            title={t("settings.instanceExperimental.autoRestartDevServer.title")}
            description={t("settings.instanceExperimental.autoRestartDevServer.description")}
            checked={autoRestartDevServerWhenIdle}
            onCheckedChange={(checked) =>
              toggleMutation.mutate({ autoRestartDevServerWhenIdle: checked })
            }
            disabled={toggleMutation.isPending}
            settingKey="autoRestartDevServerWhenIdle"
            managed={managedKeys.autoRestartDevServerWhenIdle}
            ariaLabel={t("settings.instanceExperimental.autoRestartDevServer.ariaLabel")}
          />

          <ExperimentalToggleCard
            title={t("settings.instanceExperimental.managedSandboxOnly.title")}
            description={t("settings.instanceExperimental.managedSandboxOnly.description")}
            checked={enableManagedSandboxOnly}
            onCheckedChange={(checked) =>
              toggleMutation.mutate({ enableManagedSandboxOnly: checked })
            }
            disabled={toggleMutation.isPending}
            settingKey="enableManagedSandboxOnly"
            managed={managedKeys.enableManagedSandboxOnly}
            ariaLabel={t("settings.instanceExperimental.managedSandboxOnly.ariaLabel")}
          />

          <ExperimentalToggleCard
            title={t("settings.instanceExperimental.developerMode.title")}
            description={t("settings.instanceExperimental.developerMode.description")}
            checked={enablePaperclipDeveloperMode}
            onCheckedChange={(checked) =>
              toggleMutation.mutate({ enablePaperclipDeveloperMode: checked })
            }
            disabled={toggleMutation.isPending}
            settingKey="enablePaperclipDeveloperMode"
            managed={managedKeys.enablePaperclipDeveloperMode}
            ariaLabel={t("settings.instanceExperimental.developerMode.ariaLabel")}
          />

          {showWorktreeRunExecution ? (
            <Card className="block bg-transparent p-5">
              <div className="flex flex-col gap-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold">{t("settings.instanceExperimental.worktreeRunExecution.title")}</h3>
                      {worktreeRunExecutionManaged ? <ManagedByCloudBadge /> : null}
                    </div>
                    <p className="max-w-2xl text-sm text-muted-foreground">
                      This is an isolated git-worktree preview instance. Turn this on to let the scheduler execute runs
                      here. Only tasks created after enabling will run automatically — copied/pre-existing tasks stay
                      parked. Toggling off and on resets the cutoff.
                    </p>
                  </div>
                  <ToggleSwitch
                    checked={enableWorktreeRunExecution}
                    onCheckedChange={(checked) => {
                      if (worktreeRunExecutionManaged) return;
                      toggleMutation.mutate({ enableWorktreeRunExecution: checked });
                    }}
                    disabled={toggleMutation.isPending || worktreeRunExecutionManaged}
                    aria-label={t("settings.instanceExperimental.worktreeRunExecution.ariaLabel")}
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
                      <p className="font-medium text-foreground">{t("settings.instanceExperimental.worktreeRunExecution.suppressedTitle")}</p>
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

          <ExperimentalToggleCard
            title={t("settings.instanceExperimental.serverInfoDebugView.title")}
            description='Show a "Server" section in the account drawer with the current server restart time and running commit.'
            checked={enableServerInfoDebugView}
            onCheckedChange={(checked) =>
              toggleMutation.mutate({ enableServerInfoDebugView: checked })
            }
            disabled={toggleMutation.isPending}
            settingKey="enableServerInfoDebugView"
            managed={managedKeys.enableServerInfoDebugView}
            ariaLabel={t("settings.instanceExperimental.serverInfoDebugView.ariaLabel")}
          />

          <ExperimentalToggleCard
            title={t("settings.instanceExperimental.smokeLab.title")}
            description='Add a "Smoke Lab" tab under Apps → Developer and an "Integration smoke" card on the dashboard for exercising every integration path against deterministic local fixtures (fake OAuth provider + loopback MCP servers). Private (non-public) deployments only.'
            checked={enableSmokeLab}
            onCheckedChange={(checked) => toggleMutation.mutate({ enableSmokeLab: checked })}
            disabled={toggleMutation.isPending}
            settingKey="enableSmokeLab"
            managed={managedKeys.enableSmokeLab}
            ariaLabel={t("settings.instanceExperimental.smokeLab.ariaLabel")}
          />

          <ExperimentalToggleCard
            title={t("settings.instanceExperimental.issuePlanDecompositions.title")}
            description={t("settings.instanceExperimental.issuePlanDecompositions.description")}
            checked={enableIssuePlanDecompositions}
            onCheckedChange={(checked) =>
              toggleMutation.mutate({ enableIssuePlanDecompositions: checked })
            }
            disabled={toggleMutation.isPending}
            settingKey="enableIssuePlanDecompositions"
            managed={managedKeys.enableIssuePlanDecompositions}
            ariaLabel={t("settings.instanceExperimental.issuePlanDecompositions.ariaLabel")}
          />
        </section>
      ) : null}

      {showLegacySection ? (
        <section className="space-y-3" aria-labelledby="legacy-heading">
          <div className="space-y-1">
            <h2 id="legacy-heading" className="text-sm font-semibold">
              Legacy
            </h2>
            <p className="text-sm text-muted-foreground">These features are going to be removed.</p>
          </div>

          <ExperimentalToggleCard
            title={t("settings.instanceExperimental.classicTaskInterface.title")}
            description={t("settings.instanceExperimental.classicTaskInterface.description")}
            footnote={t("settings.instanceExperimental.classicTaskInterface.footnote")}
            checked={enableClassicTaskInterface}
            onCheckedChange={(checked) =>
              toggleMutation.mutate({ enableClassicTaskInterface: checked })
            }
            disabled={toggleMutation.isPending}
            settingKey="enableClassicTaskInterface"
            managed={managedKeys.enableClassicTaskInterface}
            ariaLabel={t("settings.instanceExperimental.classicTaskInterface.ariaLabel")}
          />

          <ExperimentalToggleCard
            title={t("settings.instanceExperimental.goalsSidebarLink.title")}
            description={t("settings.instanceExperimental.goalsSidebarLink.description")}
            checked={enableGoalsSidebarLink}
            onCheckedChange={(checked) =>
              toggleMutation.mutate({ enableGoalsSidebarLink: checked })
            }
            disabled={toggleMutation.isPending}
            settingKey="enableGoalsSidebarLink"
            managed={managedKeys.enableGoalsSidebarLink}
            ariaLabel={t("settings.instanceExperimental.goalsSidebarLink.ariaLabel")}
          />
        </section>
      ) : null}
    </div>
  );
}
