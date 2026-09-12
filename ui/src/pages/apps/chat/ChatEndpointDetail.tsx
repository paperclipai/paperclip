import { Trans } from "react-i18next";
import { t, useTranslation } from "@/i18n";
import { EmailEndpointSettings } from "./EmailEndpointSetup";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
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
import { PageTabBar } from "@/components/PageTabBar";
import { StatusBadge } from "@/components/StatusBadge";
import { Tabs } from "@/components/ui/tabs";
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

const tabs = ["settings", "access", "conversations", "activity"] as const;
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
  if (endpoint.provider === "agentmail") return <EmailEndpointSettings endpointId={endpoint.id} companyId={endpoint.companyId} />;
  const setupIncomplete =
    endpoint.setup?.step !== "complete" &&
    ["draft", "verifying", "attention", "revoked"].includes(endpoint.status);

  return (
    <div className="max-w-5xl space-y-6 pb-12">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold">{t("chatUi.chatEndpointDetail.in", { value0: endpoint.assignedAgentName, value1: providerNames[endpoint.provider] })}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {endpoint.providerAccountLabel ?? t("chatUi.chatEndpointDetail.chatConnection")}
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
          <StatusBadge status={endpoint.status} />
        </div>
      </header>
      <Tabs
        value={activeTab}
        onValueChange={(next) => navigate(`/apps/chat/${endpoint.id}/${next}`)}
      >
        <PageTabBar
          items={tabItems}
          value={activeTab}
          onValueChange={(next) =>
            navigate(`/apps/chat/${endpoint.id}/${next}`)
          }
          align="start"
        />
      </Tabs>
      {activeTab === "settings" && (
        <Settings endpointId={endpoint.id} endpoint={endpoint} />
      )}
      {activeTab === "access" && (
        <Access
          endpointId={endpoint.id}
          allowUnlinked={endpoint.allowUnlinkedPeople}
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
      {endpoint.provider === "slack" && endpoint.setup?.command && (
        <div className="space-y-2">
          <h2 className="text-lg font-semibold">{t("chatUi.chatEndpointDetail.slackCommand")}</h2>
          <div className="rounded-lg border border-border p-3 text-sm">
            <code>{endpoint.setup.command}</code>
            <p className="mt-2 text-muted-foreground"><Trans i18nKey="chatUi.chatEndpointDetail.startWorkWithInADirectMessageUseOrSlack" components={{ code0: <code>{endpoint.setup.command} investigate this</code>, code1: <code>{endpoint.setup.command} status</code>, code2: <code>{endpoint.setup.command} new</code>, code3: <code>{endpoint.setup.command} close</code>, code4: <code>/status</code> }} /></p>
          </div>
        </div>
      )}
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
        <p className="mt-1 text-sm text-muted-foreground">{t("chatUi.chatEndpointDetail.providerMembershipMakesADestinationAvailablePaperclipRespondsOnlyWhere")}</p>
      </div>
      <div className="space-y-2">
        <h3 className="text-sm font-semibold">{t("chatUi.chatEndpointDetail.destinations")}</h3>
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
}: {
  endpointId: string;
  allowUnlinked: boolean;
}) {
  useTranslation();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [confirmationUrl, setConfirmationUrl] = useState<string | null>(null);
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
        <p className="mt-1 text-sm text-muted-foreground">{t("chatUi.chatEndpointDetail.linkedIdentitiesActAsTheirCurrentPaperclipUserUnlinkedPeople")}</p>
      </div>
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
      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">{t("chatUi.chatEndpointDetail.noConversationsYetAddressTheAgentInAnEnabledDestination")}</p>
      ) : (
        <div className="divide-y divide-border border-y border-border">
          {rows.map((row) => (
            <div key={row.id} className="grid gap-3 py-4 md:grid-cols-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {row.externalLabel}
                </p>
                <p className="text-xs text-muted-foreground">
                  {providerNames[provider]}
                </p>
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {row.issueIdentifier ? `${row.issueIdentifier} · ` : ""}
                  {row.issueTitle ?? t("chatUi.chatEndpointDetail.waitingForTask")}
                </p>
                <StatusBadge status={row.state} />
              </div>
              <div className="flex flex-wrap items-center gap-2 md:justify-end">
                {row.externalUrl && (
                  <Button asChild size="sm" variant="outline">
                    <a href={row.externalUrl} target="_blank" rel="noreferrer"><Trans i18nKey="chatUi.externallyConnectedTaskBanner.open" values={{ value0: providerNames[provider] }} components={{ externallink1: <ExternalLink  /> }} /></a>
                  </Button>
                )}
                {row.issueId && (
                  <Button asChild size="sm" variant="outline">
                    <Link to={`/issues/${row.issueId}`}>{t("pages.pipelines.openTask")}</Link>
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
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
  const query = useQuery({
    queryKey: queryKeys.chatEndpoints.activity(endpointId),
    queryFn: () => chatEndpointsApi.listActivity(endpointId),
    ...liveChatQueryOptions,
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
    mutationFn: (action: "pause" | "resume" | "remove") =>
      chatEndpointsApi.setup(endpointId, { action }),
    onSuccess: async (next, action) => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.chatEndpoints.list(next.companyId),
      });
      if (action === "remove") {
        navigate("/apps");
        return;
      }
      queryClient.setQueryData(
        queryKeys.chatEndpoints.detail(endpointId),
        next,
      );
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
  const rows = query.data ?? [];
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
      {(health.message || health.error) && (
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
      {endpoint.provider === "slack" && callbackSurfaceRows.length > 0 && (
        <div
          className={`rounded-lg border p-3 text-sm ${endpoint.setup?.callbacksNeedUpdate ? "border-destructive/40 bg-destructive/5" : "border-border bg-muted/30"}`}
        >
          <p className="font-medium">{t("chatUi.chatEndpointDetail.slackCallbackHealth")}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {endpoint.setup?.callbacksNeedUpdate
              ? t("chatUi.chatEndpointDetail.slackCallbackURLsNeedAnUpdateSaveTheCurrentApp")
              : t("chatUi.chatEndpointDetail.paperclipRecordsEachCallbackSurfaceIndependentlyAfterSlackSuccessfullyCalls")}
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            {callbackSurfaceRows.map(([label, surface]) => (
              <div key={label} className="rounded-md border border-border p-2">
                <p className="text-xs font-medium">{label}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {surface.status === "current"
                    ? t("localizationIssuePanels.ui_Current_1dw4k8q")
                    : surface.status === "stale"
                      ? t("chatUi.chatEndpointDetail.staleURL")
                      : t("chatUi.chatEndpointDetail.notObserved")}
                </p>
                {surface.observedAt && (
                  <p className="mt-1 text-xs text-muted-foreground">{t("chatUi.chatEndpointDetail.lastObserved")}{" "}
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
        <div className="space-y-2 border-y border-border py-3">
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
                    `/apps/chat/connect?provider=${endpoint.provider}&purpose=chat&resume=${endpoint.id}${status === "draft" || status === "verifying" ? "" : "&reconnect=1"}`,
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
      <div className="space-y-2">
        <h3 className="text-sm font-semibold">{t("chatUi.chatEndpointDetail.deliveryAndPublicationHistory")}</h3>
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
                className="flex flex-wrap items-start gap-3 py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium text-muted-foreground">
                      {activityKindLabels[item.kind]}
                    </span>
                    <StatusBadge status={item.status} />
                    <time
                      dateTime={item.createdAt}
                      title={item.createdAt}
                      className="font-mono text-xs text-muted-foreground"
                    >
                      {formatDateTime(item.createdAt, { includeSeconds: true })}
                    </time>
                  </div>
                  <p className="mt-2 text-sm font-medium">{chatActivitySummary(item)}</p>
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
                {isReplayEligible(item) && (
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
                {isResolutionEligible(item) && (
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
