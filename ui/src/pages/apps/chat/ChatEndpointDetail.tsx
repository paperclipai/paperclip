import { Trans } from "react-i18next";
import { t, useTranslation } from "@/i18n";
import { SlackToolsSettings, SlackSearchAccess } from "./SlackToolSettings";
import { defaultSlackAppName } from "./slack-app-name";
import { ChatCommunicationInstructions } from "./ChatCommunicationInstructions";
import { SlackAvatarSettings } from "./SlackAvatarStep";
import { agentsApi } from "@/api/agents";
import { agentAvatarUrl } from "@/lib/agent-avatar-url";
import { resolveAgentAppearance } from "@paperclipai/shared";
import { GitHubBotManagement, GitHubReviews } from "./GitHubBotManagement";
import { EmailEndpointSettings } from "./EmailEndpointSetup";
import { EmailConnectionAccess } from "@/components/EmailConnectionAccess";
import { emailApi } from "@/api/email";
import { toolsApi } from "@/api/tools";
import { useEffect, useMemo, useState } from "react";
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
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useToast } from "@/context/ToastContext";
import { formatDateTime } from "@/lib/utils";
import { queryKeys } from "@/lib/queryKeys";
import { copyTextToClipboard } from "@/lib/clipboard";
import { Link, Navigate, useNavigate, useParams } from "@/lib/router";
import { chatLabel } from "./chat-copy";
import { chatActivitySummary } from "./chat-activity-copy";
import { chatActivityDetail } from "./chat-activity-guidance";
import { photonHealthMessage, photonResourceType } from "./photon-copy";

const tabs = ["settings", "access", "reviews", "conversations", "activity"] as const;
type ChatTab = (typeof tabs)[number];
const providerNames: Record<ChatProvider, string> = {
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
  agentmail: {
    get reconnect() { return t("sep12Connections.reconnectSameInbox"); },
    get remove() { return t("sep12Connections.disconnectKeepHistory"); },
  },
  slack: {
    get reconnect() { return t("chatUi.chatEndpointDetail.reconnectVerifiesOrReplacesCredentialsForThisSameSlackApp"); },
    get remove() { return t("chatUi.chatEndpointDetail.paperclipArchivesTheEndpointStopsNewIngressAndRetiresIts"); },
  },
  github: {
    get reconnect() { return t("chatUi.chatEndpointDetail.reconnectVerifiesThisSameAppAndInstallationThenUpdatesIts"); },
    get remove() { return t("chatUi.chatEndpointDetail.paperclipArchivesTheEndpointStopsNewIngressAndRetiresIts71"); },
  },
  discord: {
    get reconnect() { return t("chatUi.chatEndpointDetail.reconnectVerifiesThisSameDiscordApplicationAndServerInstallationIt"); },
    get remove() { return t("chatUi.chatEndpointDetail.paperclipArchivesTheEndpointStopsItsPaperclipGatewayConnectionAnd"); },
  },
  "microsoft-teams": {
    get reconnect() { return t("chatUi.chatEndpointDetail.reconnectVerifiesThisSameMicrosoftAppTenantAndBotIdentity"); },
    get remove() { return t("chatUi.chatEndpointDetail.paperclipArchivesTheEndpointStopsNewIngressAndRetiresIts83"); },
  },
  "imessage-photon": {
    get reconnect() { return t("communityPhoton.reconnectGuidance"); },
    get remove() { return t("communityPhoton.disconnectGuidance"); },
  },
  telegram: {
    get reconnect() { return t("chatUi.chatEndpointDetail.reconnectVerifiesThisSameBotFatherBotAndAutomaticallyRefreshesIts"); },
    get remove() { return t("chatUi.chatEndpointDetail.paperclipArchivesTheEndpointAndQueuesDurableRemovalOfIts"); },
  },
};

const activityKindLabels: Record<ChatActivityItem["kind"], string> = {
  get delivery() { return t("chatUi.chatEndpointDetail.inboundDelivery"); },
  get publication() { return t("chatUi.chatEndpointDetail.outboundPublication"); },
  get action() { return t("chatUi.chatEndpointDetail.providerAction"); },
  get health() { return t("chatUi.chatEndpointDetail.connectionHealth"); },
  get repair() { return t("chatUi.chatEndpointDetail.connectionRepair"); },
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
    return t("chatUi.chatEndpointDetail.theFileUploadWasConfirmedButItsTeamsNotificationWas");
  if (phase === "consent_unknown")
    return t("chatUi.chatEndpointDetail.theConsentCardMayHaveReachedTeamsFileDeliveryIs");
  if (phase)
    return t("chatUi.chatEndpointDetail.theFileMayAlreadyExistInOneDriveCancellingStopsThis");
  return t("chatUi.chatEndpointDetail.paperclipLostConfirmationAfterSendingCheckTheProviderConversationFirst");
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
  return replayableFailureStates.has(item.status) ? t("localizationInspector.ui_Reason") : t("localizationPlugins.ui_Details");
}

export function connectionHealthPresentation(
  endpoint: Pick<ChatEndpoint, "status" | "healthMessage" | "lastError"> & Partial<Pick<ChatEndpoint, "provider">>,
) {
  // Health events outlive pause/removal. They are history, not lifecycle state.
  const lifecycleMessages = {
    draft: t("chatUi.chatEndpointDetail.connectionSetupIsIncomplete"),
    verifying: t("chatUi.chatEndpointDetail.connectionVerificationIsInProgress"),
    paused: t("chatUi.chatEndpointDetail.connectionIsPausedResumeItToReceiveNewMessages"),
    attention: t("chatUi.chatEndpointDetail.connectionNeedsAttention"),
    revoked: t("chatUi.chatEndpointDetail.connectionAccessIsRevokedReconnectToVerifyAccess"),
    archived: t("chatUi.chatEndpointDetail.connectionHasBeenRemovedFromPaperclip"),
  };
  const lifecycleMessage =
    endpoint.status === "active" ? null : lifecycleMessages[endpoint.status];
  return {
    message: lifecycleMessage ?? photonHealthMessage(endpoint.provider, endpoint.healthMessage) ?? null,
    previousHealth: lifecycleMessage ? (photonHealthMessage(endpoint.provider, endpoint.healthMessage) ?? null) : null,
    error: endpoint.lastError ?? null,
    errorLabel: ["active", "attention", "revoked"].includes(endpoint.status)
      ? t("localizationInspector.ui_Reason")
      : t("chatUi.chatEndpointDetail.lastReportedError"),
  };
}

export function ChatEndpointDetail() {
  const { i18n } = useTranslation();
  const tabItems = useMemo(() => tabs.map((value) => ({ value, label: chatLabel(value) })), [i18n.resolvedLanguage]);
  const { endpointId = "", tab = "settings" } = useParams<{
    endpointId: string;
    tab?: string;
  }>();
  const activeTab = tabs.includes(tab as ChatTab) ? (tab as ChatTab) : null;
  const navigate = useNavigate();
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
  const [copyStatus, setCopyStatus] = useState<"copied" | "failed" | null>(null);

  useEffect(() => {
    if (!endpoint || !activeTab) return;
    setBreadcrumbs([
      { label: t("localizationConnections.connectors16"), href: "/apps" },
      {
        label: `${endpoint.assignedAgentName} · ${providerNames[endpoint.provider]}`,
        href: `/apps/chat/${endpoint.id}/settings`,
      },
      {
        label:
          tabItems.find((item) => item.value === activeTab)?.label ??
          t("localizationCommonChrome.settings"),
      },
    ]);
    return () => setBreadcrumbs([]);
  }, [activeTab, endpoint, setBreadcrumbs, tabItems]);

  if (!activeTab)
    return <Navigate replace to={`/apps/chat/${endpointId}/settings`} />;
  if (endpointQuery.isLoading)
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />{t("chatUi.chatEndpointDetail.loadingConnection")}</div>
    );
  if (endpointQuery.isError || !endpoint)
    return (
      <div className="space-y-3">
        <p className="text-sm text-destructive">{t("chatUi.chatEndpointDetail.thisChatConnectionCouldNotBeLoaded")}</p>
        <Button variant="outline" onClick={() => endpointQuery.refetch()}>{t("localizationIssuePanels.ui_Try_again_982hh6")}</Button>
      </div>
    );
  if (endpoint.provider === "agentmail" && activeTab === "settings")
    return <EmailEndpointSettings key={endpoint.id} endpointId={endpoint.id} companyId={endpoint.companyId} assignedAgentName={endpoint.assignedAgentName} />;
  const setupIncomplete =
    endpoint.setup?.step !== "complete" &&
    ["draft", "verifying", "attention", "revoked"].includes(endpoint.status);

  return (
    <div className="max-w-5xl space-y-6 pb-12">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold">{t("chatUi.chatEndpointDetail.in", { value0: endpoint.assignedAgentName, value1: providerNames[endpoint.provider] })}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {endpoint.providerAccountLabel ?? (endpoint.provider === "agentmail" ? endpoint.botExternalId ?? t("oct5Apps.copy081") : t("chatUi.chatEndpointDetail.chatConnection"))}
          </p>
          {endpoint.provider === "imessage-photon" && endpoint.botExternalId && endpoint.photonAllocation !== "shared" && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
              <span>{endpoint.botExternalId}</span>
              <Button variant="ghost" size="sm" aria-label={t("communityPhoton.copyDedicatedNumber")} onClick={async () => {
                try { await copyTextToClipboard(endpoint.botExternalId!); setCopyStatus("copied"); }
                catch { setCopyStatus("failed"); }
              }}><Copy className="size-4" />{t("communityPhoton.copyNumber")}</Button>
              <span role="status" className="text-muted-foreground">{copyStatus === "copied" ? t("communityPhoton.numberCopied") : copyStatus === "failed" ? t("communityPhoton.copyFailed") : null}</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {setupIncomplete ? (
            <Button
              variant="outline"
              onClick={() =>
                navigate(
                  `/apps/chat/connect?provider=${endpoint.provider}&purpose=chat&resume=${endpoint.id}`,
                )
              }
            >{t("chatUi.connectionIntentInteractionBody.continueSetup")}</Button>
          ) : null}
          {endpoint.status !== "active" && <StatusBadge status={endpoint.status} />}
        </div>
      </header>
      {activeTab === "settings" && (
        <>
{endpoint.provider === "github" && <GitHubBotManagement endpoint={endpoint} view="settings" />}
{endpoint.provider !== "github" && <Settings endpointId={endpoint.id} endpoint={endpoint} />}
</>
      )}
      {activeTab === "reviews" && endpoint.provider === "github" && <GitHubReviews endpointId={endpoint.id} />}
{activeTab === "access" && endpoint.provider === "github" && <GitHubBotManagement endpoint={endpoint} view="access" />}
{activeTab === "access" && endpoint.provider === "agentmail" && <EmailAccess endpoint={endpoint} />}
{activeTab === "access" && endpoint.provider !== "github" && endpoint.provider !== "agentmail" && (
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
    </div>
  );
}

function EmailAccess({ endpoint }: { endpoint: ChatEndpoint }) {
  useTranslation();
  const connection = useQuery({
    queryKey: queryKeys.tools.connection(endpoint.connectionId ?? ""),
    queryFn: () => toolsApi.getConnection(endpoint.connectionId!),
    enabled: Boolean(endpoint.connectionId),
  });
  const agents = useQuery({
    queryKey: queryKeys.agents.list(endpoint.companyId),
    queryFn: () => agentsApi.list(endpoint.companyId),
  });
  if (!endpoint.connectionId || agents.isError || connection.isError) return (
    <div className="space-y-3">
      <p role="alert" className="text-sm text-destructive">{t("oct5Apps.copy082")}</p>
      <Button variant="outline" onClick={() => { void agents.refetch(); void connection.refetch(); }}>{t("localizationProjectRepositories.retry")}</Button>
    </div>
  );
  if (agents.isPending || connection.isPending) return <p role="status" className="text-sm text-muted-foreground">{t("oct5Apps.copy083")}</p>;
  const sourceId = connection.data.config?.credentialConnectionId;
  const credentialId = typeof sourceId === "string" ? sourceId : endpoint.connectionId;
  return <section className="max-w-3xl space-y-4">
    <h2 className="text-lg font-semibold">{t("localizationSettings.navAccess")}</h2>
    {credentialId !== endpoint.connectionId && <p className="text-sm text-muted-foreground">{t("oct5Apps.copy084")}</p>}
    <EmailConnectionAccess key={credentialId} companyId={endpoint.companyId} connectionId={credentialId} agents={agents.data} />
  </section>;
}

function Settings({
  endpointId,
  endpoint,
}: {
  endpointId: string;
  endpoint: Awaited<ReturnType<typeof chatEndpointsApi.get>>;
}) {
  useTranslation();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [messageCopied, setMessageCopied] = useState(false);
  const avatarAgent = useQuery({
    queryKey: queryKeys.agents.detail(endpoint.assignedAgentId),
    queryFn: () => agentsApi.get(endpoint.assignedAgentId, endpoint.companyId),
    enabled: endpoint.provider === "slack",
  });
  const mentionMessage = `@${(endpoint.botUsername ?? endpoint.botLabel ?? endpoint.assignedAgentName).replace(/^@/, "")} you there?`;
  const resourcesQuery = useQuery({
    queryKey: queryKeys.chatEndpoints.resources(endpointId),
    queryFn: () => chatEndpointsApi.listResources(endpointId),
  });
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
        title: t("chatUi.chatEndpointDetail.couldnTUpdateDestination"),
        body: error instanceof Error ? error.message : t("localizationConnections.tryAgain227"),
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
        title: t("chatUi.chatEndpointDetail.couldnTUpdateSettings"),
        body: error instanceof Error ? error.message : t("localizationConnections.tryAgain227"),
        tone: "error",
      }),
  });
  const resources = resourcesQuery.data ?? [];
  const destinationResources = resources.filter((resource) =>
    isIndividuallyToggleableResource(endpoint.provider, resource.type),
  );
  const toggleResource = (resource: ChatEndpointResource, enabled: boolean) =>
    // A cached inventory must not overwrite another operator's unrelated edits.
    saveResources.mutate({ id: resource.id, enabled });
  return (
    <section className="max-w-3xl space-y-7">
      {endpoint.provider === "imessage-photon" && <p className="text-sm text-muted-foreground">{endpoint.photonAllocation === "shared" ? t("communityPhoton.settingsShared") : t("communityPhoton.settingsDedicated")}</p>}
      {endpoint.provider === "slack" && (
        <div className="space-y-2 text-sm">
          <h2 className="text-lg font-semibold">{t("sep28Apps.copy278")}</h2>
          <p>{t("sep28Apps.copy279")}</p>
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
            <code>{mentionMessage}</code>
            <Button size="icon" variant="ghost" aria-label={messageCopied ? t("sep28Settings.messageCopied") : t("localizationTaskRuntime.ui_Copy_message_1b3i557")} onClick={() => {
              void copyTextToClipboard(mentionMessage).then(() => setMessageCopied(true), () => pushToast({ title: t("sep28Apps.copy280"), body: t("chatUi.chatEndpointDetail.selectAndCopyItManually"), tone: "error" }));
            }}>{messageCopied ? <Check className="size-4" /> : <Copy className="size-4" />}</Button>
          </div>
        </div>
      )}
      {endpoint.provider === "slack" && (
        avatarAgent.isPending ? <p role="status" className="text-sm text-muted-foreground">{t("sep28Apps.copy239")}</p>
          : avatarAgent.isError ? <p role="alert" className="text-sm text-destructive">{t("sep28Apps.copy240")} <button className="underline" onClick={() => void avatarAgent.refetch()}>{t("localizationProjectRepositories.retry")}</button></p>
          : <SlackAvatarSettings
              agentName={avatarAgent.data?.name ?? endpoint.assignedAgentName}
              appName={endpoint.setup?.slackApp?.appName ?? defaultSlackAppName(avatarAgent.data?.name ?? endpoint.assignedAgentName)}
              avatarUrl={agentAvatarUrl(resolveAgentAppearance(avatarAgent.data?.appearance, endpoint.assignedAgentId), 512, 1, "rest")}
            />
      )}
      {endpoint.provider === "slack" && <SlackToolsSettings companyId={endpoint.companyId} endpointId={endpointId} connectionId={endpoint.connectionId} />}
      {endpoint.provider === "slack" && <ChatCommunicationInstructions
        key={endpoint.id}
        value={endpoint.communicationInstructions ?? ""}
        onSave={async (communicationInstructions) => {
          const next = await chatEndpointsApi.update(endpointId, { communicationInstructions });
          queryClient.setQueryData(queryKeys.chatEndpoints.detail(endpointId), next);
        }}
      />}
      {endpoint.provider === "telegram" && (
        <div className="space-y-2">
          <h2 className="text-lg font-semibold">{t("chatUi.chatEndpointDetail.telegramGroupCommand")}</h2>
          <div className="rounded-lg border border-border p-3 text-sm">
            <code>
              /task@
              {endpoint.botUsername?.replace(/^@/, "") ?? "bot_username"}{" "}
              &lt;request&gt;
            </code>
            <p className="mt-2 text-muted-foreground">{t("chatUi.chatEndpointDetail.telegramSDefaultPrivacyModeDoesNotDeliverOrdinaryMentions")}</p>
          </div>
        </div>
      )}
      <div>
        <h2 className="text-lg font-semibold">{t("chatUi.chatEndpointDetail.whereThisAgentCanWork")}</h2>
      </div>
      <div className="space-y-2">
        <h3 className="text-sm font-semibold">{endpoint.provider === "slack" ? t("sep28Apps.copy281") : t("chatUi.chatEndpointDetail.destinations")}</h3>
        {resourcesQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">{t("chatUi.chatEndpointDetail.loadingDestinations")}</p>
        ) : destinationResources.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">{t("chatUi.chatEndpointDetail.noProviderDestinationsHaveBeenDiscoveredYet")}</p>
        ) : (
          <div className="divide-y divide-border border-y border-border">
            {destinationResources.map((resource) => (
              <div key={resource.id} className="flex items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {resource.label}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {resource.availability === "available"
                      ? (resource.detail ?? (endpoint.provider === "imessage-photon" ? photonResourceType(resource.type) : resource.type))
                      : t("chatUi.chatEndpointDetail.unavailableAtTheProvider")}
                  </p>
                  {resource.participants?.length ? <p className="mt-1 break-words text-xs text-muted-foreground">{t("communityPhoton.participants", { participants: resource.participants.join(", ") })}</p> : null}
                </div>
                <ToggleSwitch
                  aria-label={t("chatUi.enableDestination", { name: resource.label })}
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
            ))}
          </div>
        )}
      </div>
      {endpoint.provider !== "github" && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">{t("chatUi.chatEndpointDetail.privateConversations")}</h3>
          <SettingToggle
            label={t("chatUi.chatEndpointDetail.allowDirectMessages")}
            detail={
              endpoint.provider === "discord"
                ? t("chatUi.chatEndpointDetail.peopleMustAlsoEnableDirectMessagesInTheirSharedDiscord")
                : t("chatUi.chatEndpointDetail.peopleCanStartOrContinueATaskInADirect")
            }
            checked={endpoint.allowDirectMessages ?? false}
            pending={updateEndpoint.isPending}
            onChange={(allowDirectMessages) =>
              updateEndpoint.mutate({ allowDirectMessages })
            }
          />
          {endpoint.provider === "microsoft-teams" && (
            <SettingToggle
              label={t("chatUi.chatEndpointDetail.allowGroupChats")}
              detail={t("chatUi.chatEndpointDetail.theBotMayParticipateInGroupChatsWhereItIs")}
              checked={endpoint.allowGroupChats ?? false}
              pending={updateEndpoint.isPending}
              onChange={(allowGroupChats) =>
                updateEndpoint.mutate({ allowGroupChats })
              }
            />
          )}
        </div>
      )}
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
  detail: string;
  checked: boolean;
  pending: boolean;
  onChange: (value: boolean) => void;
}) {
  useTranslation();
  return (
    <div className="flex items-center gap-3 border-y border-border py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{detail}</p>
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
  useTranslation();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [confirmationUrl, setConfirmationUrl] = useState<string | null>(null);
  const [joinCommandCopied, setJoinCommandCopied] = useState(false);
  const joinCommand = `${endpoint.setup?.slackApp?.command ?? endpoint.setup?.command ?? "/paperclip"} connect`;
  const linksQuery = useQuery({
    queryKey: queryKeys.chatEndpoints.principals(endpointId),
    queryFn: () => chatEndpointsApi.listPrincipals(endpointId),
  });
  const updatePolicy = useMutation({
    mutationFn: (value: boolean) =>
      chatEndpointsApi.update(endpointId, { allowUnlinkedPeople: value }),
    onSuccess: (next) =>
      queryClient.setQueryData(
        queryKeys.chatEndpoints.detail(endpointId),
        next,
      ),
    onError: (error) => pushToast({ title: t("sep28Apps.copy282"), body: error instanceof Error ? error.message : t("localizationConnections.tryAgain227"), tone: "error" }),
  });
  const createIntent = useMutation({
    mutationFn: (principalId: string) =>
      chatEndpointsApi.createLinkIntent(endpointId, principalId),
    onSuccess: ({ confirmationUrl }) => {
      setConfirmationUrl(
        new URL(confirmationUrl, window.location.origin).toString(),
      );
      pushToast({
        title: t("chatUi.chatEndpointDetail.privateIdentityLinkURLCreated"),
        body: t("chatUi.chatEndpointDetail.sendItOnlyToThePersonWhoseProviderIdentityIs"),
        tone: "success",
      });
    },
    onError: (error) =>
      pushToast({
        title: t("chatUi.chatEndpointDetail.couldnTCreateIdentityLink"),
        body: error instanceof Error ? error.message : t("localizationConnections.tryAgain227"),
        tone: "error",
      }),
  });
  const revoke = useMutation({
    mutationFn: (principalId: string) =>
      chatEndpointsApi.revokeLink(endpointId, principalId),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.chatEndpoints.principals(endpointId),
      }),
  });
  const links = linksQuery.data ?? [];
  return (
    <section className="max-w-3xl space-y-7">
      <div>
        <h2 className="text-lg font-semibold">{t("chatUi.chatEndpointDetail.externalIdentityAccess")}</h2>
      </div>
      {endpoint.provider === "slack" && <SlackSearchAccess companyId={endpoint.companyId} endpointId={endpointId} />}
      {endpoint.provider === "slack" && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">{t("sep28Apps.copy283")}</h3>
          <ol className="list-decimal space-y-3 pl-5 text-sm">
            <li>{t("sep28Apps.copy284")} <div className="mt-2 flex items-center justify-between gap-3 rounded-lg border border-border p-3">
                <code>{joinCommand}</code>
                <Button size="sm" variant="ghost" onClick={() => {
                  void copyTextToClipboard(joinCommand).then(() => setJoinCommandCopied(true), () => pushToast({ title: t("sep28Apps.copy285"), body: t("chatUi.chatEndpointDetail.selectAndCopyItManually"), tone: "error" }));
                }}><Copy className="size-4" />{joinCommandCopied ? t("pages.agentDetail.copied") : t("sep28Apps.copy200")}</Button>
              </div>
            </li>
            <li>{t("sep28Apps.copy286")}</li>
            <li><Trans i18nKey="sep28Apps.requestMemberAccess" components={{ request: <strong /> }} /></li>
          </ol>
          <p className="text-sm text-muted-foreground">{t("sep28Apps.copy288")}</p>
        </div>
      )}
      <SettingToggle
        label={t("chatUi.chatEndpointDetail.allowUnlinkedPeople")}
        detail={t("chatUi.chatEndpointDetail.theyAreRestrictedGuestsTheirTasksRunOnlyWithAn")}
        checked={allowUnlinked}
        pending={updatePolicy.isPending}
        onChange={(value) => updatePolicy.mutate(value)}
      />
      {confirmationUrl && (
        <div className="space-y-2 border-y border-border py-3">
          <p className="text-sm font-medium">{t("chatUi.chatEndpointDetail.privateConfirmationLink")}</p>
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
                    title: t("chatUi.chatEndpointDetail.confirmationLinkCopied"),
                    tone: "success",
                  }),
                () =>
                  pushToast({
                    title: t("chatUi.chatEndpointDetail.couldnTCopyTheLink"),
                    body: t("chatUi.chatEndpointDetail.selectAndCopyItManually"),
                    tone: "error",
                  }),
              );
            }}
          >
            <Copy />{t("localizationIssueAux.ui_Copy_link_9zccf0")}</Button>
        </div>
      )}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold">{t("chatUi.chatEndpointDetail.identityLinks")}</h3>
        {links.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">{t("chatUi.chatEndpointDetail.externalPeopleAppearHereAfterTheyMessageTheAgent")}</p>
        ) : (
          <div className="divide-y divide-border border-y border-border">
            {links.map((link) => (
              <div
                key={link.id}
                className="flex flex-wrap items-center gap-3 py-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{link.externalLabel}</p>
                  <p className="text-xs text-muted-foreground">
                    {link.paperclipUserLabel
                      ? t("chatUi.linkedTo", { name: link.paperclipUserLabel })
                      : (link.externalDetail ?? t("chatUi.chatEndpointDetail.notLinked"))}
                  </p>
                </div>
                {link.status === "linked" ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={revoke.isPending}
                    onClick={() => revoke.mutate(link.principalId)}
                  >
                    <Unlink />{t("localizationAccessBootstrap.revoke")}</Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={createIntent.isPending}
                    onClick={() => createIntent.mutate(link.principalId)}
                  >{t("chatUi.chatEndpointDetail.createPrivateLink")}</Button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
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
  useTranslation();
  const query = useQuery({
    queryKey: queryKeys.chatEndpoints.conversations(endpointId),
    queryFn: () => chatEndpointsApi.listConversations(endpointId),
    ...liveChatQueryOptions,
  });
  const rows = query.data ?? [];
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">{t("chatUi.chatEndpointDetail.conversations")}</h2>
      </div>
      {query.isPending ? <p role="status" className="text-sm text-muted-foreground">{t("oct5Apps.copy085")}</p> : query.isError ? (
        <div className="space-y-3">
          <p role="alert" className="text-sm text-destructive">{t("oct5Apps.copy086")}</p>
          <Button variant="outline" onClick={() => void query.refetch()}>{t("localizationProjectRepositories.retry")}</Button>
        </div>
      ) : rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
          {provider === "agentmail"
            ? t("oct5Apps.copy087")
            : t("chatUi.chatEndpointDetail.noConversationsYetAddressTheAgentInAnEnabledDestination")}
        </p>
      ) : (
        <ul aria-label={t("chatUi.chatEndpointDetail.conversations")} className="divide-y divide-border overflow-x-auto border-y border-border">
          {rows.map((row) => (
            <li key={row.id} className="flex min-w-xl items-center gap-3 px-2 py-3 text-sm transition-colors hover:bg-accent/50">
              <AppLogo name={providerNames[provider]} brandKey={provider} compact className="size-5! rounded-sm bg-transparent" />
              <div className="flex min-w-0 max-w-56 items-center gap-2">
                <span className="truncate font-medium" title={row.externalLabel}>{row.externalLabel}</span>
                {row.externalUrl && <a href={row.externalUrl} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline">{t("chatUi.externallyConnectedTaskBanner.open", { value0: providerNames[provider] })}<ExternalLink className="size-3" /></a>}
              </div>
              <span aria-hidden="true" className="text-muted-foreground">·</span>
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <span className="truncate" title={row.issueTitle ?? undefined}>{row.issueTitle ?? t("chatUi.chatEndpointDetail.waitingForTask")}</span>
                {row.issueId && <Link to={`/issues/${row.issueId}`} className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline">{t("pages.pipelines.openTask")}<ExternalLink className="size-3" /></Link>}
              </div>
              <span className="hidden shrink-0 text-xs text-muted-foreground xl:inline">{row.issueIdentifier}</span>
              {row.state !== "active" && <StatusBadge status={row.state} />}
            </li>
          ))}
        </ul>
      )}
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
  useTranslation();
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
        title: t(item.kind === "publication" ? "chatUi.publicationQueuedForReplay" : "chatUi.deliveryQueuedForReplay"),
        tone: "success",
      });
    },
    onError: (error) =>
      pushToast({
        title: t("chatUi.chatEndpointDetail.couldnTReplayActivity"),
        body: error instanceof Error ? error.message : t("localizationConnections.tryAgain227"),
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
            ? t("chatUi.chatEndpointDetail.taskStartRetried")
            : input.item.actionType === "slash_task_start"
              ? t("chatUi.chatEndpointDetail.taskStartCancelled")
              : input.item.actionType === "provider_effect" &&
                  input.action === "mark_delivered"
                ? t("chatUi.chatEndpointDetail.providerReplyMarkedDelivered")
                : input.item.actionType === "provider_effect" &&
                    input.action === "retry_anyway"
                  ? t("chatUi.chatEndpointDetail.providerReplyRetried")
                  : input.item.actionType === "provider_effect"
                    ? t("chatUi.chatEndpointDetail.providerReplyCancelled")
                    : input.action === "mark_delivered"
                      ? t("chatUi.chatEndpointDetail.publicationMarkedDelivered")
                      : input.action === "retry_anyway"
                        ? t("chatUi.chatEndpointDetail.publicationQueuedForRetry")
                        : t("chatUi.chatEndpointDetail.publicationCancelled"),
        tone: "success",
      });
    },
    onError: (error) =>
      pushToast({
        title: t("chatUi.chatEndpointDetail.couldnTResolveActivity"),
        body: error instanceof Error ? error.message : t("localizationConnections.tryAgain227"),
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
        title: action === "pause" ? t("chatUi.chatEndpointDetail.connectionPaused") : t("chatUi.chatEndpointDetail.connectionResumed"),
        tone: "success",
      });
    },
    onError: (error) =>
      pushToast({
        title: t("chatUi.chatEndpointDetail.couldnTUpdateConnection"),
        body: error instanceof Error ? error.message : t("localizationConnections.tryAgain227"),
        tone: "error",
      }),
  });
  const rows = query.data?.items ?? [];
  const { status } = endpoint;
  const health = connectionHealthPresentation(endpoint);
  const lifecycleAction = lifecycle.variables;
  const callbackSurfaceRows = endpoint.setup?.callbackSurfaces
    ? ([
        [t("chatUi.chatEndpointDetail.eventsAPI"), endpoint.setup.callbackSurfaces.events],
        [t("chatUi.chatEndpointDetail.interactivity"), endpoint.setup.callbackSurfaces.interactivity],
        [t("chatUi.chatEndpointDetail.slashCommand"), endpoint.setup.callbackSurfaces.slashCommands],
      ] as const)
    : [];
  return (
    <section className="space-y-5">
      <h2 className="text-lg font-semibold">{t("chatUi.chatEndpointDetail.connectionActivity")}</h2>
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
                <span className="font-medium">{t("chatUi.chatEndpointDetail.lastReportedHealth")}</span>{" "}
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
          <span>{t("sep28Apps.copy289")}</span>
          <span className="flex items-center gap-2">
            {endpoint.setup?.callbacksNeedUpdate && <span className="text-xs text-(--status-task-blocked)">{t("sep28Apps.copy290")}</span>}
            <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
          </span>
        </summary>
        <div className="space-y-5 border-t border-border p-4">
      {endpoint.provider === "slack" && callbackSurfaceRows.length > 0 && (
        <div
          className="space-y-3 text-sm"
        >
          <p className="font-medium">{t("chatUi.chatEndpointDetail.slackCallbackHealth")}</p>
          <p className="text-xs text-muted-foreground">
            {endpoint.setup?.callbacksNeedUpdate
              ? t("chatUi.chatEndpointDetail.slackCallbackURLsNeedAnUpdateSaveTheCurrentApp")
              : t("chatUi.chatEndpointDetail.paperclipRecordsEachCallbackSurfaceIndependentlyAfterSlackSuccessfullyCalls")}
          </p>
          <div className="divide-y divide-border border-y border-border">
            {callbackSurfaceRows.map(([label, surface]) => (
              <div key={label} className="flex flex-wrap items-center justify-between gap-3 py-2">
                <p className="text-xs font-medium">{label}</p>
                <p className="text-xs text-muted-foreground">
                  {surface.status === "current"
                    ? t("localizationIssuePanels.ui_Current_1dw4k8q")
                    : surface.status === "stale"
                      ? t("chatUi.chatEndpointDetail.staleURL")
                      : t("chatUi.chatEndpointDetail.notObserved")}
                </p>
                {surface.observedAt && (
                  <p className="text-xs text-muted-foreground">{t("chatUi.chatEndpointDetail.lastObserved")}{" "}
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
                )}{t("localizationRoutines.pause")}</Button>
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
                )}{t("pages.agentDetail.resume")}</Button>
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
                  ? t("pages.apps.connect.install.finish")
                  : t("pages.apps.connections.reconnect")}
              </Button>
            )}
            <Button
              variant="ghost"
              className="text-destructive hover:text-destructive"
              disabled={lifecycle.isPending}
              onClick={() => setRemoveOpen(true)}
            >
              <Trash2 />{t("localizationApps.removeConnection91")}</Button>
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
        <h3 className="text-sm font-semibold">{t("pages.userProfile.recentActivity")}</h3>
        {endpoint.provider === "agentmail" && rows.some((item) => item.kind === "publication" && item.status === "delivery_unknown") && (
          <p className="text-sm text-muted-foreground">
            <Trans i18nKey="oct5Apps.reviewDelivery" components={{ task: <Link to={`/apps/chat/${endpointId}/conversations`} className="underline underline-offset-4" /> }} />
          </p>
        )}
        <div className="divide-y divide-border border-y border-border">
          {query.isLoading && (
            <div className="flex items-center gap-2 py-5 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />{t("chatUi.chatEndpointDetail.loadingActivity")}</div>
          )}
          {query.isError && (
            <div className="flex flex-wrap items-center justify-between gap-3 py-4">
              <p className="text-sm text-destructive" role="alert">{t("chatUi.chatEndpointDetail.connectionActivityCouldNotBeLoaded")}</p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => query.refetch()}
              >{t("localizationIssuePanels.ui_Try_again_982hh6")}</Button>
            </div>
          )}
          {!query.isLoading &&
            !query.isError &&
            rows.map((item) => (
              <div
                key={item.id}
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
                      {chatLabel(item.fileTransfer.phase)}
                    </p>
                  )}
                  {item.detail && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">
                        {activityDetailLabel(item)}:
                      </span>{" "}
                      {chatActivityDetail(item)}
                    </p>
                  )}
                </div>
                {endpoint.provider !== "agentmail" && isReplayEligible(item) && (
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={t(item.kind === "publication" ? "chatUi.replayFailedPublication" : "chatUi.replayFailedDelivery")}
                    disabled={replay.isPending}
                    onClick={() => replay.mutate(item)}
                  >
                    {replay.isPending && replay.variables?.id === item.id ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <RefreshCw />
                    )}{t("chatUi.chatEndpointDetail.replay")}</Button>
                )}
                {endpoint.provider !== "agentmail" && isResolutionEligible(item) && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setResolutionItem(item)}
                  >{t("localizationIssueAux.ui_Resolve_1qqbo5f")}</Button>
                )}
              </div>
            ))}
          {!query.isLoading && !query.isError && rows.length === 0 && (
            <p className="py-5 text-sm text-muted-foreground">{t("chatUi.chatEndpointDetail.noConnectionActivityYet")}</p>
          )}
        </div>
      </div>
      <nav aria-label={t("sep28Apps.copy291")} className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">{t("sep28Apps.pageNumber", { page: cursors.length })}</span>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={cursors.length === 1 || query.isFetching} onClick={() => setCursors((pages) => pages.slice(0, -1))}>{t("pages.pipelines.previous")}</Button>
          <Button size="sm" variant="outline" disabled={!query.data?.nextCursor || query.isFetching || query.isError} onClick={() => { if (query.data?.nextCursor) setCursors((pages) => [...pages, query.data.nextCursor!]); }}>{t("pages.pipelines.next")}</Button>
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
                ? t("chatUi.chatEndpointDetail.resolveUnconfirmedTaskStart")
                : resolutionItem?.actionType === "provider_effect"
                  ? t("chatUi.chatEndpointDetail.resolveUnconfirmedProviderReply")
                  : t("chatUi.chatEndpointDetail.resolveUnconfirmedDelivery")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {resolutionItem?.actionType === "slash_task_start"
                ? t("chatUi.chatEndpointDetail.paperclipLostConfirmationAfterAskingSlackToStartTheTask")
                : resolutionItem?.actionType === "provider_effect"
                  ? t("chatUi.chatEndpointDetail.paperclipLostConfirmationAfterSendingThisProviderReplyCheckThe")
                  : resolutionItem
                    ? activityResolutionDescription(resolutionItem)
                    : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="sm:flex-wrap">
            <AlertDialogCancel disabled={resolveActivity.isPending}>{t("chatUi.chatEndpointDetail.keepUnresolved")}</AlertDialogCancel>
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
                    ? t("chatUi.chatEndpointDetail.cancelTaskStart")
                    : resolutionItem.actionType === "provider_effect"
                      ? t("chatUi.chatEndpointDetail.cancelProviderReply")
                      : resolutionItem.fileTransfer
                        ? t("chatUi.chatEndpointDetail.cancelFileTransfer")
                        : t("chatUi.chatEndpointDetail.cancelPublication")}
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
                    ? t("chatUi.chatEndpointDetail.retryFileNotification")
                    : t("chatUi.chatEndpointDetail.retryAnyway")}
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
                >{t("chatUi.chatEndpointDetail.markDelivered")}</AlertDialogAction>
              )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("localizationApps.removeThisConnection")}</AlertDialogTitle>
            <AlertDialogDescription>{t("chatUi.chatEndpointDetail.willStopReceivingNewWorkFromExistingPaperclipTasksRemain", { value0: endpoint.assignedAgentName, value1: ` ${providerNames[endpoint.provider]}`, value2: providerLifecycleGuidance[endpoint.provider].remove })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("localizationCommonTail.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={lifecycle.isPending}
              onClick={() => lifecycle.mutate("remove")}
            >
              {lifecycle.isPending && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}{t("localizationApps.removeConnection91")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
