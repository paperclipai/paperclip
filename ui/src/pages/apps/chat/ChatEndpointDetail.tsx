import { getPageValueLabel } from "@/pages/tools/shared";
import { t as finalPagesT } from "@/i18n";
import { useTranslation, t as translate } from "@/i18n";
import { SpekoPhoneLine } from "@/components/voice/SpekoPhoneLine";
import { SpekoIncomingCalls } from "@/components/voice/SpekoIncomingCalls";
import { SpekoCallActivityItem, SpekoUnapprovedCallActivityItem, useSpekoCallHistory } from "@/components/voice/SpekoCallHistory";
import { SpekoPhoneCallback } from "@/components/voice/SpekoPhoneCallback";
import { deriveInitials } from "@/components/Identity";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { agentAvatarUrl } from "@/lib/agent-avatar-url";
import { resolveAgentAppearance } from "@paperclipai/shared";
import { SlackTestMessageButton } from "./SlackTestMessageButton";
import { slackConversationUrl } from "./slack/conversation-url";
import { useAccountIdentity } from "@/api/companies-query";
import { AgentAvatar } from "@/components/AgentAvatar";
import { SlackSetupAdvanced } from "./SlackAppDetails";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { SlackToolsSettings, SlackSearchAccess } from "./SlackToolSettings";
import { ChatCommunicationInstructions } from "./ChatCommunicationInstructions";
import { ChatExecutionDefaults } from "./ChatExecutionDefaults";
import { agentsApi } from "@/api/agents";
import { ChatConversationList } from "./ChatConversationList";
import { GitHubConnectionRecoveryNotice } from "./GitHubConnectionRecovery";
import { GitHubBotManagement, GitHubReviews } from "./GitHubBotManagement";
import { GitHubBotMention, GitHubAppIdentityActions } from "./GitHubAppIdentity";
import { GitHubConnectionComplete, type GitHubConnectionCompleteLocationState } from "./GitHubConnectionComplete";
import { EmailEndpointSettings } from "./EmailEndpointSetup";
import { EmailConnectionAccess } from "@/components/EmailConnectionAccess";
import { emailApi } from "@/api/email";
import { toolsApi } from "@/api/tools";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  ChevronDown,
  Check,
  Activity as ActivityIcon,
  Copy,
  ExternalLink,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Trash2,
  Unlink,
} from "lucide-react";
import {
  chatEndpointsApi,
  type ChatActivityItem,
  type ChatEndpoint,
  type ChatEndpointResource,
  type ChatProvider,
} from "@/api/chatEndpoints";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { AppLogo } from "../AppLogo";
import { StatusBadge } from "@/components/StatusBadge";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useToast } from "@/context/ToastContext";
import { formatDateTime } from "@/lib/utils";
import { queryKeys } from "@/lib/queryKeys";
import { copyTextToClipboard } from "@/lib/clipboard";
import { Link, Navigate, useLocation, useNavigate, useParams } from "@/lib/router";
import { describeError } from "@/api/errors";

const tabs = ["settings", "access", "reviews", "conversations", "activity"] as const;
type ChatTab = (typeof tabs)[number];
const tabItems = tabs.map((value) => ({
  value,
  label: value[0].toUpperCase() + value.slice(1),
}));
const providerNames: Record<ChatProvider, string> = {
  speko: "Speko",
  agentmail: "AgentMail",
  slack: "Slack",
  github: "GitHub",
  discord: "Discord",
  "microsoft-teams": "Microsoft Teams",
  telegram: "Telegram",
  "imessage-photon": "iMessage Photon",
};

const providerLifecycleGuidance: Record<
  ChatProvider,
  { reconnect: string; remove: string }
> = {
  speko: {
    get reconnect() { return translate("connections:reverify_this_voice_persona_and_update_its_11bec46"); },
    get remove() { return translate("connections:stop_this_connection_from_accepting_voice_requests_d2ecf1a"); },
  },
  agentmail: { get reconnect() { return translate("connections:reconnect_the_same_email_inbox_df88ba7"); }, get remove() { return translate("connections:disconnect_email_and_retain_task_history_d0d123c"); } },
  slack: {
    get reconnect() { return translate("connections:reconnect_verifies_or_replaces_credentials_for_this_cce40ff"); },
    get remove() { return translate("connections:paperclip_archives_the_endpoint_stops_new_ingress_cc2eda7"); },
  },
  github: {
    get reconnect() { return translate("connections:reconnect_verifies_this_same_app_and_installation_4673221"); },
    get remove() { return translate("connections:paperclip_archives_the_endpoint_stops_new_ingress_dc25ed4"); },
  },
  discord: {
    get reconnect() { return translate("connections:reconnect_verifies_this_same_discord_application_and_75cca54"); },
    get remove() { return translate("connections:paperclip_archives_the_endpoint_stops_its_paperclip_894d2b4"); },
  },
  "microsoft-teams": {
    get reconnect() { return translate("connections:reconnect_verifies_this_same_microsoft_app_tenant_2b4e6d4"); },
    get remove() { return translate("connections:paperclip_archives_the_endpoint_stops_new_ingress_2772470"); },
  },
  "imessage-photon": {
    get reconnect() { return translate("connections:reconnect_verifies_the_same_photon_project_and_ab0aec0"); },
    get remove() { return translate("connections:disconnect_archives_this_channel_and_removes_its_d19c106"); },
  },
  telegram: {
    get reconnect() { return translate("connections:reconnect_verifies_this_same_botfather_bot_and_18c937b"); },
    get remove() { return translate("connections:paperclip_archives_the_endpoint_and_queues_durable_d6184dd"); },
  },
};

const activityKindLabels: Record<ChatActivityItem["kind"], string> = {
  get delivery() { return translate("connections:inbound_delivery_98ef244"); },
  get publication() { return translate("connections:outbound_publication_652b94a"); },
  get action() { return translate("connections:provider_action_de0324b"); },
  get health() { return translate("connections:connection_health_6b91dcb"); },
  get repair() { return translate("connections:connection_repair_cdc4aea"); },
};

const replayableFailureStates = new Set(["failed"]);
// Provider callbacks do not necessarily emit a Board activity event. Refresh
// only mounted operational views, and stop polling when the browser is hidden.
const liveChatQueryOptions = {
  staleTime: 0,
  refetchInterval: 5_000,
  refetchIntervalInBackground: false,
} as const;

export function isReplayEligible(item: ChatActivityItem): boolean {
  if (
    item.fileTransfer ||
    !item.replayable ||
    !replayableFailureStates.has(item.status)
  ) {
    return false;
  }
  if (item.kind === "delivery") return item.status === "failed";
  return item.kind === "publication";
}

export function activityResolutionActions(item: ChatActivityItem) {
  const offered = item.resolutionActions ?? [];
  if (!item.fileTransfer) return offered;
  if (
    item.kind !== "publication" ||
    !Number.isSafeInteger(item.fileTransfer.version) ||
    item.fileTransfer.version < 1
  )
    return [];
  if (
    ![
      "consent_unknown",
      "upload_unknown",
      "file_info_unknown",
      "conflict",
    ].includes(item.fileTransfer.phase)
  )
    return [];
  // Only the file-info stage can use ordinary visible-delivery resolution.
  // Earlier consent/upload evidence must not be fabricated by these buttons.
  return item.fileTransfer.phase === "file_info_unknown"
    ? offered
    : offered.filter((action) => action === "cancel");
}

export function activityResolutionDescription(item: ChatActivityItem): string {
  const phase = item.fileTransfer?.phase;
  if (phase === "file_info_unknown")
    return translate("connections:the_file_upload_was_confirmed_but_its_f7ec34b");
  if (phase === "consent_unknown")
    return translate("connections:the_consent_card_may_have_reached_teams_6f60ecb");
  if (phase)
    return translate("connections:the_file_may_already_exist_in_onedrive_ebb2b6b");
  return translate("connections:paperclip_lost_confirmation_after_sending_check_the_6ab8b8c");
}

export function isResolutionEligible(item: ChatActivityItem): boolean {
  return (
    (item.kind === "publication" || item.kind === "action") &&
    item.status === "delivery_unknown" &&
    activityResolutionActions(item).length > 0
  );
}

export function isIndividuallyToggleableResource(
  provider: ChatProvider,
  resourceType: string,
): boolean {
  return !(
    provider === "microsoft-teams" &&
    (resourceType === "direct_message" || resourceType === "group_chat")
  );
}

function activityDetailLabel(item: ChatActivityItem): string {
  return replayableFailureStates.has(item.status) ? translate("connections:reason_f219cc0") : translate("connections:details_dc3decb");
}

export function connectionHealthPresentation(
  endpoint: Pick<ChatEndpoint, "status" | "healthMessage" | "lastError">,
) {
  // Health events outlive pause/removal. They are history, not lifecycle state.
  const lifecycleMessages = {
    draft: translate("connections:connection_setup_is_incomplete_c9edac6"),
    verifying: translate("connections:connection_verification_is_in_progress_2703ee4"),
    paused: translate("connections:connection_is_paused_resume_it_to_receive_0f7e786"),
    attention: translate("connections:connection_needs_attention_36c24f4"),
    revoked: translate("connections:connection_access_is_revoked_reconnect_to_verify_225ea4c"),
    archived: translate("connections:connection_has_been_removed_from_paperclip_626a32e"),
  };
  const lifecycleMessage =
    endpoint.status === "active" ? null : lifecycleMessages[endpoint.status];
  return {
    message: lifecycleMessage ?? endpoint.healthMessage ?? null,
    previousHealth: lifecycleMessage ? (endpoint.healthMessage ?? null) : null,
    error: endpoint.lastError ?? null,
    errorLabel: ["active", "attention", "revoked"].includes(endpoint.status)
      ? translate("connections:reason_f219cc0")
      : translate("connections:last_reported_error_aa3a0d7"),
  };
}

export function ChatEndpointDetail() {
  const { t } = useTranslation("connections");
  const { userId, settled: identitySettled } = useAccountIdentity();
  const { endpointId = "", tab: routeTab, reviewId } = useParams<{
    endpointId: string;
    tab?: string;
    reviewId?: string;
  }>();
  const tab = reviewId ? "reviews" : (routeTab ?? "settings");
  const activeTab = tabs.includes(tab as ChatTab) ? (tab as ChatTab) : null;
  const navigate = useNavigate();
  const location = useLocation();
  const heading = useRef<HTMLHeadingElement>(null);
  const completion = (location.state as GitHubConnectionCompleteLocationState | null)?.githubConnectionComplete;
  const { setBreadcrumbs } = useBreadcrumbs();
  const endpointQuery = useQuery({
    queryKey: queryKeys.chatEndpoints.detail(endpointId),
    queryFn: () => chatEndpointsApi.get(endpointId),
    enabled: Boolean(endpointId && activeTab),
    ...liveChatQueryOptions,
    refetchInterval:
      activeTab === "activity" || activeTab === "conversations"
        ? liveChatQueryOptions.refetchInterval
        : false,
  });
  const endpoint = endpointQuery.data;
  const endpointView = useQueryView(endpointQuery);
  const avatarAgent = useQuery({
    queryKey: queryKeys.agents.detail(endpoint?.assignedAgentId ?? ""),
    queryFn: () => agentsApi.get(endpoint!.assignedAgentId),
    enabled: endpoint?.provider === "github",
  });
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const agentQuery = useQuery({
    queryKey: queryKeys.agents.detail(endpoint?.assignedAgentId ?? ""),
    queryFn: () => agentsApi.get(endpoint!.assignedAgentId, endpoint!.companyId),
    enabled: Boolean(endpoint?.assignedAgentId),
  });

  useEffect(() => {
    if (!endpoint || !activeTab) return;
    setBreadcrumbs([
      { label: t("connectors_4b1e950"), href: "/apps" },
      {
        label: `${endpoint.assignedAgentName} · ${providerNames[endpoint.provider]}`,
        href: `/apps/chat/${endpoint.id}/settings`,
      },
      ...(reviewId ? [{ label: t("reviews_b83c4cd"), href: `/apps/chat/${endpoint.id}/reviews` }, { label: t("review_e29a79f") }] : [{
        label:
          tabItems.find((item) => item.value === activeTab)?.label ??
          t("settings_c7f73bb"),
      }]),
    ]);
    return () => setBreadcrumbs([]);
  }, [activeTab, endpoint, reviewId, setBreadcrumbs, t]);

  if (!activeTab)
    return <Navigate replace to={`/apps/chat/${endpointId}/settings`} />;
  if (endpointQuery.isLoading || endpointView.kind === "reconnecting")
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />{t("loading_connection_9c8c304")}</div>
    );
  if (endpointView.kind === "error" || !endpoint)
    return (
      <QueryErrorState
        size="page"
        error={endpointQuery.error}
        action="load the connection"
        onRetry={endpointView.retry}
        retrying={endpointView.isFetching}
      />
    );
  if (endpoint.provider === "agentmail" && activeTab === "settings")
    return <div className="space-y-7"><EmailEndpointSettings key={endpoint.id} endpointId={endpoint.id} companyId={endpoint.companyId} assignedAgentName={endpoint.assignedAgentName} /><EndpointExecutionDefaults endpoint={endpoint} /></div>;
  const setupIncomplete =
    endpoint.setup?.step !== "complete" &&
    !(endpoint.provider === "slack" && endpoint.setup?.step === "test") &&
    ["draft", "verifying", "attention", "revoked"].includes(endpoint.status);
  const slackAppId = endpoint.setup?.slackRegistration?.appId;
  const slackUrl = endpoint.provider === "slack"
    ? slackAppId ? `https://api.slack.com/apps/${encodeURIComponent(slackAppId)}/oauth` : "https://api.slack.com/apps"
    : null;

  return (
    <div className="max-w-5xl space-y-6 pb-12">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <AgentAvatar agent={agentQuery.data ?? { id: endpoint.assignedAgentId, name: endpoint.assignedAgentName }} size={endpoint.provider === "github" ? 64 : 48} />
          <div className="min-w-0">
          <h1 ref={heading} tabIndex={-1} className={endpoint.provider === "speko" ? "flex items-center gap-3 text-xl font-bold" : "text-xl font-bold"}>
            {endpoint.provider === "speko" && <AppLogo name="Speko" brandKey="speko" size={36} />}
            {endpoint.provider === "github" ? (endpoint.botLabel ?? endpoint.assignedAgentName) : endpoint.assignedAgentName}{endpoint.provider === "speko" ? t("in_speko_5074f0f") : ""}
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            {endpoint.provider === "github" ? <><AppLogo name="GitHub" brandKey="github" compact className="size-4! rounded-sm bg-transparent" /><Link to={`/agents/${endpoint.assignedAgentId}`} className="hover:underline">{endpoint.assignedAgentName}</Link>{endpoint.providerAccountLabel && <span>· {endpoint.providerAccountLabel}</span>}</> : endpoint.providerAccountLabel ?? (endpoint.provider === "agentmail" ? endpoint.botExternalId ?? t("email_connection_c9a0012") : t("chat_connection_da793d7"))}
          </p>
          {endpoint.provider === "github" && <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            <GitHubBotMention endpoint={endpoint} />
            <GitHubAppIdentityActions endpoint={endpoint} avatarUrl={avatarAgent.data ? agentAvatarUrl(resolveAgentAppearance(avatarAgent.data.appearance, endpoint.assignedAgentId), 512, 1, "rest") : undefined} />
          </div>}
          {endpoint.provider === "imessage-photon" && endpoint.botExternalId && endpoint.photonAllocation !== "shared" && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
              <span>{endpoint.botExternalId}</span>
              <Button variant="ghost" size="sm" aria-label={t("copy_dedicated_number_52aa863")} onClick={async () => {
                try { await copyTextToClipboard(endpoint.botExternalId!); setCopyStatus("Number copied"); }
                catch { setCopyStatus("Could not copy the number. Select and copy it manually."); }
              }}><Copy className="size-4" />{t("copy_number_65c817a")}</Button>
              <span role="status" className="text-muted-foreground">{copyStatus}</span>
            </div>
          )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {endpoint.provider === "speko" && <a href="https://platform.speko.ai/agents" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-primary underline">{t("open_speko_49b1d8e")}<ExternalLink className="size-3.5" aria-hidden="true" /></a>}
          {endpoint.provider === "slack" && !setupIncomplete && <Button asChild variant="outline"><a href={slackConversationUrl(endpoint, identitySettled ? userId : null)} target="_blank" rel="noopener noreferrer">{t("open_slack_8245d1b")}<ExternalLink className="size-4" /></a></Button>}
          {slackUrl && <Button asChild variant="outline"><a href={slackUrl} target="_blank" rel="noopener noreferrer">{t("open_slack_configuration_e34d036")}<ExternalLink className="size-4" /></a></Button>}
          {setupIncomplete ? (
            <Button
              variant="outline"
              onClick={() =>
                navigate(
                  `/apps/chat/connect?provider=${endpoint.provider}&purpose=chat&resume=${endpoint.id}`,
                )
              }
            >{t("continue_setup_5ce525c")}</Button>
          ) : null}
          {endpoint.status !== "active" && <StatusBadge status={endpoint.status} className={endpoint.provider === "speko" ? "text-foreground" : undefined} />}
        </div>
      </header>
      {endpoint.provider === "github" && <GitHubConnectionRecoveryNotice endpoint={endpoint} />}
      {activeTab === "settings" && endpoint.provider === "speko" && endpoint.status === "active" && <div className="space-y-6"><SpekoPhoneCallback companyId={endpoint.companyId} endpointId={endpoint.id} /><SpekoPhoneLine companyId={endpoint.companyId} endpointId={endpoint.id} /><SpekoIncomingCalls companyId={endpoint.companyId} endpointId={endpoint.id} agentId={endpoint.assignedAgentId} /></div>}
      {endpoint.provider === "slack" && <SlackTestMessageButton key={endpoint.id} endpointId={endpoint.id} />}
      {endpoint.provider === "github" && <div hidden={activeTab !== "settings" && activeTab !== "access"}>
        <GitHubBotManagement key={endpoint.id} endpoint={endpoint} view={activeTab === "access" ? "access" : "settings"} />
      </div>}
      {activeTab === "settings" && endpoint.provider !== "github" && <Settings endpointId={endpoint.id} endpoint={endpoint} />}
      {activeTab === "settings" && <EndpointExecutionDefaults endpoint={endpoint} />}
      {activeTab === "reviews" && endpoint.provider === "github" && <GitHubReviews endpointId={endpoint.id} reviewId={reviewId} />}
      {activeTab === "access" && endpoint.provider === "speko" && (
        <section className="max-w-3xl space-y-3">
          <h2 className="text-lg font-semibold">{t("private_voice_access_2578ee1")}</h2>
          <p className="text-sm text-muted-foreground">{t("browser_calls_use_the_signed_in_paperclip_6c72d74")}</p>
          <p className="text-sm text-muted-foreground">{t("outgoing_calls_use_your_saved_callback_number_2543512")}</p>
        </section>
      )}
{activeTab === "access" && endpoint.provider === "agentmail" && <EmailAccess endpoint={endpoint} />}
{activeTab === "access" && endpoint.provider !== "speko" && endpoint.provider !== "github" && endpoint.provider !== "agentmail" && (
        <Access
          endpointId={endpoint.id}
          allowUnlinked={endpoint.allowUnlinkedPeople}
          endpoint={endpoint}
        />
      )}
      {activeTab === "conversations" && (
        <Conversations endpointId={endpoint.id} provider={endpoint.provider} />
      )}
      {activeTab === "activity" && (
        <Activity endpointId={endpoint.id} endpoint={endpoint} />
      )}
      {endpoint.provider === "github" && activeTab === "settings" && endpoint.status === "active" &&
        endpoint.setup?.step === "complete" && completion?.endpointId === endpoint.id && (
        <GitHubConnectionComplete
          endpoint={endpoint}
          agent={avatarAgent.data}
          runtimeChecks={completion.runtimeChecks}
          onClose={() => {
            const { githubConnectionComplete: _complete, ...rest } = location.state as GitHubConnectionCompleteLocationState;
            navigate({ pathname: location.pathname, search: location.search, hash: location.hash }, { replace: true, state: rest });
          }}
          onCloseAutoFocus={() => heading.current?.focus()}
        />
      )}
    </div>
  );
}

function EndpointExecutionDefaults({ endpoint }: { endpoint: ChatEndpoint }) {
  const queryClient = useQueryClient();
  return <section className="max-w-3xl py-5"><ChatExecutionDefaults
    key={endpoint.id}
    companyId={endpoint.companyId}
    value={endpoint.executionDefaults}
    onSave={async (executionDefaults) => {
      const next = await chatEndpointsApi.update(endpoint.id, { executionDefaults });
      queryClient.setQueryData(queryKeys.chatEndpoints.detail(endpoint.id), next);
    }}
  /></section>;
}

function EmailAccess({ endpoint }: { endpoint: ChatEndpoint }) {
  const { t } = useTranslation("connections");
  const connection = useQuery({
    queryKey: queryKeys.tools.connection(endpoint.connectionId ?? ""),
    queryFn: () => toolsApi.getConnection(endpoint.connectionId!),
    enabled: Boolean(endpoint.connectionId),
  });
  const agents = useQuery({
    queryKey: queryKeys.agents.list(endpoint.companyId),
    queryFn: () => agentsApi.list(endpoint.companyId),
  });
  const agentsView = useQueryView(agents);
  const connectionView = useQueryView(connection);
  if (!endpoint.connectionId) return <p role="alert" className="text-sm text-destructive">{t("connection_access_could_not_be_loaded_4ee1d89")}</p>;
  if (agentsView.kind === "error" || connectionView.kind === "error") return (
    <QueryErrorState
      error={agentsView.kind === "error" ? agents.error : connection.error}
      action="load connection access"
      onRetry={() => { agentsView.retry(); connectionView.retry(); }}
      retrying={agents.isFetching || connection.isFetching}
    />
  );
  if (agents.isPending || connection.isPending || agentsView.kind === "reconnecting" || connectionView.kind === "reconnecting") {
    return <p role="status" className="text-sm text-muted-foreground">{t("loading_access_d4fbca4")}</p>;
  }
  const sourceId = connection.data?.config?.credentialConnectionId;
  const credentialId = typeof sourceId === "string" ? sourceId : endpoint.connectionId;
  return <section className="max-w-3xl space-y-4">
    <h2 className="text-lg font-semibold">{t("access_2f81a22")}</h2>
    {credentialId !== endpoint.connectionId && <p className="text-sm text-muted-foreground">{t("these_settings_apply_to_the_saved_agentmail_70e69fb")}</p>}
    <EmailConnectionAccess key={credentialId} companyId={endpoint.companyId} connectionId={credentialId} agents={agents.data ?? []} />
  </section>;
}

function Settings({
  endpointId,
  endpoint,
}: {
  endpointId: string;
  endpoint: Awaited<ReturnType<typeof chatEndpointsApi.get>>;
}) {
  const { t } = useTranslation("connections");
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const resourcesQuery = useQuery({
    queryKey: queryKeys.chatEndpoints.resources(endpointId),
    queryFn: () => chatEndpointsApi.listResources(endpointId),
    enabled: endpoint.provider !== "speko",
    ...(endpoint.provider === "slack" ? liveChatQueryOptions : {}),
  });
  const resourcesView = useQueryView(resourcesQuery);
  const saveResources = useMutation({
    mutationFn: (resource: Pick<ChatEndpointResource, "id" | "enabled">) =>
      chatEndpointsApi.updateResources(endpointId, [resource]),
    onSuccess: (resources) =>
      queryClient.setQueryData(
        queryKeys.chatEndpoints.resources(endpointId),
        resources,
      ),
    onError: (error) =>
      pushToast({
        title: t("couldn_t_update_destination_ee50dfc"),
        body: describeError(error).body,
        tone: "error",
      }),
  });
  const updateEndpoint = useMutation({
    mutationFn: chatEndpointsApi.update.bind(null, endpointId),
    onSuccess: (next) =>
      queryClient.setQueryData(
        queryKeys.chatEndpoints.detail(endpointId),
        next,
      ),
    onError: (error) =>
      pushToast({
        title: t("couldn_t_update_settings_927d062"),
        body: describeError(error).body,
        tone: "error",
      }),
  });
  if (endpoint.provider === "speko") return null;
  const resources = resourcesQuery.data ?? [];
  const destinationResources = resources.filter((resource) =>
    isIndividuallyToggleableResource(endpoint.provider, resource.type),
  );
  const toggleResource = (resource: ChatEndpointResource, enabled: boolean) =>
    // A cached inventory must not overwrite another operator's unrelated edits.
    saveResources.mutate({ id: resource.id, enabled });
  return (
    <section className="max-w-3xl space-y-7">
      {endpoint.provider === "imessage-photon" && <p className="text-sm text-muted-foreground">{endpoint.photonAllocation === "shared" ? t("shared_photon_project_direct_messages_only_enroll_5384c9a") : t("enable_each_group_individually_agent_replies_are_3348cab")}</p>}
      {endpoint.provider === "telegram" && (
        <div className="space-y-2">
          <h2 className="text-lg font-semibold">{t("telegram_group_command_a9b54c0")}</h2>
          <div className="rounded-lg border border-border p-3 text-sm">
            <code>
              /task@
              {endpoint.botUsername?.replace(/^@/, "") ?? "bot_username"}{" "}
              &lt;request&gt;
            </code>
            <p className="mt-2 text-muted-foreground">{t("telegram_s_default_privacy_mode_does_not_52e1c95")}</p>
          </div>
        </div>
      )}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold">{endpoint.provider === "slack" ? t("allowed_channels_7f21808") : t("destinations_0fc66bc")}</h3>
        {resourcesView.kind === "error" ? <QueryErrorState size="inline" error={resourcesQuery.error} action={endpoint.provider === "slack" ? "load the channels" : "load the destinations"} onRetry={resourcesView.retry} retrying={resourcesView.isFetching} /> : resourcesQuery.isLoading || resourcesView.kind === "reconnecting" ? (
          <p className="text-sm text-muted-foreground">{t("loading_destinations_7bce181")}</p>
        ) : destinationResources.length === 0 && endpoint.provider !== "slack" ? (
          <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">{t("no_destinations_yet_77ac647")}</p>
        ) : (
          <div className={endpoint.provider === "slack" ? "space-y-1" : "divide-y divide-border border-y border-border"}>
            {destinationResources.map((resource) => (
              <div key={resource.id} className="py-3 space-y-3">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {resource.label}
                  </p>
                  {(resource.availability !== "available" || resource.detail) && <p className="text-xs text-muted-foreground">
                    {resource.availability === "available"
                      ? resource.detail
                      : t("unavailable_at_the_provider_daab2c2")}
                  </p>}
                  {resource.participants?.length ? <p className="mt-1 break-words text-xs text-muted-foreground">{t("participants_317d984")}{resource.participants.join(", ")}</p> : null}
                </div>
                <ToggleSwitch
                  aria-label={t("enable_51bca66", { label: resource.label })}
                  checked={resource.enabled}
                  disabled={
                    endpoint.photonAllocation === "shared" ||
                    resource.availability !== "available" ||
                    saveResources.isPending
                  }
                  onCheckedChange={(enabled) =>
                    toggleResource(resource, enabled)
                  }
                />
              </div>
              <details className="text-sm">
                <summary className="cursor-pointer text-muted-foreground">{t("task_defaults_e0ead87")}</summary>
                <div className="pt-3"><ChatExecutionDefaults
                  companyId={endpoint.companyId}
                  value={resource.executionDefaults}
                  resource
                  onSave={async (executionDefaults) => {
                    const next = await chatEndpointsApi.updateResources(endpointId, [{ id: resource.id, executionDefaults }]);
                    queryClient.setQueryData(queryKeys.chatEndpoints.resources(endpointId), next);
                  }}
                /></div>
              </details>
              </div>
            ))}
            {endpoint.provider === "slack" && (
              <p className="py-3 text-sm text-muted-foreground">{t("invite_to_a_channel_to_add_it_dab50cc", { assignedAgentName: endpoint.assignedAgentName })}</p>
            )}
          </div>
        )}
      </div>
      {endpoint.provider !== "github" && (
        <div className="space-y-3">
          <SettingToggle
            label={t("allow_direct_messages_1983c49")}
            detail={
              endpoint.provider === "discord"
                ? t("people_must_also_enable_direct_messages_in_794d1a0")
                : undefined
            }
            checked={endpoint.allowDirectMessages ?? false}
            pending={updateEndpoint.isPending}
            onChange={(allowDirectMessages) =>
              updateEndpoint.mutate({ allowDirectMessages })
            }
          />
          {endpoint.provider === "slack" && (
            <SettingToggle
              label={t("require_at_mention_3dad70f")}
              detail={t("in_channels_only_respond_to_messages_that_eed43b6")}
              checked={endpoint.requireAtMention ?? false}
              pending={updateEndpoint.isPending}
              onChange={(requireAtMention) =>
                updateEndpoint.mutate({ requireAtMention })
              }
            />
          )}
          {endpoint.provider === "microsoft-teams" && (
            <SettingToggle
              label={t("allow_group_chats_b69332c")}
              detail={t("the_bot_may_participate_in_group_chats_07fca31")}
              checked={endpoint.allowGroupChats ?? false}
              pending={updateEndpoint.isPending}
              onChange={(allowGroupChats) =>
                updateEndpoint.mutate({ allowGroupChats })
              }
            />
          )}
        </div>
      )}
      {endpoint.provider === "slack" && <ChatCommunicationInstructions
        key={endpoint.id}
        value={endpoint.communicationInstructions ?? ""}
        onSave={async (communicationInstructions) => {
          const next = await chatEndpointsApi.update(endpointId, { communicationInstructions });
          queryClient.setQueryData(queryKeys.chatEndpoints.detail(endpointId), next);
        }}
      />}
      {endpoint.provider === "slack" && <SlackSetupAdvanced label={t("slack_tools_967a346")}><SlackToolsSettings companyId={endpoint.companyId} endpointId={endpointId} /></SlackSetupAdvanced>}
    </section>
  );
}

function SettingToggle({
  label,
  detail,
  checked,
  pending,
  onChange,
}: {
  label: string;
  detail?: string;
  checked: boolean;
  pending: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-3 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{label}</p>
        {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
      </div>
      <ToggleSwitch
        aria-label={label}
        checked={checked}
        disabled={pending}
        onCheckedChange={onChange}
      />
    </div>
  );
}

function Access({
  endpointId,
  allowUnlinked,
  endpoint,
}: {
  endpointId: string;
  allowUnlinked: boolean;
  endpoint: ChatEndpoint;
}) {
  const { t } = useTranslation("connections");
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [confirmationUrl, setConfirmationUrl] = useState<string | null>(null);
  const [joinCommandCopied, setJoinCommandCopied] = useState(false);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [confirmationFor, setConfirmationFor] = useState<string | null>(null);
  const joinCommand = `${endpoint.setup?.slackApp?.command ?? endpoint.setup?.command ?? "/paperclip"} connect`;
  const linksQuery = useQuery({
    queryKey: queryKeys.chatEndpoints.principals(endpointId),
    queryFn: () => chatEndpointsApi.listPrincipals(endpointId),
    refetchInterval: 5000,
  });
  const linksView = useQueryView(linksQuery);
  const updatePolicy = useMutation({
    mutationFn: (value: boolean) =>
      chatEndpointsApi.update(endpointId, { allowUnlinkedPeople: value }),
    onSuccess: (next) =>
      queryClient.setQueryData(
        queryKeys.chatEndpoints.detail(endpointId),
        next,
      ),
    onError: (error) => pushToast({ title: t("couldn_t_update_access_954807d"), body: describeError(error).body, tone: "error" }),
  });
  const createIntent = useMutation({
    mutationFn: (principalId: string) =>
      chatEndpointsApi.createLinkIntent(endpointId, principalId),
    onSuccess: ({ confirmationUrl }) => {
      setConfirmationUrl(
        new URL(confirmationUrl, window.location.origin).toString(),
      );

    },
    onError: (error) =>
      pushToast({
        title: t("couldn_t_create_identity_link_b14ba55"),
        body: describeError(error).body,
        tone: "error",
      }),
  });
  const revoke = useMutation({
    mutationFn: (principalId: string) =>
      chatEndpointsApi.revokeLink(endpointId, principalId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.chatEndpoints.principals(endpointId) }),
    onError: (error) => pushToast({ title: t("couldn_t_disconnect_account_9408b0b"), body: describeError(error).body, tone: "error" }),
  });
  const links = linksQuery.data ?? [];
  return (
    <section className="max-w-3xl space-y-7">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{t("people_b37554f")}</h2>
        {endpoint.provider === "slack" && <Dialog>
          <DialogTrigger asChild><Button>{t("invite_people_e1eb97a")}</Button></DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("invite_people_to_talk_to_c711ee5", { assignedAgentName: endpoint.assignedAgentName })}</DialogTitle>
              <DialogDescription>{t("share_these_instructions_with_someone_in_your_a86081d")}</DialogDescription>
            </DialogHeader>
            <div className="space-y-4 text-sm">
              <ol className="list-decimal space-y-3 pl-5">
                <li>{t("send_4cb5d72")}<code className="font-mono">{joinCommand}</code>{t("in_slack_05d0087")}</li>
                <li>{t("open_the_bot_s_private_link_and_8338cb1")}</li>
                <li>{t("if_you_re_new_to_this_organization_3e1524c")}</li>
              </ol>
              <p className="text-muted-foreground">{t("the_confirmation_link_is_personal_and_expires_cda98dd")}</p>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <Button variant="ghost" onClick={() => {
                  void copyTextToClipboard(joinCommand).then(() => setJoinCommandCopied(true), () => pushToast({ title: finalPagesT("final-pages:Couldn_t_copy_the_command_f3a00b"), tone: "error" }));
                }}>{joinCommandCopied ? <Check className="size-4" /> : <Copy className="size-4" />}{joinCommandCopied ? t("copied_8e3df45") : t("copy_command_a8e1047")}</Button>
                <Button onClick={() => {
                  const workspace = endpoint.providerAccountId ? `https://app.slack.com/client/${encodeURIComponent(endpoint.providerAccountId)}` : "https://app.slack.com/";
                  void copyTextToClipboard(`Talk to ${endpoint.assignedAgentName} in Slack: ${workspace}\nSend ${joinCommand}, then open the bot’s private link and sign in to Paperclip to confirm your account. If you’re new to the organization, request access for an admin to approve.`).then(() => setInviteCopied(true), () => pushToast({ title: finalPagesT("final-pages:Couldn_t_copy_invitation_7994c1"), tone: "error" }));
                }}>{inviteCopied ? <Check className="size-4" /> : <Copy className="size-4" />}{inviteCopied ? t("invitation_copied_6c638e1") : t("copy_invitation_18960e3")}</Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>}
      </div>
      <p className="text-sm text-muted-foreground">{t("people_with_linked_accounts_use_their_own_315ded3")}<Link className="underline underline-offset-4" to="/company/settings/members">{t("manage_members_0331250")}</Link></p>
      {confirmationUrl && (
        <div className="space-y-2 border-y border-border py-3">
          <p className="text-sm font-medium">{t("confirm_4450e52", { accountName: confirmationFor ?? t("reviewBThisAccount") })}</p>
          <p className="text-xs text-muted-foreground">{t("share_only_with_this_person_they_must_8ac0af2")}</p>
          <p className="break-all text-xs text-muted-foreground">
            {confirmationUrl}
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void copyTextToClipboard(confirmationUrl).then(
                () =>
                  pushToast({
                    title: finalPagesT("final-pages:Confirmation_link_copied_715f61"),
                    tone: "success",
                  }),
                () =>
                  pushToast({
                    title: finalPagesT("final-pages:Couldn_t_copy_the_link_6bad7b"),
                    body: finalPagesT("final-pages:Select_and_copy_it_manually_0edc1f"),
                    tone: "error",
                  }),
              );
            }}
          >
            <Copy />{t("copy_link_d7b4be6")}</Button>
        </div>
      )}
      <div className="space-y-2">
        {linksQuery.isPending || linksView.kind === "reconnecting" ? <p role="status" className="text-sm text-muted-foreground">{t("loading_people_c326737")}</p> : linksView.kind === "error" ? <QueryErrorState size="inline" error={linksQuery.error} action="load people" onRetry={linksView.retry} retrying={linksView.isFetching} /> : links.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">{t("no_linked_accounts_yet_invite_someone_to_42d0fc9")}</p>
        ) : (
          <div role="list" aria-label={t("people_b37554f")} className="divide-y divide-border border-y border-border">
            {links.map((link) => (
              <div
                key={link.id}
                role="listitem"
                className="flex flex-wrap items-center gap-3 py-3"
              >
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <Avatar aria-hidden="true">
                    {link.paperclipUserImage && <AvatarImage src={link.paperclipUserImage} alt="" />}
                    <AvatarFallback>{deriveInitials(link.paperclipUserLabel ?? link.externalLabel)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <p className="truncate text-sm" title={link.paperclipUserLabel ?? link.externalLabel}>{link.paperclipUserLabel ?? link.externalLabel}</p>
                    {(link.status !== "linked" || link.externalLabel !== link.paperclipUserLabel) && <p className="text-xs text-muted-foreground">
                      {link.status === "revoked" ? t("disconnected_771e05f") : link.status === "linked"
                        ? link.externalLabel
                        : t("waiting_for_account_confirmation_bcc7554")}
                    </p>}
                  </div>
                </div>
                {link.status === "linked" ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={revoke.isPending}
                    onClick={() => revoke.mutate(link.principalId)}
                  >
                    <Unlink />{t("disconnect_6e445f9")}</Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={createIntent.isPending}
                    onClick={() => { setConfirmationUrl(null); setConfirmationFor(link.externalLabel); createIntent.mutate(link.principalId); }}
                  >{t("create_confirmation_link_6f7a325")}</Button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      <SlackSetupAdvanced label={t("guest_access_233f29c")}>
        <SettingToggle label={t("allow_unlinked_people_8a1a071")}
          detail={t("people_without_linked_accounts_can_start_isolated_704c41a")}
          checked={allowUnlinked} pending={updatePolicy.isPending} onChange={value => updatePolicy.mutate(value)} />
      </SlackSetupAdvanced>
      {endpoint.provider === "slack" && <SlackSetupAdvanced label={t("personal_slack_search_1f135a1")}><SlackSearchAccess companyId={endpoint.companyId} endpointId={endpointId} /></SlackSetupAdvanced>}
    </section>
  );
}

function Conversations({
  endpointId,
  provider,
}: {
  endpointId: string;
  provider: ChatProvider;
}) {
  const { t } = useTranslation("connections");
  const query = useQuery({
    queryKey: queryKeys.chatEndpoints.conversations(endpointId),
    queryFn: () => chatEndpointsApi.listConversations(endpointId),
    ...liveChatQueryOptions,
  });
  const view = useQueryView(query);
  return (
    <section className="space-y-4">
      {query.isPending || view.kind === "reconnecting" ? <p role="status" className="text-sm text-muted-foreground">{t("loading_conversations_8f66c88")}</p> : view.kind === "error" ? (
        <QueryErrorState error={query.error} action="load the conversations" onRetry={view.retry} retrying={view.isFetching} />
      ) : <ChatConversationList rows={query.data ?? []} provider={provider} />}
    </section>
  );
}

function Activity({
  endpointId,
  endpoint,
}: {
  endpointId: string;
  endpoint: Awaited<ReturnType<typeof chatEndpointsApi.get>>;
}) {
  const { t } = useTranslation("connections");
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pushToast } = useToast();
  const [removeOpen, setRemoveOpen] = useState(false);
  const [resolutionItem, setResolutionItem] = useState<ChatActivityItem | null>(
    null,
  );
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const cursor = cursors[cursors.length - 1];
  useEffect(() => setCursors([undefined]), [endpointId]);
  const query = useQuery({
    queryKey: [...queryKeys.chatEndpoints.activity(endpointId), cursor ?? null],
    queryFn: () => chatEndpointsApi.listActivityPage(endpointId, cursor),
    ...liveChatQueryOptions,
    refetchInterval: cursor ? false : liveChatQueryOptions.refetchInterval,
  });
  const view = useQueryView(query);
  const activityLoaded = view.kind === "ready" || view.kind === "stale";
  const calls = useSpekoCallHistory(endpoint.companyId, endpointId, endpoint.provider === "speko" && !cursor);
  const replay = useMutation({
    mutationFn: (item: ChatActivityItem) =>
      item.kind === "publication"
        ? chatEndpointsApi.replayPublication(endpointId, item.id)
        : chatEndpointsApi.replayDelivery(endpointId, item.id),
    onSuccess: async (_result, item) => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.chatEndpoints.activity(endpointId),
      });
      pushToast({
        title: t("queued_for_replay_67555de", { value: item.kind === "publication" ? t("publication_e00441c") : t("delivery_9631af5") }),
        tone: "success",
      });
    },
    onError: (error) =>
      pushToast({
        title: t("couldn_t_replay_activity_9055fb4"),
        body: describeError(error).body,
        tone: "error",
      }),
  });
  const resolveActivity = useMutation({
    mutationFn: (input: {
      item: ChatActivityItem;
      action: "mark_delivered" | "retry_anyway" | "cancel";
    }) => {
      if (input.item.kind === "publication") {
        return chatEndpointsApi.resolvePublication(
          endpointId,
          input.item.id,
          input.action,
          input.item.fileTransfer
            ? {
                phase: input.item.fileTransfer.phase,
                version: input.item.fileTransfer.version,
              }
            : undefined,
        );
      }
      return chatEndpointsApi.resolveAction(
        endpointId,
        input.item.id,
        input.action,
      );
    },
    onSuccess: async (_result, input) => {
      setResolutionItem(null);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.chatEndpoints.activity(endpointId),
      });
      pushToast({
        title:
          input.item.actionType === "slash_task_start" &&
          input.action === "retry_anyway"
            ? t("task_start_retried_3252683")
            : input.item.actionType === "slash_task_start"
              ? t("task_start_cancelled_19e19a1")
              : input.item.actionType === "provider_effect" &&
                  input.action === "mark_delivered"
                ? t("provider_reply_marked_delivered_7945bdd")
                : input.item.actionType === "provider_effect" &&
                    input.action === "retry_anyway"
                  ? t("provider_reply_retried_3bb4b6f")
                  : input.item.actionType === "provider_effect"
                    ? t("provider_reply_cancelled_0e7562a")
                    : input.action === "mark_delivered"
                      ? t("publication_marked_delivered_bbe74f5")
                      : input.action === "retry_anyway"
                        ? t("publication_queued_for_retry_1e4a382")
                        : t("publication_cancelled_d22f197"),
        tone: "success",
      });
    },
    onError: (error) =>
      pushToast({
        title: t("couldn_t_resolve_activity_3c5a0bf"),
        body: describeError(error).body,
        tone: "error",
      }),
  });
  const lifecycle = useMutation({
    mutationFn: async (action: "pause" | "resume" | "remove") =>
      endpoint.provider === "agentmail"
        ? emailApi.control(endpointId, action)
        : chatEndpointsApi.setup(endpointId, { action }),
    onSuccess: async (next, action) => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.chatEndpoints.list(next.companyId),
      });
      if (endpoint.provider === "agentmail") {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["email-inboxes", next.companyId] }),
          queryClient.invalidateQueries({ queryKey: queryKeys.chatEndpoints.detail(endpointId) }),
        ]);
      }
      if (action === "remove") {
        navigate("/apps");
        return;
      }
      if (endpoint.provider !== "agentmail") queryClient.setQueryData(queryKeys.chatEndpoints.detail(endpointId), next);
      pushToast({
        title: action === "pause" ? t("connection_paused_298c65d") : t("connection_resumed_4ed4a68"),
        tone: "success",
      });
    },
    onError: (error) =>
      pushToast({
        title: t("couldn_t_update_connection_614509f"),
        body: describeError(error).body,
        tone: "error",
      }),
  });
  const rows = query.data?.items ?? [];
  // Calls use their own caller-authorized API and appear once in recent activity.
  // Older connection-event pages retain the existing cursor contract.
  const activityEntries = [
    ...(view.kind !== "error" ? rows.map(item => ({ kind: "connection" as const, id: `connection:${item.id}`, createdAt: item.createdAt, item })) : []),
    ...(!cursor && !calls.error ? calls.entries.map(entry => ({ kind: "call" as const, id: `call:${entry.session.id}`, createdAt: entry.session.createdAt, entry })) : []),
    ...(!cursor && !calls.incomingError ? calls.unapprovedCalls.map(call => ({ kind: "unapproved_call" as const, id: `unapproved:${call.id}`, createdAt: call.createdAt, call })) : []),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));

  const { status } = endpoint;
  const health = connectionHealthPresentation(endpoint);
  const lifecycleAction = lifecycle.variables;
  const callbackSurfaceRows = endpoint.setup?.callbackSurfaces
    ? ([
        [t("events_api_fe34411"), endpoint.setup.callbackSurfaces.events],
        [t("interactivity"), endpoint.setup.callbackSurfaces.interactivity],
        [t("slash_command_f26624e"), endpoint.setup.callbackSurfaces.slashCommands],
      ] as const)
    : [];
  return (
    <section className="space-y-5" aria-label={t("connection_activity_c4ff9de")}>
      <h2 className="text-lg font-semibold">{t("connection_activity_c4ff9de")}</h2>
      {((status !== "active" && health.message) || health.error) && (
        <div
          className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${status === "attention" || status === "revoked" ? "border-destructive/40 bg-destructive/5 text-destructive" : "border-border bg-muted/30 text-foreground"}`}
        >
          {(status === "attention" || status === "revoked") && (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          )}
          <div>
            {health.message && <p>{health.message}</p>}
            {health.previousHealth && (
              <p className="mt-1 text-xs opacity-80">
                <span className="font-medium">{t("last_reported_health_553495e")}</span>{" "}
                {health.previousHealth}
              </p>
            )}
            {health.error && (
              <p className="mt-1 text-xs opacity-80">
                <span className="font-medium">{health.errorLabel}:</span>{" "}
                {health.error}
              </p>
            )}
          </div>
        </div>
      )}
      <details className="group rounded-lg border border-border">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4 text-sm font-medium chat-connection-health-summary">
          <span>{t("connection_health_and_controls_58ec35d")}</span>
          <span className="flex items-center gap-2">
            {endpoint.setup?.callbacksNeedUpdate && <span className="text-xs text-(--status-task-blocked)">{t("callback_urls_need_attention_2ba0511")}</span>}
            <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
          </span>
        </summary>
        <div className="space-y-5 border-t border-border p-4">
      {endpoint.provider === "slack" && callbackSurfaceRows.length > 0 && (
        <div
          className="space-y-3 text-sm"
        >
          <p className="font-medium">{t("slack_callback_health_708848b")}</p>
          <p className="text-xs text-muted-foreground">
            {endpoint.setup?.callbacksNeedUpdate
              ? t("slack_callback_urls_need_an_update_save_e80367b")
              : t("paperclip_records_each_callback_surface_independently_after_f50e693")}
          </p>
          <div className="divide-y divide-border border-y border-border">
            {callbackSurfaceRows.map(([label, surface]) => (
              <div key={label} className="flex flex-wrap items-center justify-between gap-3 py-2">
                <p className="text-xs font-medium">{label}</p>
                <p className="text-xs text-muted-foreground">
                  {surface.status === "current"
                    ? t("current_4fc0e2b")
                    : surface.status === "stale"
                      ? t("stale_url_0906b36")
                      : t("not_observed_60ac631")}
                </p>
                {surface.observedAt && (
                  <p className="text-xs text-muted-foreground">{t("last_observed_18daee5")}{" "}
                    <time
                      dateTime={surface.observedAt}
                      title={surface.observedAt}
                      className="font-mono"
                    >
                      {formatDateTime(surface.observedAt, {
                        includeSeconds: true,
                      })}
                    </time>
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {status !== "archived" && (
        <div className="space-y-3 pt-2">
          <div className="flex flex-wrap items-center gap-2">
            {status === "active" && (
              <Button
                variant="outline"
                disabled={lifecycle.isPending}
                onClick={() => lifecycle.mutate("pause")}
              >
                {lifecycle.isPending && lifecycleAction === "pause" ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Pause />
                )}{t("pause_ddf176b")}</Button>
            )}
            {status === "paused" && (
              <Button
                variant="outline"
                disabled={lifecycle.isPending}
                onClick={() => lifecycle.mutate("resume")}
              >
                {lifecycle.isPending && lifecycleAction === "resume" ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Play />
                )}{t("resume_ab47891")}</Button>
            )}
            {[
              "active",
              "paused",
              "attention",
              "revoked",
              "draft",
              "verifying",
            ].includes(status) && (
              <Button
                variant="outline"
                disabled={lifecycle.isPending}
                onClick={() =>
                  navigate(
                    endpoint.provider === "agentmail" && status !== "draft" && status !== "verifying"
                      ? `/apps/chat/${endpoint.id}/settings`
                      : `/apps/chat/connect?provider=${endpoint.provider}&purpose=chat&resume=${endpoint.id}${status === "draft" || status === "verifying" ? "" : "&reconnect=1"}`,
                  )
                }
              >
                <RefreshCw />
                {status === "draft" || status === "verifying"
                  ? t("finish_setup_c516d2d")
                  : t("reconnect_6988b16")}
              </Button>
            )}
            <Button
              variant="ghost"
              className="text-destructive hover:text-destructive"
              disabled={lifecycle.isPending}
              onClick={() => setRemoveOpen(true)}
            >
              <Trash2 />{t("remove_connection_689eca5")}</Button>
          </div>
          {status !== "draft" && status !== "verifying" && (
            <p className="text-xs text-muted-foreground">
              {providerLifecycleGuidance[endpoint.provider].reconnect}
            </p>
          )}
        </div>
      )}
        </div>
      </details>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold">{t("recent_activity_72d5617")}</h3>
          {endpoint.provider === "speko" && !cursor && <Button size="sm" variant="ghost" onClick={() => { void query.refetch(); calls.onRetry(); }} disabled={query.isFetching || calls.loading}>{t("refresh_56e3bad")}</Button>}
        </div>
        {endpoint.provider === "agentmail" && rows.some((item) => item.kind === "publication" && item.status === "delivery_unknown") && (
          <p className="text-sm text-muted-foreground">{t("review_unconfirmed_email_delivery_in_the_eb2566d")}{" "}
            <Link to={`/apps/chat/${endpointId}/conversations`} className="underline underline-offset-4">{t("conversation_s_task_90b7174")}</Link>.
          </p>
        )}
        <div className="divide-y divide-border border-y border-border">
          {(query.isLoading || view.kind === "reconnecting" || calls.loading) && (
            <div className="flex items-center gap-2 py-5 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />{t("loading_activity_45c4003")}</div>
          )}
          {view.kind === "error" && (
            <div className="py-4">
              <QueryErrorState
                error={query.error}
                action="load the connection activity"
                onRetry={view.retry}
                retrying={view.isFetching}
              />
            </div>
          )}
          {endpoint.provider === "speko" && !cursor && [
            calls.error && t("call_activity_could_not_be_loaded_5db47b9", { error: calls.error }),
            calls.incomingError && t("unapproved_calls_could_not_be_loaded_6978fd4", { incomingError: calls.incomingError }),
            calls.endError && t("the_call_could_not_be_ended_1e3c809", { endError: calls.endError }),
          ].filter(Boolean).map((message) => <div key={String(message)} className="flex flex-wrap items-center justify-between gap-3 py-4"><p role="alert" className="text-sm text-destructive">{message}</p><Button size="sm" variant="outline" onClick={calls.onRetry}>{t("retry_calls_73e630d")}</Button></div>)}
          {activityEntries.map(entry => {
            if (entry.kind === "call") return <SpekoCallActivityItem key={entry.id} entry={entry.entry} presentation="activity" onEnd={calls.onEnd} ending={calls.endingSessionId === entry.entry.session.id} />;
            if (entry.kind === "unapproved_call") return <SpekoUnapprovedCallActivityItem key={entry.id} call={entry.call} presentation="activity" />;
            const item = entry.item;
            return (
              <div
                key={entry.id}
                data-activity-kind="connection"
                className="flex items-start gap-3 px-2 py-3 transition-colors hover:bg-accent/50"
              >
                <span className="mt-0.5 text-muted-foreground" aria-hidden="true">
                  {item.kind === "delivery" ? <ArrowDownLeft className="size-4" /> : item.kind === "publication" ? <ArrowUpRight className="size-4" /> : <ActivityIcon className="size-4" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <p className="min-w-0 flex-1 text-sm font-medium">{item.summary}</p>
                    <StatusBadge status={item.status} />
                    <time dateTime={item.createdAt} title={item.createdAt} className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {formatDateTime(item.createdAt, { includeSeconds: true })}
                    </time>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{activityKindLabels[item.kind]}</p>
                  {item.fileTransfer && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {item.fileTransfer.filename} —{" "}
                      {getPageValueLabel(item.fileTransfer.phase, true)}
                    </p>
                  )}
                  {item.detail && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">
                        {activityDetailLabel(item)}:
                      </span>{" "}
                      {item.detail}
                    </p>
                  )}
                </div>
                {endpoint.provider !== "agentmail" && isReplayEligible(item) && (
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={t("replay_failed_6c65a6a", { kind: item.kind })}
                    disabled={replay.isPending}
                    onClick={() => replay.mutate(item)}
                  >
                    {replay.isPending && replay.variables?.id === item.id ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <RefreshCw />
                    )}{t("replay_9ac4421")}</Button>
                )}
                {endpoint.provider !== "agentmail" && isResolutionEligible(item) && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setResolutionItem(item)}
                  >{t("resolve_987bcff")}</Button>
                )}
              </div>
            );
          })}
          {activityLoaded && !calls.loading && !calls.error && !calls.incomingError && activityEntries.length === 0 && (
            <p className="py-5 text-sm text-muted-foreground">{t("no_connection_activity_yet_d3c9a8f")}</p>
          )}
        </div>
      </div>
      <nav aria-label={t("activity_pagination_0a8fe59")} className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">{t("page_f058fa3", { length: cursors.length })}</span>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={cursors.length === 1 || query.isFetching} onClick={() => setCursors((pages) => pages.slice(0, -1))}>{t("previous_50f9428")}</Button>
          <Button size="sm" variant="outline" disabled={!query.data?.nextCursor || query.isFetching || view.kind === "error"} onClick={() => { if (query.data?.nextCursor) setCursors((pages) => [...pages, query.data.nextCursor!]); }}>{t("next_bc98198")}</Button>
        </div>
      </nav>
      <AlertDialog
        open={resolutionItem !== null}
        onOpenChange={(open) => !open && setResolutionItem(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {resolutionItem?.actionType === "slash_task_start"
                ? t("resolve_unconfirmed_task_start_9fdd58c")
                : resolutionItem?.actionType === "provider_effect"
                  ? t("resolve_unconfirmed_provider_reply_9dbf72d")
                  : t("resolve_unconfirmed_delivery_0bc0515")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {resolutionItem?.actionType === "slash_task_start"
                ? t("paperclip_lost_confirmation_after_asking_slack_to_e01b820")
                : resolutionItem?.actionType === "provider_effect"
                  ? t("paperclip_lost_confirmation_after_sending_this_provider_a4c25cc")
                  : resolutionItem
                    ? activityResolutionDescription(resolutionItem)
                    : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="sm:flex-wrap">
            <AlertDialogCancel disabled={resolveActivity.isPending}>{t("keep_unresolved_78fbcaa")}</AlertDialogCancel>
            {resolutionItem &&
              activityResolutionActions(resolutionItem).includes("cancel") && (
                <Button
                  variant="outline"
                  disabled={resolveActivity.isPending}
                  onClick={() =>
                    resolutionItem &&
                    resolveActivity.mutate({
                      item: resolutionItem,
                      action: "cancel",
                    })
                  }
                >
                  {resolutionItem.actionType === "slash_task_start"
                    ? t("cancel_task_start_35f3d4a")
                    : resolutionItem.actionType === "provider_effect"
                      ? t("cancel_provider_reply_589bd05")
                      : resolutionItem.fileTransfer
                        ? t("cancel_file_transfer_cd2e2c6")
                        : t("cancel_publication_b31c5e0")}
                </Button>
              )}
            {resolutionItem &&
              activityResolutionActions(resolutionItem).includes(
                "retry_anyway",
              ) && (
                <Button
                  variant="outline"
                  disabled={resolveActivity.isPending}
                  onClick={() =>
                    resolutionItem &&
                    resolveActivity.mutate({
                      item: resolutionItem,
                      action: "retry_anyway",
                    })
                  }
                >
                  {resolutionItem.fileTransfer
                    ? t("retry_file_notification_c84cb3a")
                    : t("retry_anyway_e930d76")}
                </Button>
              )}
            {resolutionItem &&
              activityResolutionActions(resolutionItem).includes(
                "mark_delivered",
              ) && (
                <AlertDialogAction
                  disabled={resolveActivity.isPending}
                  onClick={(event) => {
                    event.preventDefault();
                    if (resolutionItem) {
                      resolveActivity.mutate({
                        item: resolutionItem,
                        action: "mark_delivered",
                      });
                    }
                  }}
                >{t("mark_delivered_73e0abb")}</AlertDialogAction>
              )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("remove_this_connection_21e7c57")}</AlertDialogTitle>
            <AlertDialogDescription>
              {endpoint.assignedAgentName}{t("will_stop_receiving_new_work_from_bf7e55b")}{` ${providerNames[endpoint.provider]}`}{t("existing_paperclip_tasks_remain_available_cb6e706")}{" "}
              {providerLifecycleGuidance[endpoint.provider].remove}
              {endpoint.provider === "slack" && (
                <> <a
                  href={endpoint.setup?.slackRegistration?.managementUrl ?? "https://api.slack.com/apps"}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-4"
                >{t("open_slack_app_settings_1cc06a4")}</a>{t("to_manage_or_delete_the_slack_app_6064bee")}</>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel_77dfd21")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={lifecycle.isPending}
              onClick={() => lifecycle.mutate("remove")}
            >
              {lifecycle.isPending && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}{t("remove_connection_689eca5")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
