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
import { t, useTranslation } from "@/i18n";

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
    reconnect: "Reverify this voice persona and update its signed session tools. Existing task assignments stay attached to their history.",
    remove: "Stop this connection from accepting voice requests. Accepted work and task history remain in Paperclip.",
  },
  agentmail: { reconnect: "Reconnect the same email inbox.", remove: "Disconnect email and retain task history." },
  slack: {
    reconnect:
      "Reconnect verifies or replaces credentials for this same Slack app. It does not reinstall the app or change its workspace or channel membership.",
    remove:
      "Paperclip archives the endpoint, stops new ingress, and retires its saved Slack credentials. It does not uninstall the Slack app: the app remains installed, and its bot remains in channels, until you remove them in Slack.",
  },
  github: {
    reconnect:
      "Reconnect verifies this same App and installation, then updates its webhook URL, secret, and secure delivery settings. It does not reinstall the App or change repository access.",
    remove:
      "Paperclip archives the endpoint, stops new ingress, and retires its saved App key and webhook secret. It does not uninstall the GitHub App: the App, its installations, and its webhook settings remain until you remove or update them on GitHub.",
  },
  discord: {
    reconnect:
      "Reconnect verifies this same Discord application and server installation. It does not add or remove the bot from the server.",
    remove:
      "Paperclip archives the endpoint, stops its Paperclip Gateway connection, and retires its saved bot token. It does not uninstall the bot: the bot remains in the Discord server, and the application remains in the Developer Portal, until you remove them there.",
  },
  "microsoft-teams": {
    reconnect:
      "Reconnect verifies this same Microsoft app, tenant, and bot identity. It does not upload or reinstall the Teams app.",
    remove:
      "Paperclip archives the endpoint, stops new ingress, and retires its saved client secret. It does not uninstall the Teams app: the Entra app registration, Azure Bot, custom Teams app, and Teams installations remain until you remove them in Microsoft.",
  },
  "imessage-photon": {
    reconnect: "Reconnect verifies the same Photon project and line allocation, then recovers eligible missed messages.",
    remove: "Disconnect archives this channel and removes its saved secret. Your Photon project, number, subscription, and Messages history remain in Photon.",
  },
  telegram: {
    reconnect:
      "Reconnect verifies this same BotFather bot and automatically refreshes its Paperclip webhook and command menu.",
    remove:
      "Paperclip archives the endpoint and queues durable removal of its Telegram webhook and command menu. After Telegram confirms that cleanup, Paperclip retires the saved token. The BotFather bot and its chat memberships remain until you remove them in Telegram.",
  },
};

const activityKindLabels: Record<ChatActivityItem["kind"], string> = {
  delivery: "Inbound delivery",
  publication: "Outbound publication",
  action: "Provider action",
  health: "Connection health",
  repair: "Connection repair",
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
    return t("apps.ChatEndpointDetail.resolutionFileInfoUnknown");
  if (phase === "consent_unknown")
    return t("apps.ChatEndpointDetail.resolutionConsentUnknown");
  if (phase)
    return t("apps.ChatEndpointDetail.resolutionFileUnknown");
  return t("apps.ChatEndpointDetail.resolutionUnknown");
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
  return replayableFailureStates.has(item.status) ? t("apps.ChatEndpointDetail.reason") : t("apps.ChatEndpointDetail.details");
}

export function connectionHealthPresentation(
  endpoint: Pick<ChatEndpoint, "status" | "healthMessage" | "lastError">,
) {
  // Health events outlive pause/removal. They are history, not lifecycle state.
  const lifecycleMessages = {
    draft: t("apps.ChatEndpointDetail.lifecycleDraft"),
    verifying: t("apps.ChatEndpointDetail.lifecycleVerifying"),
    paused: t("apps.ChatEndpointDetail.lifecyclePaused"),
    attention: t("apps.ChatEndpointDetail.lifecycleAttention"),
    revoked: t("apps.ChatEndpointDetail.lifecycleRevoked"),
    archived: t("apps.ChatEndpointDetail.lifecycleArchived"),
  };
  const lifecycleMessage =
    endpoint.status === "active" ? null : lifecycleMessages[endpoint.status];
  return {
    message: lifecycleMessage ?? endpoint.healthMessage ?? null,
    previousHealth: lifecycleMessage ? (endpoint.healthMessage ?? null) : null,
    error: endpoint.lastError ?? null,
    errorLabel: ["active", "attention", "revoked"].includes(endpoint.status)
      ? t("apps.ChatEndpointDetail.reason")
      : t("apps.ChatEndpointDetail.lastReportedError"),
  };
}

export function ChatEndpointDetail() {
  const { t } = useTranslation();
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
      { label: t("apps.ChatEndpointDetail.connectors"), href: "/apps" },
      {
        label: `${endpoint.assignedAgentName} · ${providerNames[endpoint.provider]}`,
        href: `/apps/chat/${endpoint.id}/settings`,
      },
      ...(reviewId ? [{ label: t("apps.ChatEndpointDetail.reviews"), href: `/apps/chat/${endpoint.id}/reviews` }, { label: t("apps.ChatEndpointDetail.review") }] : [{
        label:
          tabItems.find((item) => item.value === activeTab)?.label ??
          "Settings",
      }]),
    ]);
    return () => setBreadcrumbs([]);
  }, [activeTab, endpoint, reviewId, setBreadcrumbs]);

  if (!activeTab)
    return <Navigate replace to={`/apps/chat/${endpointId}/settings`} />;
  if (endpointQuery.isLoading || endpointView.kind === "reconnecting")
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("apps.chatDetail.loadingConnection", "Loading connection…")}
      </div>
    );
  if (endpointView.kind === "error" || !endpoint)
    return (
      <QueryErrorState
        size="page"
        error={endpointQuery.error}
        action={t("apps.chatDetail.loadConnectionAction", "load the connection")}
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
            {endpoint.provider === "github" ? (endpoint.botLabel ?? endpoint.assignedAgentName) : endpoint.assignedAgentName}{endpoint.provider === "speko" ? t("apps.ChatEndpointDetail.inSpeko") : ""}
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            {endpoint.provider === "github" ? <><AppLogo name="GitHub" brandKey="github" compact className="size-4! rounded-sm bg-transparent" /><Link to={`/agents/${endpoint.assignedAgentId}`} className="hover:underline">{endpoint.assignedAgentName}</Link>{endpoint.providerAccountLabel && <span>· {endpoint.providerAccountLabel}</span>}</> : endpoint.providerAccountLabel ?? (endpoint.provider === "agentmail" ? endpoint.botExternalId ?? t("apps.ChatEndpointDetail.emailConnection") : t("apps.ChatEndpointDetail.chatConnection"))}
          </p>
          {endpoint.provider === "github" && <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            <GitHubBotMention endpoint={endpoint} />
            <GitHubAppIdentityActions endpoint={endpoint} avatarUrl={avatarAgent.data ? agentAvatarUrl(resolveAgentAppearance(avatarAgent.data.appearance, endpoint.assignedAgentId), 512, 1, "rest") : undefined} />
          </div>}
          {endpoint.provider === "imessage-photon" && endpoint.botExternalId && endpoint.photonAllocation !== "shared" && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
              <span>{endpoint.botExternalId}</span>
              <Button variant="ghost" size="sm" aria-label={t("apps.chatDetail.copyNumberAria", "Copy dedicated number")} onClick={async () => {
                try { await copyTextToClipboard(endpoint.botExternalId!); setCopyStatus(t("apps.ChatEndpointDetail.numberCopied")); }
                catch { setCopyStatus(t("apps.ChatEndpointDetail.numberCopyFailed")); }
              }}><Copy className="size-4" />{t("apps.chatDetail.copyNumber", "Copy number")}</Button>
              <span role="status" className="text-muted-foreground">{copyStatus}</span>
            </div>
          )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {endpoint.provider === "speko" && <a href="https://platform.speko.ai/agents" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-primary underline">{t("apps.chatDetail.openSpeko", "Open Speko")}<ExternalLink className="size-3.5" aria-hidden="true" /></a>}
          {endpoint.provider === "slack" && !setupIncomplete && <Button asChild variant="outline"><a href={slackConversationUrl(endpoint, identitySettled ? userId : null)} target="_blank" rel="noopener noreferrer">{t("apps.chatDetail.openSlack", "Open Slack")} <ExternalLink className="size-4" /></a></Button>}
          {slackUrl && <Button asChild variant="outline"><a href={slackUrl} target="_blank" rel="noopener noreferrer">{t("apps.chatDetail.openSlackConfig", "Open Slack configuration")} <ExternalLink className="size-4" /></a></Button>}
          {setupIncomplete ? (
            <Button
              variant="outline"
              onClick={() =>
                navigate(
                  `/apps/chat/connect?provider=${endpoint.provider}&purpose=chat&resume=${endpoint.id}`,
                )
              }
            >
              {t("apps.ChatEndpointDetail.continueSetup")}
            </Button>
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
          <h2 className="text-lg font-semibold">{t("apps.chatDetail.privateVoiceAccess", "Private voice access")}</h2>
          <p className="text-sm text-muted-foreground">{t("apps.chatDetail.browserCallsNotice", "Browser calls use the signed-in Paperclip user’s current company access. Each call stays bound to its selected agent and task.")}</p>
          <p className="text-sm text-muted-foreground">{t("apps.chatDetail.outgoingNotice", "Outgoing calls use your saved callback number and opt-in. For a private incoming call, enter the code spoken on the phone in signed-in Paperclip and select a task to approve that live call. Incoming calls can start a new conversation task without sign-in, under a task-scoped low-trust policy. Private mode is optional and requires approval before accessing existing tasks.")}</p>
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
  const { t } = useTranslation();
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
  if (!endpoint.connectionId) return <p role="alert" className="text-sm text-destructive">{t("apps.chatDetail.couldNotLoadConnection", "Couldn't load connection access")}</p>;
  if (agentsView.kind === "error" || connectionView.kind === "error") return (
    <QueryErrorState
      error={agentsView.kind === "error" ? agents.error : connection.error}
      action={t("errorActions.loadConnectionAccess")}
      onRetry={() => { agentsView.retry(); connectionView.retry(); }}
      retrying={agents.isFetching || connection.isFetching}
    />
  );
  if (agents.isPending || connection.isPending || agentsView.kind === "reconnecting" || connectionView.kind === "reconnecting") {
    return <p role="status" className="text-sm text-muted-foreground">{t("apps.chatDetail.loadingAccess", "Loading access…")}</p>;
  }
  const sourceId = connection.data?.config?.credentialConnectionId;
  const credentialId = typeof sourceId === "string" ? sourceId : endpoint.connectionId;
  return <section className="max-w-3xl space-y-4">
    <h2 className="text-lg font-semibold">{t("apps.chatDetail.accessTitle", "Access")}</h2>
    {credentialId !== endpoint.connectionId && <p className="text-sm text-muted-foreground">{t("apps.chatDetail.agentMailSettingsNotice", "These settings apply to the saved AgentMail account and all inboxes using it.")}</p>}
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
  const { t } = useTranslation();
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
        title: t("apps.ChatEndpointDetail.couldntUpdateDestination"),
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
        title: t("apps.ChatEndpointDetail.couldntUpdateSettings"),
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
      {endpoint.provider === "imessage-photon" && <p className="text-sm text-muted-foreground">{endpoint.photonAllocation === "shared" ? t("apps.ChatEndpointDetail.photonSharedNotice") : t("apps.ChatEndpointDetail.photonDedicatedNotice")}</p>}
      {endpoint.provider === "telegram" && (
        <div className="space-y-2">
          <h2 className="text-lg font-semibold">{t("apps.chatDetail.telegramGroupCommand", "Telegram group command")}</h2>
          <div className="rounded-lg border border-border p-3 text-sm">
            <code>
              /task@
              {endpoint.botUsername?.replace(/^@/, "") ?? "bot_username"}{" "}
              &lt;request&gt;
            </code>
            <p className="mt-2 text-muted-foreground">
              {t("apps.ChatEndpointDetail.telegramPrivacyNotice")}
            </p>
          </div>
        </div>
      )}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold">{endpoint.provider === "slack" ? t("apps.ChatEndpointDetail.allowedChannels") : t("apps.ChatEndpointDetail.destinations")}</h3>
        {resourcesView.kind === "error" ? <QueryErrorState size="inline" error={resourcesQuery.error} action={endpoint.provider === "slack" ? t("errorActions.loadTheChannels") : t("errorActions.loadTheDestinations")} onRetry={resourcesView.retry} retrying={resourcesView.isFetching} /> : resourcesQuery.isLoading || resourcesView.kind === "reconnecting" ? (
          <p className="text-sm text-muted-foreground">{t("apps.chatDetail.loadingDestinations", "Loading destinations…")}</p>
        ) : destinationResources.length === 0 && endpoint.provider !== "slack" ? (
          <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
            {t("apps.ChatEndpointDetail.noDestinations")}
          </p>
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
                      : t("apps.ChatEndpointDetail.unavailableAtProvider")}
                  </p>}
                  {resource.participants?.length ? <p className="mt-1 break-words text-xs text-muted-foreground">{t("apps.ChatEndpointDetail.participants", { names: resource.participants.join(", ") })}</p> : null}
                </div>
                <ToggleSwitch
                  aria-label={t("apps.ChatEndpointDetail.enableResource", { label: resource.label })}
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
                <summary className="cursor-pointer text-muted-foreground">{t("apps.chatDetail.taskDefaults", "Task defaults")}</summary>
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
              <p className="py-3 text-sm text-muted-foreground">
                {t("apps.ChatEndpointDetail.inviteToChannel", { agent: endpoint.assignedAgentName })}
              </p>
            )}
          </div>
        )}
      </div>
      {endpoint.provider !== "github" && (
        <div className="space-y-3">
          <SettingToggle
            label={t("apps.ChatEndpointDetail.allowDirectMessages")}
            detail={
              endpoint.provider === "discord"
                ? t("apps.ChatEndpointDetail.discordDmNotice")
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
              label={t("apps.ChatEndpointDetail.requireAtMention")}
              detail={t("apps.ChatEndpointDetail.requireAtMentionDetail")}
              checked={endpoint.requireAtMention ?? false}
              pending={updateEndpoint.isPending}
              onChange={(requireAtMention) =>
                updateEndpoint.mutate({ requireAtMention })
              }
            />
          )}
          {endpoint.provider === "microsoft-teams" && (
            <SettingToggle
              label={t("apps.ChatEndpointDetail.allowGroupChats")}
              detail={t("apps.ChatEndpointDetail.groupChatsDetail")}
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
      {endpoint.provider === "slack" && <SlackSetupAdvanced label={t("apps.ChatEndpointDetail.slackTools")}><SlackToolsSettings companyId={endpoint.companyId} endpointId={endpointId} /></SlackSetupAdvanced>}
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
  const { t } = useTranslation();
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
    onError: (error) => pushToast({ title: t("apps.ChatEndpointDetail.couldntUpdateAccess"), body: describeError(error).body, tone: "error" }),
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
        title: t("apps.ChatEndpointDetail.couldntCreateIdentityLink"),
        body: describeError(error).body,
        tone: "error",
      }),
  });
  const revoke = useMutation({
    mutationFn: (principalId: string) =>
      chatEndpointsApi.revokeLink(endpointId, principalId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.chatEndpoints.principals(endpointId) }),
    onError: (error) => pushToast({ title: t("apps.ChatEndpointDetail.couldntDisconnectAccount"), body: describeError(error).body, tone: "error" }),
  });
  const links = linksQuery.data ?? [];
  return (
    <section className="max-w-3xl space-y-7">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{t("apps.chatDetail.people", "People")}</h2>
        {endpoint.provider === "slack" && <Dialog>
          <DialogTrigger asChild><Button>{t("apps.ChatEndpointDetail.invitePeople")}</Button></DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("apps.ChatEndpointDetail.inviteDialogTitle", { agent: endpoint.assignedAgentName })}</DialogTitle>
              <DialogDescription>{t("apps.ChatEndpointDetail.inviteDialogDescription")}</DialogDescription>
            </DialogHeader>
            <div className="space-y-4 text-sm">
              <ol className="list-decimal space-y-3 pl-5">
                <li>{t("apps.ChatEndpointDetail.sendCommandPrefix")} <code className="font-mono">{joinCommand}</code> {t("apps.ChatEndpointDetail.sendCommandSuffix")}</li>
                <li>{t("apps.ChatEndpointDetail.inviteStepLink")}</li>
                <li>{t("apps.ChatEndpointDetail.inviteStepRequestAccess")}</li>
              </ol>
              <p className="text-muted-foreground">{t("apps.ChatEndpointDetail.confirmationLinkExpiry")}</p>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <Button variant="ghost" onClick={() => {
                  void copyTextToClipboard(joinCommand).then(() => setJoinCommandCopied(true), () => pushToast({ title: t("apps.ChatEndpointDetail.couldntCopyCommand"), tone: "error" }));
                }}>{joinCommandCopied ? <Check className="size-4" /> : <Copy className="size-4" />}{joinCommandCopied ? t("common.copied") : t("apps.ChatEndpointDetail.copyCommand")}</Button>
                <Button onClick={() => {
                  const workspace = endpoint.providerAccountId ? `https://app.slack.com/client/${encodeURIComponent(endpoint.providerAccountId)}` : "https://app.slack.com/";
                  void copyTextToClipboard(t("apps.ChatEndpointDetail.invitationText", { agent: endpoint.assignedAgentName, workspace, command: joinCommand })).then(() => setInviteCopied(true), () => pushToast({ title: t("apps.ChatEndpointDetail.couldntCopyInvitation"), tone: "error" }));
                }}>{inviteCopied ? <Check className="size-4" /> : <Copy className="size-4" />}{inviteCopied ? t("apps.ChatEndpointDetail.invitationCopied") : t("apps.ChatEndpointDetail.copyInvitation")}</Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>}
      </div>
      <p className="text-sm text-muted-foreground">{t("apps.ChatEndpointDetail.peopleLinkedPermissions")} <Link className="underline underline-offset-4" to="/company/settings/members">{t("apps.ChatEndpointDetail.manageMembers")}</Link></p>
      {confirmationUrl && (
        <div className="space-y-2 border-y border-border py-3">
          <p className="text-sm font-medium">{t("apps.ChatEndpointDetail.confirmAccount", { name: confirmationFor ?? t("apps.ChatEndpointDetail.thisAccount") })}</p>
          <p className="text-xs text-muted-foreground">{t("apps.ChatEndpointDetail.confirmShareWarning")}</p>
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
                    title: t("apps.ChatEndpointDetail.confirmationLinkCopied"),
                    tone: "success",
                  }),
                () =>
                  pushToast({
                    title: t("apps.ChatEndpointDetail.couldntCopyLink"),
                    body: t("apps.ChatEndpointDetail.selectCopyManually"),
                    tone: "error",
                  }),
              );
            }}
          >
            <Copy />
            {t("apps.ChatEndpointDetail.copyLink")}
          </Button>
        </div>
      )}
      <div className="space-y-2">
        {linksQuery.isPending || linksView.kind === "reconnecting" ? <p role="status" className="text-sm text-muted-foreground">{t("apps.ChatEndpointDetail.loadingPeople")}</p> : linksView.kind === "error" ? <QueryErrorState size="inline" error={linksQuery.error} action={t("errorActions.loadPeople")} onRetry={linksView.retry} retrying={linksView.isFetching} /> : links.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
            {t("apps.ChatEndpointDetail.noLinkedAccounts")}
          </p>
        ) : (
          <div role="list" aria-label={t("apps.ChatEndpointDetail.peopleList")} className="divide-y divide-border border-y border-border">
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
                      {link.status === "revoked" ? t("apps.ChatEndpointDetail.disconnected") : link.status === "linked"
                        ? link.externalLabel
                        : t("apps.ChatEndpointDetail.waitingAccountConfirmation")}
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
                    <Unlink />
                    {t("apps.ChatEndpointDetail.disconnect")}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={createIntent.isPending}
                    onClick={() => { setConfirmationUrl(null); setConfirmationFor(link.externalLabel); createIntent.mutate(link.principalId); }}
                  >
                    {t("apps.ChatEndpointDetail.createConfirmationLink")}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      <SlackSetupAdvanced label={t("apps.ChatEndpointDetail.guestAccess")}>
        <SettingToggle label={t("apps.ChatEndpointDetail.allowUnlinkedPeople")}
          detail={t("apps.ChatEndpointDetail.allowUnlinkedDetail")}
          checked={allowUnlinked} pending={updatePolicy.isPending} onChange={value => updatePolicy.mutate(value)} />
      </SlackSetupAdvanced>
      {endpoint.provider === "slack" && <SlackSetupAdvanced label={t("apps.ChatEndpointDetail.personalSlackSearch")}><SlackSearchAccess companyId={endpoint.companyId} endpointId={endpointId} /></SlackSetupAdvanced>}
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
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: queryKeys.chatEndpoints.conversations(endpointId),
    queryFn: () => chatEndpointsApi.listConversations(endpointId),
    ...liveChatQueryOptions,
  });
  const view = useQueryView(query);
  return (
    <section className="space-y-4">
      {query.isPending || view.kind === "reconnecting" ? <p role="status" className="text-sm text-muted-foreground">{t("apps.ChatEndpointDetail.loadingConversations")}</p> : view.kind === "error" ? (
        <QueryErrorState error={query.error} action={t("errorActions.loadTheConversations")} onRetry={view.retry} retrying={view.isFetching} />
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
  const { t } = useTranslation();
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
        title: item.kind === "publication" ? t("apps.ChatEndpointDetail.publicationQueuedForReplay") : t("apps.ChatEndpointDetail.deliveryQueuedForReplay"),
        tone: "success",
      });
    },
    onError: (error) =>
      pushToast({
        title: t("apps.ChatEndpointDetail.couldntReplayActivity"),
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
            ? t("apps.ChatEndpointDetail.taskStartRetried")
            : input.item.actionType === "slash_task_start"
              ? t("apps.ChatEndpointDetail.taskStartCancelled")
              : input.item.actionType === "provider_effect" &&
                  input.action === "mark_delivered"
                ? t("apps.ChatEndpointDetail.providerReplyMarkedDelivered")
                : input.item.actionType === "provider_effect" &&
                    input.action === "retry_anyway"
                  ? t("apps.ChatEndpointDetail.providerReplyRetried")
                  : input.item.actionType === "provider_effect"
                    ? t("apps.ChatEndpointDetail.providerReplyCancelled")
                    : input.action === "mark_delivered"
                      ? t("apps.ChatEndpointDetail.publicationMarkedDelivered")
                      : input.action === "retry_anyway"
                        ? t("apps.ChatEndpointDetail.publicationQueuedForRetry")
                        : t("apps.ChatEndpointDetail.publicationCancelled"),
        tone: "success",
      });
    },
    onError: (error) =>
      pushToast({
        title: t("apps.ChatEndpointDetail.couldntResolveActivity"),
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
        title: action === "pause" ? t("apps.ChatEndpointDetail.connectionPaused") : t("apps.ChatEndpointDetail.connectionResumed"),
        tone: "success",
      });
    },
    onError: (error) =>
      pushToast({
        title: t("apps.ChatEndpointDetail.couldntUpdateConnection"),
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
        ["Events API", endpoint.setup.callbackSurfaces.events],
        [t("apps.ChatEndpointDetail.interactivity"), endpoint.setup.callbackSurfaces.interactivity],
        [t("apps.ChatEndpointDetail.slashCommand"), endpoint.setup.callbackSurfaces.slashCommands],
      ] as const)
    : [];
  return (
    <section className="space-y-5" aria-label={t("apps.ChatEndpointDetail.connectionActivity")}>
      <h2 className="text-lg font-semibold">{t("apps.ChatEndpointDetail.connectionActivity")}</h2>
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
                <span className="font-medium">{t("apps.ChatEndpointDetail.lastReportedHealth")}</span>{" "}
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
          <span>{t("apps.ChatEndpointDetail.connectionHealthAndControls")}</span>
          <span className="flex items-center gap-2">
            {endpoint.setup?.callbacksNeedUpdate && <span className="text-xs text-(--status-task-blocked)">{t("apps.ChatEndpointDetail.callbackUrlsNeedAttention")}</span>}
            <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
          </span>
        </summary>
        <div className="space-y-5 border-t border-border p-4">
      {endpoint.provider === "slack" && callbackSurfaceRows.length > 0 && (
        <div
          className="space-y-3 text-sm"
        >
          <p className="font-medium">{t("apps.ChatEndpointDetail.slackCallbackHealth")}</p>
          <p className="text-xs text-muted-foreground">
            {endpoint.setup?.callbacksNeedUpdate
              ? t("apps.ChatEndpointDetail.slackCallbackUpdateNeeded")
              : t("apps.ChatEndpointDetail.callbackRecordsIndependently")}
          </p>
          <div className="divide-y divide-border border-y border-border">
            {callbackSurfaceRows.map(([label, surface]) => (
              <div key={label} className="flex flex-wrap items-center justify-between gap-3 py-2">
                <p className="text-xs font-medium">{label}</p>
                <p className="text-xs text-muted-foreground">
                  {surface.status === "current"
                    ? t("apps.ChatEndpointDetail.current")
                    : surface.status === "stale"
                      ? t("apps.ChatEndpointDetail.staleUrl")
                      : t("apps.ChatEndpointDetail.notObserved")}
                </p>
                {surface.observedAt && (
                  <p className="text-xs text-muted-foreground">
                    {t("apps.ChatEndpointDetail.lastObserved")}{" "}
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
                )}
                {t("common.pause")}
              </Button>
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
                )}
                {t("common.resume")}
              </Button>
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
                  ? t("apps.ChatEndpointDetail.finishSetup")
                  : t("common.reconnect")}
              </Button>
            )}
            <Button
              variant="ghost"
              className="text-destructive hover:text-destructive"
              disabled={lifecycle.isPending}
              onClick={() => setRemoveOpen(true)}
            >
              <Trash2 />
              {t("apps.ChatEndpointDetail.removeConnection")}
            </Button>
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
          <h3 className="text-sm font-semibold">{t("apps.ChatEndpointDetail.recentActivity")}</h3>
          {endpoint.provider === "speko" && !cursor && <Button size="sm" variant="ghost" onClick={() => { void query.refetch(); calls.onRetry(); }} disabled={query.isFetching || calls.loading}>{t("common.refresh")}</Button>}
        </div>
        {endpoint.provider === "agentmail" && rows.some((item) => item.kind === "publication" && item.status === "delivery_unknown") && (
          <p className="text-sm text-muted-foreground">
            {t("apps.ChatEndpointDetail.reviewUnconfirmedEmail")}{" "}
            <Link to={`/apps/chat/${endpointId}/conversations`} className="underline underline-offset-4">{t("apps.ChatEndpointDetail.conversationTask")}</Link>.
          </p>
        )}
        <div className="divide-y divide-border border-y border-border">
          {(query.isLoading || view.kind === "reconnecting" || calls.loading) && (
            <div className="flex items-center gap-2 py-5 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("apps.ChatEndpointDetail.loadingActivity")}
            </div>
          )}
          {view.kind === "error" && (
            <div className="py-4">
              <QueryErrorState
                error={query.error}
                action={t("errorActions.loadTheConnectionActivity")}
                onRetry={view.retry}
                retrying={view.isFetching}
              />
            </div>
          )}
          {endpoint.provider === "speko" && !cursor && [
            calls.error && t("apps.ChatEndpointDetail.callActivityError", { error: calls.error }),
            calls.incomingError && t("apps.ChatEndpointDetail.unapprovedCallsError", { error: calls.incomingError }),
            calls.endError && t("apps.ChatEndpointDetail.callEndError", { error: calls.endError }),
          ].filter(Boolean).map((message) => <div key={String(message)} className="flex flex-wrap items-center justify-between gap-3 py-4"><p role="alert" className="text-sm text-destructive">{message}</p><Button size="sm" variant="outline" onClick={calls.onRetry}>{t("apps.ChatEndpointDetail.retryCalls")}</Button></div>)}
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
                      {item.fileTransfer.phase.replaceAll("_", " ")}
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
                    aria-label={item.kind === "publication" ? t("apps.ChatEndpointDetail.replayFailedPublication") : t("apps.ChatEndpointDetail.replayFailedDelivery")}
                    disabled={replay.isPending}
                    onClick={() => replay.mutate(item)}
                  >
                    {replay.isPending && replay.variables?.id === item.id ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <RefreshCw />
                    )}
                    {t("apps.ChatEndpointDetail.replay")}
                  </Button>
                )}
                {endpoint.provider !== "agentmail" && isResolutionEligible(item) && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setResolutionItem(item)}
                  >
                    {t("apps.ChatEndpointDetail.resolve")}
                  </Button>
                )}
              </div>
            );
          })}
          {activityLoaded && !calls.loading && !calls.error && !calls.incomingError && activityEntries.length === 0 && (
            <p className="py-5 text-sm text-muted-foreground">
              {t("apps.ChatEndpointDetail.noConnectionActivity")}
            </p>
          )}
        </div>
      </div>
      <nav aria-label={t("apps.ChatEndpointDetail.activityPagination")} className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">{t("apps.ChatEndpointDetail.page", { page: cursors.length })}</span>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={cursors.length === 1 || query.isFetching} onClick={() => setCursors((pages) => pages.slice(0, -1))}>{t("common.previous")}</Button>
          <Button size="sm" variant="outline" disabled={!query.data?.nextCursor || query.isFetching || view.kind === "error"} onClick={() => { if (query.data?.nextCursor) setCursors((pages) => [...pages, query.data.nextCursor!]); }}>{t("common.next")}</Button>
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
                ? t("apps.ChatEndpointDetail.resolveTaskStart")
                : resolutionItem?.actionType === "provider_effect"
                  ? t("apps.ChatEndpointDetail.resolveProviderReply")
                  : t("apps.ChatEndpointDetail.resolveDelivery")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {resolutionItem?.actionType === "slash_task_start"
                ? t("apps.ChatEndpointDetail.taskStartLostConfirmation")
                : resolutionItem?.actionType === "provider_effect"
                  ? t("apps.ChatEndpointDetail.providerReplyLostConfirmation")
                  : resolutionItem
                    ? activityResolutionDescription(resolutionItem)
                    : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="sm:flex-wrap">
            <AlertDialogCancel disabled={resolveActivity.isPending}>
              {t("apps.ChatEndpointDetail.keepUnresolved")}
            </AlertDialogCancel>
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
                    ? t("apps.ChatEndpointDetail.cancelTaskStart")
                    : resolutionItem.actionType === "provider_effect"
                      ? t("apps.ChatEndpointDetail.cancelProviderReply")
                      : resolutionItem.fileTransfer
                        ? t("apps.ChatEndpointDetail.cancelFileTransfer")
                        : t("apps.ChatEndpointDetail.cancelPublication")}
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
                    ? t("apps.ChatEndpointDetail.retryFileNotification")
                    : t("apps.ChatEndpointDetail.retryAnyway")}
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
                >
                  {t("apps.ChatEndpointDetail.markDelivered")}
                </AlertDialogAction>
              )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("apps.ChatEndpointDetail.removeThisConnection")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("apps.ChatEndpointDetail.removeNotice", { agent: endpoint.assignedAgentName, provider: providerNames[endpoint.provider] })}{" "}
              {providerLifecycleGuidance[endpoint.provider].remove}
              {endpoint.provider === "slack" && (
                <> <a
                  href={endpoint.setup?.slackRegistration?.managementUrl ?? "https://api.slack.com/apps"}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-4"
                >{t("apps.ChatEndpointDetail.openSlackAppSettings")}</a> {t("apps.ChatEndpointDetail.manageSlackApp")}</>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={lifecycle.isPending}
              onClick={() => lifecycle.mutate("remove")}
            >
              {lifecycle.isPending && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              {t("apps.ChatEndpointDetail.removeConnection")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
