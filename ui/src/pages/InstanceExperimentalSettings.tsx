import { Trans, useTranslation } from "react-i18next";
import { useEffect, useState, type ReactNode } from "react";
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

function formatActivationTimestamp(iso: string, locale: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

// PAP-11233: keep Conference Room code intact, but hide the user-facing opt-in for now.
const SHOW_CONFERENCE_ROOM_EXPERIMENTAL_SETTING = false;

function ManagedByCloudBadge() {
  const { t, i18n } = useTranslation("settings");
  return (
    <Badge variant="outline" className="text-muted-foreground">
      <Lock aria-hidden="true" />{t("instanceExperimentalSettings.managed_by_paperclip_cloud")}</Badge>
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
  const { t, i18n } = useTranslation("settings");
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const { hidden: hiddenSettings } = useHiddenSettings();
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: t("instanceExperimentalSettings.settings"), href: "/company/settings" },
      { label: t("instanceExperimentalSettings.experimental") },
    ]);
  }, [t, setBreadcrumbs]);

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
        <div className="text-sm text-muted-foreground">{t("instanceExperimentalSettings.loading_experimental_settings")}</div>
      </div>
    );
  }

  if (experimentalView.kind === "error") {
    return (
<div className="max-w-6xl space-y-6"><ClassicWorkspaceSetting key="personal-workspace" />      <QueryErrorState
        size="page"
        error={experimentalQuery.error}
        action={t("instanceExperimentalSettings.load_experimental_settings")}
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
          <h1 className="text-lg font-semibold">{t("instanceExperimentalSettings.experimental")}</h1>
        </div>
        <p className="text-sm text-muted-foreground">{t("instanceExperimentalSettings.opt_into_features_that_are_still_being_evaluated_before")}</p>
      </div>

      <ClassicWorkspaceSetting key="personal-workspace" />

      <div
        role="alert"
        className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3"
      >
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
          <div className="space-y-1 text-sm">
            <p className="font-medium text-foreground">{t("instanceExperimentalSettings.experimental_features_may_break_at_any_time")}</p>
            <p className="text-muted-foreground">{t("instanceExperimentalSettings.these_features_are_opt_in_and_come_with_no")}</p>
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
          <h2 id="experimental-features-heading" className="text-sm font-semibold">{t("instanceExperimentalSettings.experimental_features")}</h2>
          <p className="text-sm text-muted-foreground">{t("instanceExperimentalSettings.optional_product_features_that_are_still_being_evaluated")}</p>
        </div>

        <ExperimentalToggleCard
          title={t("instanceExperimentalSettings.assistant_connections_mcp")}
          description={t("instanceExperimentalSettings.connect_codex_claude_and_other_assistants_to_your_paperclip")}
          footnote={<>Requires an authenticated instance with a configured public URL. Takes effect immediately. Turning this off blocks assistant calls and event delivery; work already delegated continues.{experimentalQuery.data?.enablePublicMcp && <> <Link className="underline" to="/apps/assistant-connection">{t("instanceExperimentalSettings.set_up_an_assistant_connection")}</Link></>}</>}
          checked={experimentalQuery.data?.enablePublicMcp === true}
          onCheckedChange={(checked) => toggleMutation.mutate({ enablePublicMcp: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enablePublicMcp"
          managed={managedKeys.enablePublicMcp}
          ariaLabel={t("instanceExperimentalSettings.toggle_assistant_connections_experimental_setting")}
        />

        <ExperimentalToggleCard
          title={t("instanceExperimentalSettings.beta_skills")}
          description={t("instanceExperimentalSettings.allow_agents_to_pin_beta_releases_of_the_paperclip")}
          checked={enableBetaSkills}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableBetaSkills: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableBetaSkills"
          managed={managedKeys.enableBetaSkills}
          ariaLabel={t("instanceExperimentalSettings.toggle_beta_skills_experimental_setting")}
        />

        <ExperimentalToggleCard
          title={t("instanceExperimentalSettings.built_in_agents")}
          description={t("instanceExperimentalSettings.show_paperclip_managed_built_in_agent_surfaces_including_built")}
          checked={enableBuiltInAgents}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableBuiltInAgents: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableBuiltInAgents"
          managed={managedKeys.enableBuiltInAgents}
          ariaLabel={t("instanceExperimentalSettings.toggle_built_in_agents_experimental_setting")}
        />

        <ExperimentalToggleCard
          title={t("instanceExperimentalSettings.cases")}
          description={t("instanceExperimentalSettings.durable_work_products_blog_posts_tweet_storms_that_tasks")}
          footnote={t("instanceExperimentalSettings.turning_cases_off_hides_the_tab_and_blocks_the")}
          checked={enableCases}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableCases: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableCases"
          managed={managedKeys.enableCases}
          ariaLabel={t("instanceExperimentalSettings.toggle_cases_experimental_setting")}
        />

        <ExperimentalToggleCard
          title={t("instanceExperimentalSettings.chat_connectors")}
          description={t("instanceExperimentalSettings.connect_agents_to_slack_discord_microsoft_teams_and_telegram")}
          footnote={t("instanceExperimentalSettings.turning_this_off_hides_experimental_chat_setup_and_connected")}
          checked={enableChatConnectors}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableChatConnectors: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableChatConnectors"
          managed={managedKeys.enableChatConnectors}
          ariaLabel={t("instanceExperimentalSettings.toggle_chat_connectors_experimental_setting")}
        />

        <ExperimentalToggleCard
          title={t("instanceExperimentalSettings.combined_inbox_task_list")}
          description="In the Classic workspace, fold Inbox into Tasks. One Tasks row carries the unread badge, and a Views menu reaches every personal and organization task view."
          footnote="Coordinator always includes personal views in Tasks. For Classic, turning this off restores its separate Inbox. No data changes."
          checked={experimentalQuery.data?.enableCombinedInboxTasks ?? false}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableCombinedInboxTasks: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableCombinedInboxTasks"
          managed={managedKeys.enableCombinedInboxTasks}
          ariaLabel={t("instanceExperimentalSettings.toggle_combined_inbox_and_task_list_experimental_setting")}
        />

        {SHOW_CONFERENCE_ROOM_EXPERIMENTAL_SETTING ? (
          <ExperimentalToggleCard
            title={t("instanceExperimentalSettings.conference_room_chat")}
            description={t("instanceExperimentalSettings.adds_a_conference_room_one_chat_where_you_and")}
            checked={enableConferenceRoomChat}
            onCheckedChange={(checked) => toggleMutation.mutate({ enableConferenceRoomChat: checked })}
            disabled={toggleMutation.isPending}
            settingKey="enableConferenceRoomChat"
            managed={managedKeys.enableConferenceRoomChat}
            ariaLabel={t("instanceExperimentalSettings.toggle_conference_room_chat_experimental_setting")}
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
          title={t("instanceExperimentalSettings.decisions")}
          description={t("instanceExperimentalSettings.show_the_decisions_item_in_the_main_sidebar_the")}
          checked={enableDecisions}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableDecisions: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableDecisions"
          managed={managedKeys.enableDecisions}
          ariaLabel={t("instanceExperimentalSettings.toggle_decisions_experimental_setting")}
        />

        <ExperimentalToggleCard
          title={t("instanceExperimentalSettings.enable_environments")}
          description={t("instanceExperimentalSettings.show_environment_management_in_company_settings_and_allow_project")}
          checked={enableEnvironments}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableEnvironments: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableEnvironments"
          managed={managedKeys.enableEnvironments}
          ariaLabel={t("instanceExperimentalSettings.toggle_environments_experimental_setting")}
        />

        <ExperimentalToggleCard
          title={t("instanceExperimentalSettings.enable_external_objects")}
          description={t("instanceExperimentalSettings.detect_external_urls_in_issues_and_show_resolved_status")}
          checked={enableExternalObjects}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableExternalObjects: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableExternalObjects"
          managed={managedKeys.enableExternalObjects}
          ariaLabel={t("instanceExperimentalSettings.toggle_external_objects_experimental_setting")}
        />

        <ExperimentalToggleCard
          title={t("instanceExperimentalSettings.enable_isolated_workspaces")}
          description={t("instanceExperimentalSettings.show_execution_workspace_controls_in_project_configuration_and_allow")}
          checked={enableIsolatedWorkspaces}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableIsolatedWorkspaces: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableIsolatedWorkspaces"
          managed={managedKeys.enableIsolatedWorkspaces}
          ariaLabel={t("instanceExperimentalSettings.toggle_isolated_workspaces_experimental_setting")}
        />

        <ExperimentalToggleCard
          title={t("instanceExperimentalSettings.experimental_fast_responses")}
          description={t("instanceExperimentalSettings.allow_short_acknowledgements_while_agents_begin_work_configure_them")}
          checked={experimentalQuery.data?.enableFastResponses ?? false}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableFastResponses: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableFastResponses"
          managed={managedKeys.enableFastResponses}
          ariaLabel={t("instanceExperimentalSettings.toggle_fast_responses_experimental_setting")}
        />

        <ExperimentalToggleCard
          title={t("instanceExperimentalSettings.experimental_file_viewer")}
          description={t("instanceExperimentalSettings.show_task_detail_controls_for_browsing_and_previewing_workspace")}
          checked={enableExperimentalFileViewer}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableExperimentalFileViewer: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableExperimentalFileViewer"
          managed={managedKeys.enableExperimentalFileViewer}
          ariaLabel={t("instanceExperimentalSettings.toggle_experimental_file_viewer_setting")}
        />

        <ExperimentalToggleCard
          title={t("instanceExperimentalSettings.first_task_propose_with_a_plan_document")}
          description={t("instanceExperimentalSettings.when_the_user_s_first_request_is_a_single")}
          checked={enableFirstTaskPlanProposal}
          onCheckedChange={(checked) =>
            toggleMutation.mutate({ enableFirstTaskPlanProposal: checked })
          }
          disabled={toggleMutation.isPending}
          settingKey="enableFirstTaskPlanProposal"
          managed={managedKeys.enableFirstTaskPlanProposal}
          ariaLabel={t("instanceExperimentalSettings.toggle_first_task_plan_proposal_experimental_setting")}
        />

        <ExperimentalToggleCard
          title={t("instanceExperimentalSettings.github_review_bots")}
          description={t("instanceExperimentalSettings.connect_agents_to_github_with_their_own_app_identity")}
          footnote={t("instanceExperimentalSettings.independent_of_chat_connectors_turning_this_off_hides_setup")}
          checked={experimentalQuery.data?.enableGitHubReviewBots === true}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableGitHubReviewBots: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableGitHubReviewBots"
          managed={managedKeys.enableGitHubReviewBots}
          ariaLabel={t("instanceExperimentalSettings.toggle_github_review_bots_experimental_setting")}
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
          title={t("instanceExperimentalSettings.grok_bot")}
          description={t("instanceExperimentalSettings.connect_an_existing_grok_bot_as_an_agent_verify")}
          footnote={t("instanceExperimentalSettings.requires_assistant_connections_mcp_paperclip_runner_and_authenticated_public")}
          checked={experimentalQuery.data?.enableGrokBot === true}
          onCheckedChange={checked => toggleMutation.mutate({ enableGrokBot: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableGrokBot" managed={managedKeys.enableGrokBot}
          ariaLabel={t("instanceExperimentalSettings.toggle_grok_bot_experimental_setting")}
        />


        <ExperimentalToggleCard
          title={t("instanceExperimentalSettings.memory_connectors")}
          description={t("instanceExperimentalSettings.connect_mem0_zep_supermemory_cognee_and_honcho_for_long")}
          footnote={t("instanceExperimentalSettings.turning_this_off_hides_setup_for_these_connectors_existing")}
          checked={experimentalQuery.data?.enableMemoryConnectors === true}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableMemoryConnectors: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableMemoryConnectors"
          managed={managedKeys.enableMemoryConnectors}
          ariaLabel={t("instanceExperimentalSettings.toggle_memory_connectors_experimental_setting")}
        />

        <ExperimentalToggleCard
          title={t("instanceExperimentalSettings.muse_personal_agent")}
          description={t("instanceExperimentalSettings.connect_your_personal_meta_muse_pair_it_detect_its")}
          footnote={t("instanceExperimentalSettings.requires_paperclip_runner_and_an_authenticated_instance_with_a")}
          checked={experimentalQuery.data?.enableMuse === true}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableMuse: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableMuse"
          managed={managedKeys.enableMuse}
          ariaLabel={t("instanceExperimentalSettings.toggle_muse_experimental_setting")}
        />

        <ExperimentalToggleCard
          title="OpenAI Dot"
          description={t("instanceExperimentalSettings.add_openai_dot_as_a_standalone_agent_choice_pair")}
          footnote={t("instanceExperimentalSettings.requires_assistant_connections_mcp_and_an_authenticated_instance_with")}
          checked={experimentalQuery.data?.enableOpenAiDot === true}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableOpenAiDot: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableOpenAiDot"
          managed={managedKeys.enableOpenAiDot}
          ariaLabel={t("instanceExperimentalSettings.toggle_openai_dot_experimental_setting")}
        />


        <ExperimentalToggleCard
          title="Paperclip Runner"
          description={t("instanceExperimentalSettings.allow_agents_to_select_paperclip_runner_including_authenticated_runner")}
          checked={enableNativeRunner}
          onCheckedChange={(checked) =>
            toggleMutation.mutate({ enableNativeRunner: checked })
          }
          disabled={toggleMutation.isPending}
          settingKey="enableNativeRunner"
          managed={managedKeys.enableNativeRunner}
          ariaLabel={t("instanceExperimentalSettings.toggle_paperclip_runner_experimental_setting")}
        />

        <ExperimentalToggleCard
          title={t("instanceExperimentalSettings.simplified_english_interactions")}
          description={t("instanceExperimentalSettings.instruct_agents_to_write_user_interactions_plan_confirmations_questions")}
          checked={enableSimplifiedEnglishInteractions}
          onCheckedChange={(checked) =>
            toggleMutation.mutate({ enableSimplifiedEnglishInteractions: checked })
          }
          disabled={toggleMutation.isPending}
          settingKey="enableSimplifiedEnglishInteractions"
          managed={managedKeys.enableSimplifiedEnglishInteractions}
          ariaLabel={t("instanceExperimentalSettings.toggle_simplified_english_interactions_experimental_setting")}
        />

        <ExperimentalToggleCard
          title={t("instanceExperimentalSettings.status_cards")}
          description={t("instanceExperimentalSettings.enable_the_experimental_shared_status_card_board_and_its")}
          footnote={t("instanceExperimentalSettings.enabling_status_cards_also_enables_summaries")}
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
          ariaLabel={t("instanceExperimentalSettings.toggle_status_cards_experimental_setting")}
        />

        <ExperimentalToggleCard
          title={t("instanceExperimentalSettings.streamlined_ui")}
          description={t("instanceExperimentalSettings.use_the_simplified_main_sidebar_shared_tasks_and_inbox")}
          footnote={t("instanceExperimentalSettings.turning_this_off_restores_the_legacy_shell_and_navigation")}
          checked={enableStreamlinedUi}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableStreamlinedUi: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableStreamlinedUi"
          managed={managedKeys.enableStreamlinedUi}
          ariaLabel={t("instanceExperimentalSettings.toggle_streamlined_ui_experimental_setting")}
        />

        <ExperimentalToggleCard
          title={t("instanceExperimentalSettings.summaries")}
          description={t("instanceExperimentalSettings.show_summarizer_generated_status_slots_on_project_and_workspace")}
          footnote={t("instanceExperimentalSettings.status_cards_requires_summaries_disabling_summaries_also_disables_status")}
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
          ariaLabel={t("instanceExperimentalSettings.toggle_summaries_experimental_setting")}
        />

        {enableIsolatedWorkspaces && (
          <ExperimentalToggleCard
            title={t("instanceExperimentalSettings.use_isolated_workspaces_by_default")}
            description={t("instanceExperimentalSettings.treat_a_project_that_has_no_execution_workspace_policy")}
            checked={enableIsolatedWorkspacesByDefault}
            onCheckedChange={(checked) =>
              toggleMutation.mutate({ enableIsolatedWorkspacesByDefault: checked })
            }
            disabled={toggleMutation.isPending}
            settingKey="enableIsolatedWorkspacesByDefault"
            managed={managedKeys.enableIsolatedWorkspacesByDefault}
            ariaLabel={t("instanceExperimentalSettings.toggle_isolated_workspaces_by_default_experimental_setting")}
          />
        )}
      </section>

      {showDeveloperSection ? (
        <section className="space-y-3" aria-labelledby="developer-mode-heading">
          <div className="space-y-1">
            <h2 id="developer-mode-heading" className="text-sm font-semibold">{t("instanceExperimentalSettings.paperclip_developer_mode")}</h2>
            <p className="text-sm text-muted-foreground">{t("instanceExperimentalSettings.internal_tools_for_developing_testing_and_debugging_paperclip")}</p>
          </div>

          <ExperimentalToggleCard
            title={t("instanceExperimentalSettings.auto_restart_dev_server_when_idle")}
            description={t("instanceExperimentalSettings.in_pnpm_dev_once_wait_for_all_queued_and")}
            checked={autoRestartDevServerWhenIdle}
            onCheckedChange={(checked) =>
              toggleMutation.mutate({ autoRestartDevServerWhenIdle: checked })
            }
            disabled={toggleMutation.isPending}
            settingKey="autoRestartDevServerWhenIdle"
            managed={managedKeys.autoRestartDevServerWhenIdle}
            ariaLabel={t("instanceExperimentalSettings.toggle_guarded_dev_server_auto_restart")}
          />

          <ExperimentalToggleCard
            title={t("instanceExperimentalSettings.managed_environment_only")}
            description={t("instanceExperimentalSettings.hide_the_local_environment_and_run_all_agents_in")}
            checked={enableManagedSandboxOnly}
            onCheckedChange={(checked) =>
              toggleMutation.mutate({ enableManagedSandboxOnly: checked })
            }
            disabled={toggleMutation.isPending}
            settingKey="enableManagedSandboxOnly"
            managed={managedKeys.enableManagedSandboxOnly}
            ariaLabel={t("instanceExperimentalSettings.toggle_managed_environment_only_experimental_setting")}
          />

          <ExperimentalToggleCard
            title={t("instanceExperimentalSettings.paperclip_developer_mode")}
            description={t("instanceExperimentalSettings.show_internal_paperclip_maintainer_tools_and_observability_links_including")}
            checked={enablePaperclipDeveloperMode}
            onCheckedChange={(checked) =>
              toggleMutation.mutate({ enablePaperclipDeveloperMode: checked })
            }
            disabled={toggleMutation.isPending}
            settingKey="enablePaperclipDeveloperMode"
            managed={managedKeys.enablePaperclipDeveloperMode}
            ariaLabel={t("instanceExperimentalSettings.toggle_paperclip_developer_mode_experimental_setting")}
          />

          {showWorktreeRunExecution ? (
            <Card className="block bg-transparent p-5">
              <div className="flex flex-col gap-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold">{t("instanceExperimentalSettings.run_tasks_in_this_worktree")}</h3>
                      {worktreeRunExecutionManaged ? <ManagedByCloudBadge /> : null}
                    </div>
                    <p className="max-w-2xl text-sm text-muted-foreground">{t("instanceExperimentalSettings.this_is_an_isolated_git_worktree_preview_instance_turn")}</p>
                  </div>
                  <ToggleSwitch
                    checked={enableWorktreeRunExecution}
                    onCheckedChange={(checked) => {
                      if (worktreeRunExecutionManaged) return;
                      toggleMutation.mutate({ enableWorktreeRunExecution: checked });
                    }}
                    disabled={toggleMutation.isPending || worktreeRunExecutionManaged}
                    aria-label={t("instanceExperimentalSettings.toggle_worktree_run_execution_setting")}
                  />
                </div>

                {worktreeRunExecutionState.kind === "armed" ? (
                  <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-foreground">
                    <Play className="h-4 w-4 shrink-0 text-emerald-600" />
                    <span><Trans t={t} i18nKey="instanceExperimentalSettings.runningAfter" values={{ date: formatActivationTimestamp(worktreeRunExecutionState.activatedAt, i18n.language) }} components={{ date: <span className="font-medium" /> }} />
                    </span>
                  </div>
                ) : null}

                {worktreeRunExecutionState.kind === "fail_closed" ? (
                  <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
                    <div className="space-y-0.5">
                      <p className="font-medium text-foreground">{t("instanceExperimentalSettings.execution_is_suppressed_effectively_off")}</p>
                      <p className="text-muted-foreground">
                        {worktreeRunExecutionState.reason === "instance_mismatch"
                          ? t("instanceExperimentalSettings.this_setting_was_armed_in_a_different_instance_and")
                          : t("instanceExperimentalSettings.this_setting_is_missing_its_activation_cutoff_so_no")}{" "}{t("instanceExperimentalSettings.toggle_it_off_and_back_on_to_arm_execution")}</p>
                    </div>
                  </div>
                ) : null}
              </div>
            </Card>
          ) : null}

          <ExperimentalToggleCard
            title={t("instanceExperimentalSettings.server_info_debug_view")}
            description={t("instanceExperimentalSettings.show_a_server_section_in_the_account_drawer_with")}
            checked={enableServerInfoDebugView}
            onCheckedChange={(checked) =>
              toggleMutation.mutate({ enableServerInfoDebugView: checked })
            }
            disabled={toggleMutation.isPending}
            settingKey="enableServerInfoDebugView"
            managed={managedKeys.enableServerInfoDebugView}
            ariaLabel={t("instanceExperimentalSettings.toggle_server_info_debug_view_experimental_setting")}
          />

          <ExperimentalToggleCard
            title={t("instanceExperimentalSettings.smoke_lab")}
            description={t("instanceExperimentalSettings.add_a_smoke_lab_tab_under_apps_developer_and")}
            checked={enableSmokeLab}
            onCheckedChange={(checked) => toggleMutation.mutate({ enableSmokeLab: checked })}
            disabled={toggleMutation.isPending}
            settingKey="enableSmokeLab"
            managed={managedKeys.enableSmokeLab}
            ariaLabel={t("instanceExperimentalSettings.toggle_smoke_lab_experimental_setting")}
          />

          <ExperimentalToggleCard
            title={t("instanceExperimentalSettings.task_plan_decomposition")}
            description={t("instanceExperimentalSettings.show_accepted_plan_decomposition_history_on_task_detail_pages")}
            checked={enableIssuePlanDecompositions}
            onCheckedChange={(checked) =>
              toggleMutation.mutate({ enableIssuePlanDecompositions: checked })
            }
            disabled={toggleMutation.isPending}
            settingKey="enableIssuePlanDecompositions"
            managed={managedKeys.enableIssuePlanDecompositions}
            ariaLabel={t("instanceExperimentalSettings.toggle_task_plan_decomposition_panel_experimental_setting")}
          />
        </section>
      ) : null}

      {showLegacySection ? (
        <section className="space-y-3" aria-labelledby="legacy-heading">
          <div className="space-y-1">
            <h2 id="legacy-heading" className="text-sm font-semibold">{t("instanceExperimentalSettings.legacy")}</h2>
            <p className="text-sm text-muted-foreground">{t("instanceExperimentalSettings.these_features_are_going_to_be_removed")}</p>
          </div>

          <ExperimentalToggleCard
            title={t("instanceExperimentalSettings.classic_task_interface")}
            description={t("instanceExperimentalSettings.restores_the_previous_task_detail_page_the_page_level")}
            footnote={t("instanceExperimentalSettings.switching_takes_effect_immediately_no_task_data_is_affected")}
            checked={enableClassicTaskInterface}
            onCheckedChange={(checked) =>
              toggleMutation.mutate({ enableClassicTaskInterface: checked })
            }
            disabled={toggleMutation.isPending}
            settingKey="enableClassicTaskInterface"
            managed={managedKeys.enableClassicTaskInterface}
            ariaLabel={t("instanceExperimentalSettings.toggle_classic_task_interface_experimental_setting")}
          />

          <ExperimentalToggleCard
            title={t("instanceExperimentalSettings.goals_sidebar_link")}
            description={t("instanceExperimentalSettings.restore_the_goals_item_in_the_main_sidebar_while")}
            checked={enableGoalsSidebarLink}
            onCheckedChange={(checked) =>
              toggleMutation.mutate({ enableGoalsSidebarLink: checked })
            }
            disabled={toggleMutation.isPending}
            settingKey="enableGoalsSidebarLink"
            managed={managedKeys.enableGoalsSidebarLink}
            ariaLabel={t("instanceExperimentalSettings.toggle_goals_sidebar_link_experimental_setting")}
          />
        </section>
      ) : null}
    </div>
  );
}
