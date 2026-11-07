import { t as finalPagesT } from "@/i18n";
import { Trans } from "react-i18next";
import { useTranslation } from "@/i18n";
import { SpekoProviderSetup } from "@/components/voice/SpekoProviderSetup";
import { NativeVoiceConversation } from "@/components/voice/NativeVoiceConversation";
import { buildSlackAppManifest, defaultSlackAppConfiguration } from "@paperclipai/shared";
import { SlackAppDetails, SlackSetupAdvanced } from "./SlackAppDetails";
import { SlackSetup } from "./slack/SlackSetup";
import { isProvisionedSlackSetup, slackSetupState } from "./slack/setup-state";
import { slackConversationUrl } from "./slack/conversation-url";
import { useAccountIdentity } from "@/api/companies-query";
import { defaultSlackAppName } from "./slack-app-name";
import { GitHubChatSetup } from "./GitHubChatSetup";
import { GitHubAgentTrustWarning } from "@/components/GitHubAgentTrustWarning";
import { SetupWizardFooter } from "@/components/SetupWizard";
import { ChatSetupNavigation } from "@/components/chat/ChatSetupNavigation";
import { SlackIdentityStep } from "./SlackIdentityStep";
import { PhotonConnectStep } from "./PhotonConnectStep";
import { EmailEndpointSetup } from "./EmailEndpointSetup";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useQueryView } from "@/components/QueryView";
import { AlertTriangle, CheckCircle2, Copy, CircleHelp, ExternalLink, Eye, EyeOff, Hammer, Loader2 } from "lucide-react";
import { AgentAvatar } from "@/components/AgentAvatar";
import { AgentCharacter } from "@/components/AgentCharacter";
import { AgentSelect } from "@/components/AgentMultiSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Textarea } from "@/components/ui/textarea";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";
import { agentsApi } from "@/api/agents";
import { instanceSettingsApi } from "@/api/instanceSettings";
import {
  chatEndpointsApi,
  type ChatEndpoint,
  type ChatProvider,
  type ChatEndpointSetupAction,
} from "@/api/chatEndpoints";
import { useNavigate, useSearchParams } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { copyTextToClipboard } from "@/lib/clipboard";
import { useCopyAction } from "@/lib/use-copy-action";
import { isAgentStatusInvokable, slackAppConfigurationSchema, type SlackAppConfiguration } from "@paperclipai/shared";
import { sanitizedSetupErrorMessage } from "./chat-setup-error";
import {
  createGitHubPrivateKeyReadGuard,
  readGitHubPrivateKeyFile,
} from "./github-private-key-file";
import { describeError } from "@/api/errors";

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

const knownProviders = new Set(Object.keys(providerNames));

function isProvider(value: string | null): value is ChatProvider {
  return value !== null && knownProviders.has(value);
}

function publicOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function isChatEndpointRepairing(
  endpoint: Pick<
    ChatEndpoint,
    "provider" | "status" | "providerAccountId" | "botExternalId"
  > | null,
  resumeEndpointId: string | null,
  reconnectRequested: boolean,
): boolean {
  if (!resumeEndpointId || !endpoint) return false;
  const recoveringStatus =
    endpoint.status === "attention" || endpoint.status === "revoked";
  // A secret-only GitHub draft affected by setup trouble has no App identity
  // or reusable App credentials. It must remain first-time setup, where App ID
  // and private key are required, rather than offering a misleading reconnect.
  if (
    endpoint.provider === "github" &&
    recoveringStatus &&
    !endpoint.providerAccountId &&
    !endpoint.botExternalId
  ) {
    return false;
  }
  return (
    recoveringStatus ||
    (reconnectRequested &&
      (endpoint.status === "active" || endpoint.status === "paused"))
  );
}

export function ChatConnectionPurpose({ provider, onChat, onTools, slackLabels }: {
  provider: ChatProvider;
  onChat: () => void;
  onTools: () => void;
  slackLabels?: string[];
}) {
  const { t } = useTranslation("connections");
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => {
    setBreadcrumbs([{ label: t("connectors_4b1e950"), href: "/apps" }, { label: t("choose_connection_3bfec13") }]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs, t]);
  return (
      <div className="max-w-2xl space-y-6">
        <ChatSetupNavigation labels={provider === "slack" ? slackLabels ?? ["Choose agent", "Connect"] : undefined} step={0} availableStep={0} onSelect={onChat} />
        <div>
          <h1 className="text-xl font-bold">{t("choose_how_to_connect_e00fc6c")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("what_should_this_connection_do_bd9766d", { value: providerNames[provider] })}</p>
        </div>
        <div className="grid gap-3">
          <button
            type="button"
            className="flex items-center gap-4 rounded-xl border border-border p-4 text-left hover:bg-accent/40"
            onClick={onChat}
          >
            <AgentAvatar size={48} />
            <span>
              <span className="block text-sm font-semibold">{t("chat_with_an_agent_7dd4310")}</span>
              <span className="mt-1 block text-sm text-muted-foreground">{t("people_in_can_start_and_continue_paperclip_3c37b9b", { value: providerNames[provider] })}</span>
            </span>
          </button>
          <button
            type="button"
            className="flex items-center gap-4 rounded-xl border border-border p-4 text-left hover:bg-accent/40"
            onClick={onTools}
          >
            <span className="flex size-12 shrink-0 items-center justify-center text-muted-foreground" aria-hidden="true">
              <Hammer className="size-8" />
            </span>
            <span>
              <span className="block text-sm font-semibold">{t("use_this_connection_as_an_agent_tool_45d42c5")}</span>
              <span className="mt-1 block text-sm text-muted-foreground">{t("let_agents_use_actions_and_data_while_9384479", { value: providerNames[provider] })}</span>
            </span>
          </button>
        </div>
      </div>
  );
}

export function ChatEndpointSetup() {
  const [params] = useSearchParams();
  if (params.get("provider") === "github") return <GitHubChatSetup />;
  return params.get("provider") === "agentmail" ? <EmailEndpointSetup /> : <ChatSdkEndpointSetup />;
}

function ChatSdkEndpointSetup() {
  const { t } = useTranslation("connections");
  const { userId, settled: identitySettled } = useAccountIdentity();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const provider = isProvider(params.get("provider"))
    ? (params.get("provider") as ChatProvider)
    : null;
  const toolHref = params.get("toolHref") || "/apps";
  const preselectedAgent = params.get("agentId") ?? "";
  const resumeEndpointId = params.get("resume") ?? "";
  const reconnectRequested = params.get("reconnect") === "1";
  const [purpose, setPurpose] = useState<"choice" | "chat">(
    params.get("purpose") === "chat" ? "chat" : "choice",
  );
  const [agentId, setAgentId] = useState(preselectedAgent);
  const [slackCredentialsReady, setSlackCredentialsReady] = useState(params.get("stage") === "credentials");
  const [viewedStep, setViewedStep] = useState<number | null>(null);
  const [slackIdentityReady, setSlackIdentityReady] = useState(false);
  const [automaticBusy, setAutomaticBusy] = useState(false);
  const [managedAutoStart, setManagedAutoStart] = useState(Boolean(resumeEndpointId));
  const [slackDraft, setSlackDraft] = useState<{ agentId: string; app: SlackAppConfiguration } | null>(null);
  const [endpoint, setEndpoint] = useState<ChatEndpoint | null>(null);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [generatedWebhookSecret, setGeneratedWebhookSecret] = useState("");
  const [setupError, setSetupError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: t("connectors_4b1e950"), href: "/apps" },
      { label: t("connect_chat_fab2e5f") },
    ]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs, t]);

  const agentsQuery = useQuery({
    queryKey: ["chat-endpoint-setup-agents", selectedCompanyId],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const resumeQuery = useQuery({
    queryKey: ["chat-endpoint-setup-resume", resumeEndpointId],
    queryFn: () => chatEndpointsApi.get(resumeEndpointId),
    enabled: Boolean(resumeEndpointId),
    refetchInterval: query => ["creating", "install", "credentials_saved"].includes(query.state.data?.setup?.slackRegistration?.status ?? "") ? 1_500 : false,
  });
  useEffect(() => {
    if (!resumeQuery.data) return;
    setEndpoint(current => {
      if (isProvisionedSlackSetup(current?.setup?.slackSetupMethod) && !current?.providerAccountId && resumeQuery.data.providerAccountId) setViewedStep(null);
      return resumeQuery.data;
    });
    setAgentId(resumeQuery.data.assignedAgentId);
    setPurpose("chat");
  }, [resumeQuery.data]);
  const githubVerificationQuery = useQuery({
    queryKey: ["chat-endpoint-github-webhook-verification", endpoint?.id],
    queryFn: () => chatEndpointsApi.get(endpoint!.id),
    enabled: Boolean(
      provider === "github" &&
      endpoint?.id &&
      endpoint.setup?.step === "provider_setup" &&
      endpoint.setup?.webhookSecretConfigured &&
      !endpoint.setup.webhookVerifiedAt,
    ),
    refetchInterval: 1_500,
  });
  useEffect(() => {
    if (
      !githubVerificationQuery.data ||
      provider !== "github" ||
      !endpoint ||
      endpoint.id !== githubVerificationQuery.data.id ||
      endpoint.setup?.step !== "provider_setup" ||
      !endpoint.setup?.webhookSecretConfigured ||
      endpoint.setup.webhookVerifiedAt
    )
      return;
    setEndpoint(githubVerificationQuery.data);
  }, [endpoint, githubVerificationQuery.data, provider]);
  const experimentalSettingsQuery = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
    enabled: endpoint?.setup?.step === "test",
  });
  const experimentalSettingsView = useQueryView(experimentalSettingsQuery);
  const activeAgents = useMemo(
    () =>
      (agentsQuery.data ?? []).filter((agent) =>
        isAgentStatusInvokable(agent.status),
      ),
    [agentsQuery.data, t],
  );
  const selectedAgent = agentsQuery.data?.find(agent => agent.id === agentId);
  const slackDetails = slackDraft?.agentId === agentId ? slackDraft.app
    : endpoint?.setup?.slackApp ?? defaultSlackAppConfiguration(selectedAgent?.name ?? endpoint?.assignedAgentName ?? "");
  const slackDetailsValidation = slackAppConfigurationSchema.safeParse(slackDetails);
  const slackDetailsEditable = !automaticBusy && (!endpoint || endpoint.status === "draft" && !endpoint.botExternalId
    && (!endpoint.setup?.slackRegistration || endpoint.setup.slackRegistration.status === "failed"));
  const syncEndpointSnapshot = (
    next: ChatEndpoint,
    onlyIfStillVisible = false,
  ) => {
    if (next.setup?.slackSetupMethod === "managed" && endpoint && endpoint.setup?.slackSetupMethod !== "managed") setManagedAutoStart(true);
    if (isProvisionedSlackSetup(next.setup?.slackSetupMethod) && next.setup?.slackRegistration?.status === "configured"
      && endpoint?.setup?.slackRegistration?.status !== "configured") setViewedStep(null);
    setEndpoint((visible) =>
      onlyIfStillVisible && visible?.id !== next.id ? visible : next,
    );
    queryClient.setQueryData(["chat-endpoint-setup-resume", next.id], next);
    queryClient.setQueryData(queryKeys.chatEndpoints.detail(next.id), next);
    if (next.provider === "github") {
      queryClient.setQueryData(
        ["chat-endpoint-github-webhook-verification", next.id],
        next,
      );
    }
  };
  const slackChoices = useQuery({
    queryKey: ["slack-setup-options", selectedCompanyId],
    queryFn: () => chatEndpointsApi.slackSetupOptions(selectedCompanyId!),
    enabled: provider === "slack" && Boolean(selectedCompanyId),
    });
  const slackChoicesView = useQueryView(slackChoices);
  const createEndpoint = useMutation({
    mutationFn: ({ ownApp = false }: { ownApp?: boolean; exit?: boolean }) => {
      if (provider === "slack" && !slackChoices.data) throw new Error(t("slack_setup_is_still_loading_try_again_ef0a365"));
      return chatEndpointsApi.create(selectedCompanyId!, {
        provider: provider!,
        assignedAgentId: agentId,
        ...(provider === "slack" ? { slackSetupMethod: ownApp ? "automatic" : slackChoices.data!.defaultMethod, slackApp: slackDetailsValidation.success ? slackDetailsValidation.data : slackDetails } : {}),
      });
    },
    onSuccess: (next, { exit }) => {
      setManagedAutoStart(!exit);
      setViewedStep(exit ? 0 : null);
      syncEndpointSnapshot(next);
      if (next.provider === "imessage-photon" || next.provider === "slack" || next.provider === "speko") {
        const resumed = new URLSearchParams(params);
        resumed.set("resume", next.id);
        setParams(resumed, { replace: true });
      }
      if (exit) navigate("/apps");
    },
    onError: (error) =>
      pushToast({
        title: t("couldn_t_start_setup_d870c74"),
        body: describeError(error).body,
        tone: "error",
      }),
  });
  const saveSlackDetails = useMutation({
    scope: { id: `slack-app-details:${endpoint?.id}` },
    mutationFn: (details: SlackAppConfiguration) => chatEndpointsApi.update(endpoint!.id, { slackApp: details }),
    onSuccess: next => syncEndpointSnapshot(next),
  });
  const persistSlackDetails = async () => {
    if (endpoint && slackDetailsEditable && slackDetailsValidation.success
      && JSON.stringify(slackDetailsValidation.data) !== JSON.stringify(endpoint.setup?.slackApp))
      await saveSlackDetails.mutateAsync(slackDetailsValidation.data);
  };
  const continueFromAgent = async (exit: boolean) => {
    if (exit && provider !== "slack") { navigate("/apps"); return; }
    if (!endpoint) {
      if (!agentId) { if (exit) navigate("/apps"); return; }
      createEndpoint.mutate({ exit });
      return;
    }
    try { if (provider === "slack") await persistSlackDetails(); }
    catch { return; }
    if (exit) navigate("/apps"); else { setManagedAutoStart(true); setViewedStep(null); }
  };
  const useOwnSlackApp = useMutation({
    mutationFn: async () => {
      if (!endpoint) return createEndpoint.mutateAsync({ ownApp: true });
      await persistSlackDetails();
      return chatEndpointsApi.update(endpoint.id, { slackSetupMethod: "automatic" });
    },
    onSuccess: next => { setManagedAutoStart(false); syncEndpointSnapshot(next); setViewedStep(1); },
    onError: () => pushToast({ title: t("couldn_t_switch_slack_setup_2d5dfed"), body: t("try_again_624fb21"), tone: "error" }),
  });
  const setupAction = useMutation({
    mutationFn: async ({
      action,
      values,
    }: {
      action: ChatEndpointSetupAction;
      values?: Record<string, string>;
    }) => {
      const endpointId = endpoint!.id;
      try {
        return await chatEndpointsApi.setup(endpointId, provider === "imessage-photon" ? {
      action,
      ...(values?.projectSecret ? { credentials: { projectSecret: values.projectSecret } } : {}),
      ...(values?.projectId && values.allocation === "shared" ? { photon: { allocation: "shared" as const, projectId: values.projectId } } : values?.projectId && values?.lineId ? { photon: { allocation: "dedicated" as const, projectId: values.projectId, lineId: values.lineId } } : {}),
        } : { action, credentials: values });
      } catch (error) {
        // Another open tab may have completed verification, or the successful
        // response may have been lost. Read the canonical state before retrying.
        if (action === "verify") {
          const current = await chatEndpointsApi.get(endpointId).catch(() => null);
          if (current?.setup?.step === "test" || current?.setup?.step === "complete") return current;
        }
        throw error;
      }
    },
    onMutate: () => setSetupError(null),
    onSuccess: (next) => {
      setSetupError(null);
      setViewedStep(null);
      syncEndpointSnapshot(next);
      setCredentials({});
      if (next.setup?.step !== "test" && next.setup?.step !== "complete") setSlackIdentityReady(false);
    },
    onError: (error, variables) =>
      setSetupError(sanitizedSetupErrorMessage(error, variables.values)),
  });
  const generateSetupSecret = useMutation({
    mutationFn: () => chatEndpointsApi.generateSetupSecret(endpoint!.id),
    onMutate: async () => {
      const endpointId = endpoint!.id;
      await Promise.all([
        queryClient.cancelQueries({
          queryKey: ["chat-endpoint-github-webhook-verification", endpointId],
          exact: true,
        }),
        queryClient.cancelQueries({
          queryKey: ["chat-endpoint-setup-resume", endpointId],
          exact: true,
        }),
        queryClient.cancelQueries({
          queryKey: queryKeys.chatEndpoints.detail(endpointId),
          exact: true,
        }),
      ]);
      return { endpointId };
    },
    onSuccess: async ({ webhookSecret }, _variables, context) => {
      const endpointId = context.endpointId;
      const markRotated = (current: ChatEndpoint) => ({
        ...current,
        setup: {
          ...current.setup,
          step: "provider_setup" as const,
          webhookSecretConfigured: true,
          webhookVerifiedAt: null,
        },
      });

      queryClient.removeQueries({
        queryKey: ["chat-endpoint-github-webhook-verification", endpointId],
        exact: true,
      });
      setGeneratedWebhookSecret(webhookSecret);
      setEndpoint((current) =>
        current && current.id === endpointId ? markRotated(current) : current,
      );
      queryClient.setQueryData<ChatEndpoint>(
        ["chat-endpoint-setup-resume", endpointId],
        (current) => (current ? markRotated(current) : current),
      );
      queryClient.setQueryData<ChatEndpoint>(
        queryKeys.chatEndpoints.detail(endpointId),
        (current) => (current ? markRotated(current) : current),
      );

      try {
        const current = await chatEndpointsApi.get(endpointId);
        syncEndpointSnapshot(current, true);
      } catch {
        // Keep the one-time secret copyable. Verification polling will retry the
        // canonical endpoint read without restoring a pre-rotation snapshot.
      }
    },
    onError: (error) =>
      pushToast({
        title: t("couldn_t_generate_webhook_secret_1d19973"),
        body: describeError(error).body,
        tone: "error",
      }),
  });
  const testConnection = useMutation({
    mutationFn: () => provider === "slack" ? chatEndpointsApi.finishSlackSetup(endpoint!.id) : chatEndpointsApi.test(endpoint!.id),
    onSuccess: (next) => {
      syncEndpointSnapshot(next);
      if (next.status === "active") navigate(`/apps/chat/${next.id}/settings`);
    },
    onError: (error) =>
      pushToast({
        title: provider === "slack" ? t("couldn_t_finish_setup_3b5e822") : t("test_not_complete_659dc79"),
        body: describeError(error).body,
        tone: "error",
      }),
  });
  const finishSetup = () => {
    if (provider === "slack" && endpoint?.setup?.step === "complete") {
      navigate(`/apps/chat/${endpoint.id}/settings`);
      return;
    }
    testConnection.mutate();
  };

  const repairing = isChatEndpointRepairing(
    endpoint,
    resumeEndpointId,
    reconnectRequested,
  );
  const isSlack = provider === "slack";
  const slackNavigation = slackSetupState({ endpoint, repairing, credentialsReady: slackCredentialsReady, identityReady: slackIdentityReady, defaultMethod: slackChoices.data?.defaultMethod });
  const automaticSlack = isSlack && slackNavigation.provisioned;
  const automaticSlackComplete = automaticSlack && slackNavigation.complete;
  const tryStep = isSlack ? slackNavigation.finalStage : 2;
  const availableStep = isSlack ? slackNavigation.availableStage : !endpoint ? 0
    : !repairing && (endpoint.setup?.step === "test" || endpoint.setup?.step === "complete") ? tryStep : 1;
  const step = Math.min(viewedStep ?? availableStep, availableStep);
  const agentStepBusy = automaticBusy || createEndpoint.isPending || saveSlackDetails.isPending || useOwnSlackApp.isPending;
  const slackVerificationQuery = useQuery({
    queryKey: ["chat-endpoint-slack-webhook-verification", endpoint?.id],
    queryFn: () => chatEndpointsApi.get(endpoint!.id),
    enabled: Boolean(isSlack && step === 3 && endpoint?.setup?.step === "provider_setup" &&
      !endpoint.setup.webhookVerifiedAt && !setupAction.isPending),
    refetchInterval: 1_500,
  });
  const slackVerificationView = useQueryView(slackVerificationQuery);
  useEffect(() => {
    const next = slackVerificationQuery.data;
    if (!next || !endpoint || next.id !== endpoint.id || setupAction.isPending ||
      endpoint.setup?.step !== "provider_setup" || endpoint.setup.webhookVerifiedAt ||
      !next.setup?.webhookVerifiedAt) return;
    setEndpoint(next);
  }, [slackVerificationQuery.data, endpoint, setupAction.isPending]);
  const autoVerificationAttempt = useRef<string | null>(null);
  useEffect(() => {
    if (!isSlack || step !== 3 || endpoint?.setup?.step !== "provider_setup" ||
      !endpoint.setup.webhookVerifiedAt || setupAction.isPending) return;
    const attempt = `${endpoint.id}:${endpoint.setup.webhookVerifiedAt}`;
    if (autoVerificationAttempt.current === attempt) return;
    autoVerificationAttempt.current = attempt;
    setupAction.mutate({ action: "verify" });
  }, [isSlack, step, endpoint, setupAction]);

  if (!provider)
    return (
      <p className="text-sm text-destructive">{t("this_chat_provider_is_not_supported_0dad735")}</p>
    );
  if (!selectedCompanyId)
    return (
      <p className="text-sm text-muted-foreground">{t("select_an_organization_to_connect_chat_b123e6c")}</p>
    );

  if (purpose === "choice" && provider !== "speko") {
    return <ChatConnectionPurpose provider={provider} slackLabels={slackNavigation.labels} onChat={() => setPurpose("chat")} onTools={() => navigate(toolHref)} />;
  }

  return (
    <div className={automaticSlackComplete && step === tryStep ? "mx-auto w-full max-w-2xl space-y-6" : "max-w-2xl space-y-6"}>
      <ChatSetupNavigation
        labels={isSlack ? slackNavigation.labels : undefined}
        step={isSlack ? slackNavigation.toVisible(step) : step}
        availableStep={isSlack ? slackNavigation.toVisible(availableStep) : availableStep}
        disabled={agentStepBusy || setupAction.isPending || generateSetupSecret.isPending || testConnection.isPending}
        onSelect={value => setViewedStep(isSlack ? slackNavigation.toStage(value) : value)}
      />
      <div className="min-w-0 space-y-6">
        {step === 0 ? (
          <>
            <div>
              <h1 className="text-xl font-bold">{t("which_agent_do_you_want_to_chat_94a5481")}</h1>
              <p className="mt-1 text-sm text-muted-foreground">{t("this_agent_is_permanent_for_the_connection_7481236")}</p>
            </div>
            {endpoint ? (
              <Input aria-label={t("assigned_agent_ab58583")} value={endpoint.assignedAgentName ?? selectedAgent?.name ?? agentId} readOnly />
            ) : <AgentSelect
              agents={activeAgents}
              value={agentId}
              onChange={setAgentId}
              placeholder={t("choose_an_active_agent_47d10ed")}
              emptyMessage={t("no_active_agents_are_available_ede5b31")}
            />}
            {isSlack && (selectedAgent || endpoint) && <SlackSetupAdvanced>
              <SlackAppDetails value={slackDetails} readOnly={!slackDetailsEditable || agentStepBusy}
                onChange={app => setSlackDraft({ agentId, app })}
                onBlur={() => void persistSlackDetails().catch(() => {})} />
              {saveSlackDetails.error && <p role="alert" className="text-sm text-destructive">{t("couldn_t_save_the_slack_app_details_da79367")}</p>}
              {slackChoices.data?.defaultMethod === "managed" && (!endpoint || endpoint.setup?.slackSetupMethod === "managed") && !endpoint?.setup?.slackRegistration && <Button
                variant="link" className="h-auto p-0 text-muted-foreground"
                disabled={agentStepBusy || !slackDetailsValidation.success}
                onClick={() => useOwnSlackApp.mutate()}
              >{t("use_your_own_app_20b8b3d")}</Button>}
            </SlackSetupAdvanced>}
            {isSlack && !endpoint && !slackChoices.data && ((slackChoicesView.kind === "error")
              ? <div role="alert" className="text-sm text-destructive">{t("couldn_t_load_slack_setup_83b588d")}<Button variant="link" disabled={slackChoices.isFetching} onClick={() => void slackChoices.refetch()}>{t("retry_9f5cd8a")}</Button></div>
              : <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("loading_slack_d9c128d")}</p>)}
            {provider === "github" && <GitHubAgentTrustWarning agent={selectedAgent} />}
            <SetupWizardFooter disabled={agentStepBusy || isSlack && !endpoint && Boolean(agentId) && !slackChoices.data} onSaveExit={() => void continueFromAgent(true)}>
              <Button
                disabled={!agentId || agentStepBusy || isSlack && (!slackDetailsValidation.success || !endpoint && !slackChoices.data)}
                onClick={() => void continueFromAgent(false)}
              >
                {createEndpoint.isPending && (
                  <Loader2 className="h-4 w-4 animate-spin" />
                )}{t("continue_4f5e94c")}</Button>
            </SetupWizardFooter>
          </>
        ) : null}
        {endpoint && !(automaticSlackComplete && step === tryStep) && (
          <div hidden={step !== 1 && !(isSlack && (step === 2 || step === 3))} className="space-y-6">
            {setupError ? (
              <div
                role="alert"
                className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive"
              >
                <p className="font-medium">{t("connection_failed_202caaa")}</p>
                <p className="mt-1">{setupError}</p>
              </div>
            ) : null}
            <ProviderConnectStep
              key={`${provider}:${endpoint.id}`}
              provider={provider}
              managedAutoStart={managedAutoStart && step !== 0}
              slackStage={step === 1 ? "app" : step === 3 ? "finish" : "credentials"}
              onSlackCredentialsContinue={() => setViewedStep(3)}
              onSlackVerificationContinue={() => setViewedStep(4)}
              slackVerificationError={slackVerificationView.kind === "error"}
              onSlackAppCreated={() => {
                setSlackCredentialsReady(true);
                setViewedStep(2);
                const resumed = new URLSearchParams(params);
                resumed.set("resume", endpoint.id);
                resumed.set("stage", "credentials");
                setParams(resumed, { replace: true });
              }}
              agentName={selectedAgent?.name ?? endpoint.assignedAgentName}
              endpoint={endpoint}
              onEndpointSaved={syncEndpointSnapshot}
              credentials={credentials}
              setCredentials={setCredentials}
              repairing={repairing}
              pending={setupAction.isPending}
              onAutomaticBusy={setAutomaticBusy}
              generatedWebhookSecret={generatedWebhookSecret}
              generatingSetupSecret={generateSetupSecret.isPending}
              onGenerateSetupSecret={() => generateSetupSecret.mutate()}
              onAction={(action, values) =>
                setupAction.mutate({ action, values })
              }
            />
          </div>
        )}
        {endpoint && isSlack && !automaticSlack && step === 4 && (
          <SlackIdentityStep
            endpointId={endpoint.id}
            command={endpoint.setup?.slackApp?.command ?? endpoint.setup?.command ?? "/paperclip"}
            testStartedAt={endpoint.setup?.testStartedAt}
            onSaveExit={() => navigate("/apps")}
            onConnected={() => {
              setSlackIdentityReady(true);
              setViewedStep(5);
            }}
          />
        )}
        {endpoint && step === tryStep && provider === "speko" && (
          <div className="space-y-5">
            <h1 className="text-xl font-bold">{t("test_your_speko_voice_connection_94f7d42")}</h1>
            <p className="text-sm text-muted-foreground">{t("ask_the_agent_to_do_some_work_151cb3e")}</p>
            <NativeVoiceConversation companyId={endpoint.companyId} endpointId={endpoint.id} agentName={selectedAgent?.name ?? endpoint.assignedAgentName} />
            <SetupWizardFooter onSaveExit={() => navigate("/apps")}><Button disabled={testConnection.isPending} onClick={() => testConnection.mutate()}>{t("verify_test_conversation_e2603d6")}</Button></SetupWizardFooter>
          </div>
        )}
        {endpoint && step === tryStep && provider !== "speko" && (!automaticSlack || automaticSlackComplete) && (
          automaticSlack ? <div className="flex flex-col items-center gap-6 py-8 text-center">
            <AgentCharacter
              agent={selectedAgent ?? { id: endpoint.assignedAgentId, name: endpoint.assignedAgentName }}
              size={256} state="success" trackingScope="page"
              label={t("avatar_a20132e", { value: selectedAgent?.name ?? endpoint.assignedAgentName })}
            />
            <div className="flex flex-col items-center gap-3">
              <h1 className="flex items-center gap-2 text-2xl font-bold">
                <CheckCircle2 aria-hidden="true" className="size-6 text-(--status-task-done)" />{t("success_8cc35f8")}</h1>
              <p className="flex flex-wrap items-center justify-center gap-2 text-base text-muted-foreground">
                <span>{t("you_can_now_talk_to_in_slack_59e3bef", { value: selectedAgent?.name ?? endpoint.assignedAgentName })}</span>
                <img src="/brands/apps/slack.svg" alt="" aria-hidden="true" className="size-6" />
              </p>
              <Button asChild variant="link"><a href={slackConversationUrl(endpoint, identitySettled ? userId : null)} target="_blank" rel="noopener noreferrer">{t("open_slack_8245d1b")}<ExternalLink className="size-4" /></a></Button>
            </div>
            <Button disabled={testConnection.isPending} onClick={finishSetup}>
              {testConnection.isPending && <Loader2 className="size-4 animate-spin" />}{t("done_d588886")}</Button>
          </div> : <TryStep
            endpointId={endpoint.id}
            provider={provider}
            agentName={selectedAgent?.name ?? endpoint.assignedAgentName}
            botLabel={endpoint.botLabel}
            botUsername={endpoint.botUsername}
            slackAccount={endpoint.setup?.slackAccount}
            photonAllocation={endpoint.photonAllocation}
            providerUrl={endpoint.setup?.slackAccount?.dmChannelId && endpoint.providerAccountId ? `https://app.slack.com/client/${encodeURIComponent(endpoint.providerAccountId)}/${encodeURIComponent(endpoint.setup.slackAccount.dmChannelId)}` : endpoint.setup?.providerUrl}
            guestIsolationState={
              experimentalSettingsQuery.isPending || experimentalSettingsView.kind === "reconnecting"
                ? "loading"
                : experimentalSettingsView.kind === "error"
                  ? "unknown"
                  : experimentalSettingsQuery.data?.enableIsolatedWorkspaces ===
                      true
                    ? "enabled"
                    : "disabled"
            }
            pending={testConnection.isPending}
            onOpenAccess={() => navigate(`/apps/chat/${endpoint.id}/access`)}
            onTest={finishSetup}
            onSaveExit={() => navigate("/apps")}
          />
        )}
        {step !== 0 && !isSlack && provider !== "speko" && <div className="flex justify-start">
          <Button className="text-muted-foreground" variant="ghost" onClick={() => navigate("/apps")}>{t("save_exit_ea61678")}</Button>
        </div>}
      </div>
    </div>
  );
}

function ProviderConnectStep({
  provider,
  slackStage,
  onSlackCredentialsContinue,
  onSlackVerificationContinue,
  slackVerificationError,
  onSlackAppCreated,
  agentName,
  endpoint,
  credentials,
  setCredentials,
  repairing,
  pending,
  onAutomaticBusy,
  managedAutoStart = false,
  onEndpointSaved,
  generatedWebhookSecret,
  generatingSetupSecret,
  onGenerateSetupSecret,
  onAction,
}: {
  provider: ChatProvider;
  slackStage: "app" | "credentials" | "finish";
  onSlackCredentialsContinue: () => void;
  onSlackVerificationContinue: () => void;
  slackVerificationError: boolean;
  onSlackAppCreated: () => void;
  agentName: string;
  endpoint: ChatEndpoint;
  credentials: Record<string, string>;
  setCredentials: Dispatch<SetStateAction<Record<string, string>>>;
  repairing: boolean;
  pending: boolean;
  managedAutoStart?: boolean;
  onAutomaticBusy: (busy: boolean) => void;
  onEndpointSaved: (endpoint: ChatEndpoint) => void;
  generatedWebhookSecret: string;
  generatingSetupSecret: boolean;
  onGenerateSetupSecret: () => void;
  onAction: (
    action: ChatEndpointSetupAction,
    values?: Record<string, string>,
  ) => void;
}) {
  const { t } = useTranslation("connections");
  const { userId, settled: identitySettled } = useAccountIdentity();
  const { pushToast } = useToast();
  const navigate = useNavigate();
  const slackBotToken = (credentials.botToken ?? "").trim();
  const slackBotTokenInvalid = provider === "slack" && slackBotToken.length > 0 &&
    !slackBotToken.startsWith("xoxb-");
  const slackSigningSecretHasTokenPrefix = provider === "slack" &&
    /^x[a-z0-9]*-/i.test((credentials.signingSecret ?? "").trim());
  const slackCredentialsSaved = provider === "slack" && Boolean(endpoint.providerAccountId);
  const continueWithSavedSlackCredentials = slackCredentialsSaved && !repairing &&
    !slackBotToken && !credentials.signingSecret?.trim();
  const reportCopyFailure = () =>
    pushToast({
      title: t("couldn_t_copy_to_clipboard_ffaecaf"),
      body: t("select_and_copy_the_value_manually_07ec3cf"),
      tone: "error",
    });
  const field = (key: string, label: string, type = "password") => (
    <label className="grid gap-2 text-sm font-medium">
      {label}
      <Input
        type={type}
        value={credentials[key] ?? ""}
        onChange={(event) =>
          setCredentials({ ...credentials, [key]: event.target.value })
        }
      />
    </label>
  );
  const openProviderSetup = (fallback: string) =>
    window.open(
      endpoint.setup?.authorizationUrl ??
        endpoint.setup?.providerUrl ??
        fallback,
      "_blank",
      "noopener,noreferrer",
    );
  const endpointValue = (label: string, value: string | null | undefined) => (
    <div className="grid gap-2">
      <p className="text-sm font-medium">{label}</p>
      <div className="rounded-lg border border-border bg-muted p-3 font-mono text-xs break-all">
        {value ??
          t("this_endpoint_is_unavailable_check_the_server_b6962e4")}
      </div>
    </div>
  );
  const [manifestCopied, setManifestCopied] = useState(false);
  // A hook rather than a sticky boolean: this step stays mounted when the
  // secret is regenerated, so a latched "copied" would keep vouching for a
  // value the reader never copied. The status resets itself, and a refused
  // clipboard reads as a failure instead of a success.
  const webhookSecretCopy = useCopyAction();
  const [openingSlackApp, setOpeningSlackApp] = useState(false);
  const slackAdvanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    setOpeningSlackApp(false);
    return () => {
      if (slackAdvanceTimer.current !== null) {
        clearTimeout(slackAdvanceTimer.current);
        slackAdvanceTimer.current = null;
      }
    };
  }, [slackStage]);
  const [privateKeyVisible, setPrivateKeyVisible] = useState(false);
  const [privateKeyFileError, setPrivateKeyFileError] = useState<string | null>(
    null,
  );
  const [privateKeyFileLoaded, setPrivateKeyFileLoaded] = useState(false);
  const [privateKeyFileLoading, setPrivateKeyFileLoading] = useState(false);
  const privateKeyFileInputRef = useRef<HTMLInputElement>(null);
  const privateKeyReadGuard = useRef(createGitHubPrivateKeyReadGuard()).current;
  useEffect(
    () => () => {
      privateKeyReadGuard.invalidate();
    },
    [privateKeyReadGuard],
  );
  const loadPrivateKeyFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    const readRevision = privateKeyReadGuard.start();
    setPrivateKeyFileError(null);
    setPrivateKeyFileLoaded(false);
    setPrivateKeyFileLoading(true);
    try {
      const privateKey = await readGitHubPrivateKeyFile(file);
      if (!privateKeyReadGuard.isCurrent(readRevision)) return;
      setCredentials((current) => ({ ...current, privateKey }));
      setPrivateKeyVisible(false);
      setPrivateKeyFileLoaded(true);
    } catch (error) {
      if (!privateKeyReadGuard.isCurrent(readRevision)) return;
      setPrivateKeyFileError(
        describeError(error).body,
      );
    } finally {
      if (privateKeyReadGuard.isCurrent(readRevision)) {
        setPrivateKeyFileLoading(false);
      }
    }
  };
  const replacePrivateKey = (privateKey: string) => {
    privateKeyReadGuard.invalidate();
    setPrivateKeyFileError(null);
    setPrivateKeyFileLoaded(false);
    setPrivateKeyFileLoading(false);
    setCredentials((current) => ({ ...current, privateKey }));
  };
  const slackApp = endpoint.setup?.slackApp ?? {
    ...defaultSlackAppConfiguration(agentName),
    ...(endpoint.setup?.command ? { command: endpoint.setup.command } : {}),
  };
  const automaticSlack = isProvisionedSlackSetup(endpoint.setup?.slackSetupMethod);
  const slackValidation = slackAppConfigurationSchema.safeParse(slackApp);
  const saveSlackAndExit = () => navigate("/apps");
  const slackAppName = slackApp.appName.trim();
  const slackBotName = slackApp.botName.trim();
  const slackCommand = slackApp.command.trim();
  const slackWebhookUrl =
    endpoint.setup?.webhookUrl ?? t("paperclip_webhook_url_ea54ff6");
  const slackManifest = JSON.stringify(buildSlackAppManifest({
    app: { appName: slackAppName, botName: slackBotName, command: slackCommand }, agentName,
    webhookUrl: slackWebhookUrl,
    ...(automaticSlack && endpoint.setup?.slackOAuthCallbackUri ? { redirectUri: endpoint.setup.slackOAuthCallbackUri } : {}),
  }), null, 2);
  const slackCreateUrl = `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(slackManifest)}`;
  useEffect(() => setManifestCopied(false), [slackManifest]);
  const teamsClientId =
    credentials.clientId?.trim() || t("application_client_id_8bb3a1c");
  const teamsManifestSettings = JSON.stringify(
    {
      bots: [
        {
          botId: teamsClientId,
          scopes: ["personal", "team", "groupChat"],
          supportsFiles: true,
          isNotificationOnly: false,
          commandLists: [
            {
              scopes: ["personal", "groupChat"],
              commands: [
                {
                  title: "/status",
                  description: t("show_the_active_paperclip_task_status_e733a77"),
                },
                {
                  title: "/new",
                  description: t("start_a_new_paperclip_task_in_this_d856720"),
                },
                {
                  title: "/close",
                  description: t("close_the_active_chat_conversation_413edaf"),
                },
              ],
            },
          ],
        },
      ],
      webApplicationInfo: {
        id: teamsClientId,
        resource: "https://paperclip.ing",
      },
      authorization: {
        permissions: {
          resourceSpecific: [
            { name: "ChannelMessage.Read.Group", type: "Application" },
            { name: "ChatMessage.Read.Chat", type: "Application" },
          ],
        },
      },
    },
    null,
    2,
  );
  if (provider === "speko") return <SpekoProviderSetup onSaveExit={() => navigate("/apps")} agentName={agentName} credentials={credentials} onChange={setCredentials} onConnect={(values) => onAction(repairing ? "reconnect" : "configure", values)} callbackUrl={endpoint.setup?.webhookUrl} pending={pending} repairing={repairing} signingSecretConfigured={endpoint.setup?.webhookSecretConfigured} />;
  if (provider === "imessage-photon") return <PhotonConnectStep endpoint={endpoint} agentName={agentName} repairing={repairing} pending={pending} onAction={onAction} />;
  if (provider === "discord") {
    const applicationId = credentials.applicationId?.trim() ?? "";
    const guildId = credentials.guildId?.trim() ?? "";
    const installUrl = applicationId
      ? `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(applicationId)}&permissions=309237763136&scope=bot${guildId ? `&guild_id=${encodeURIComponent(guildId)}&disable_guild_select=true` : ""}`
      : null;
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-xl font-bold">{t("connect_to_discord_e04349f", { agentName: agentName })}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {repairing
              ? t("reconnect_verifies_this_same_discord_application_and_9c9e49d")
              : t("create_one_dedicated_discord_application_and_bot_d4e6c3c")}
          </p>
        </div>
      <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>{t("in_discord_developer_portal_create_an_application_c4e1328")}</li>
          <li>{t("open_bot_create_the_bot_enable_message_5724305")}</li>
          <li>{t("enable_developer_mode_in_discord_right_click_578d9e1")}</li>
          <li>{t("enter_those_values_below_then_use_the_1f0fb08")}</li>
        </ol>
        <Button
          variant="outline"
          onClick={() =>
            openProviderSetup("https://discord.com/developers/applications")
          }
        >{t("open_discord_developer_portal_d2927b9")}<ExternalLink />
        </Button>
        {field("applicationId", finalPagesT("final-pages:Application_ID_77e90b"), "text")}
        {field("guildId", finalPagesT("final-pages:Server_ID_ff21e8"), "text")}
        {field("botToken", finalPagesT("final-pages:Bot_token_5bb9ae"))}
        {installUrl && (
          <Button asChild variant="outline">
            <a href={installUrl} target="_blank" rel="noreferrer">{t("install_bot_in_this_server_f2a446e")}<ExternalLink />
            </a>
          </Button>
        )}
        <p className="text-sm text-muted-foreground">{t("the_install_link_grants_only_view_channels_57df655")}</p>
        <Button
          disabled={
            (!repairing &&
              (!credentials.applicationId ||
                !credentials.guildId ||
                !credentials.botToken)) ||
            pending
          }
          onClick={() =>
            onAction(repairing ? "reconnect" : "configure", credentials)
          }
        >
          {pending && <Loader2 className="h-4 w-4 animate-spin" />}
          {repairing ? t("reconnect_discord_bot_cc9fb4a") : t("connect_discord_bot_e0e3db9")}
        </Button>
      </div>
    );
  }
  if (provider === "telegram")
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-xl font-bold">{t("create_in_telegram_3c64c64", { agentName: agentName })}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {repairing
              ? t("reconnect_verifies_this_same_botfather_bot_and_4ebb5b2")
              : t("create_a_bot_with_botfather_then_paste_b831150")}
          </p>
        </div>
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>{t("open_botfather_and_send_cb738a8")}<code>/newbot</code>.
          </li>
          <li>{t("enter_the_bot_display_name_22c13fc")}</li>
          <li>{t("choose_an_available_username_ending_in_15ca4b1")}<code>bot</code>.
          </li>
        </ol>
        <p className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">{t("paperclip_works_with_telegram_s_default_bot_66e1adb")}{" "}
          <code>/task@bot_username &lt;request&gt;</code>{t("or_reply_directly_to_a_message_from_4c7db79")}</p>
        <Button
          variant="outline"
          onClick={() => openProviderSetup("https://t.me/BotFather")}
        >{t("open_botfather_5dae899")}<ExternalLink />
        </Button>
        {field("botToken", finalPagesT("final-pages:Bot_token_5bb9ae"))}
        {(!endpoint.setup?.webhookUrl || automaticSlack && !endpoint.setup?.slackOAuthCallbackUri?.startsWith("https://")) && (
          <p className="text-sm text-destructive">{t("configure_a_public_https_url_for_this_30582e1")}</p>
        )}
        <Button
          disabled={
            (!repairing && !credentials.botToken) ||
            !endpoint.setup?.webhookUrl ||
            pending
          }
          onClick={() =>
            onAction(repairing ? "reconnect" : "configure", credentials)
          }
        >
          {pending && <Loader2 className="h-4 w-4 animate-spin" />}
          {repairing ? t("reconnect_bot_46f1b58") : t("connect_bot_27663b0")}
        </Button>
      </div>
    );
  if (provider === "microsoft-teams")
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-xl font-bold">{t("connect_to_microsoft_teams_59ae530", { agentName: agentName })}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {repairing
              ? t("reconnect_verifies_this_same_microsoft_app_tenant_681c3b1")
              : t("use_your_own_microsoft_app_credentials_for_0269175")}
          </p>
        </div>
        <p className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">{t("this_setup_requires_a_microsoft_365_work_155634e")}</p>
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>{t("in_microsoft_entra_create_a_single_tenant_59c93e4")}</li>
          <li>{t("in_azure_create_an_azure_bot_choose_4669502")}</li>
          <li>{t("in_teams_developer_portal_create_an_app_5267486")}</li>
        </ol>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <a
              href="https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade"
              target="_blank"
              rel="noreferrer"
            >{t("open_microsoft_entra_f586092")}<ExternalLink />
            </a>
          </Button>
          <Button asChild variant="outline">
            <a
              href="https://portal.azure.com/#create/Microsoft.AzureBot"
              target="_blank"
              rel="noreferrer"
            >{t("create_azure_bot_9bda0f6")}<ExternalLink />
            </a>
          </Button>
          <Button asChild variant="outline">
            <a
              href="https://dev.teams.microsoft.com/apps"
              target="_blank"
              rel="noreferrer"
            >{t("open_teams_developer_portal_7fb94fe")}<ExternalLink />
            </a>
          </Button>
        </div>
        {endpointValue(
          finalPagesT("final-pages:Paperclip_messaging_endpoint_8201b3"),
          endpoint.setup?.messagingEndpoint,
        )}
        {field("clientId", finalPagesT("final-pages:Application_Client_ID_b89f77"), "text")}
        {field("tenantId", finalPagesT("final-pages:Directory_Tenant_ID_4476af"), "text")}
        {field("clientSecret", finalPagesT("final-pages:Client_secret_value_1aae7c"))}
        <section className="space-y-3 rounded-lg border border-border p-4">
          <div>
            <h2 className="text-sm font-semibold">{t("microsoft_portal_field_map_d43b128")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("use_these_exact_portal_sections_and_reuse_8366531")}</p>
          </div>
          <ol className="list-decimal space-y-3 pl-5 text-sm">
            <li>
              <Trans ns="connections" i18nKey="reviewBEntraRegistration" components={{ strong: <strong /> }} /></li>
            <li>
              <Trans ns="connections" i18nKey="reviewBAzureBot" components={{ strong: <strong /> }} />
            </li>
            <li>
              <strong>{t("teams_developer_portal_apps_7ab94dd")}</strong>{t("select_ec59e18")}{" "}
              <strong>{t("new_app_df29c05")}</strong>{t("under_433f34b")}{" "}
              <strong>{t("configure_app_features_bot_82332d7")}</strong>{t("add_an_existing_bot_using_the_same_1bffcb3")}{" "}
              <strong>{t("personal_40f0732")}</strong>, <strong>{t("team_2188872")}</strong>{t("and_8278d2a")}{" "}
              <strong>{t("group_chat_323d216")}</strong>{t("scopes_plus_file_support_under_fcb5574")}{" "}
              <strong>{t("configure_permissions_d4f4117")}</strong>{t("add_the_two_rsc_2095fa9")}{" "}
              <strong>{t("application_b291beb")}</strong>{t("permissions_shown_below_complete_the_required_app_a132f13")}</li>
            <li>
              <strong>{t("microsoft_teams_apps_manage_your_apps_a4b77c4")}</strong>{t("select_ec59e18")}{" "}
              <strong>{t("upload_an_app_upload_a_custom_app_9b71709")}</strong>{t("choose_the_downloaded_package_and_install_it_5975dab")}</li>
          </ol>
        </section>
        <label className="grid gap-2 text-sm font-medium">{t("required_teams_app_manifest_block_ddf7a01")}<Textarea
            className="min-h-80 font-mono text-xs"
            readOnly
            value={teamsManifestSettings}
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={!credentials.clientId?.trim()}
            onClick={() => {
              void copyTextToClipboard(teamsManifestSettings).then(
                () => setManifestCopied(true),
                reportCopyFailure,
              );
            }}
          >
            {manifestCopied
              ? t("manifest_settings_copied_d97d572")
              : t("copy_manifest_settings_3a7547a")}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">{t("enter_the_application_client_id_above_before_137ed2f")}</p>
        <p className="text-sm text-muted-foreground">{t("paperclip_does_not_use_teams_single_sign_9a2081d")}<code>webApplicationInfo</code>{t("entry_only_associates_the_rsc_permissions_with_603c380")}</p>
        <p className="text-sm text-muted-foreground">{t("the_two_application_rsc_permissions_let_the_b7966ea")}</p>
        <p className="text-sm text-muted-foreground">{t("this_release_supports_personal_chats_group_chats_5fc38e3")}<code>supportsFiles: true</code>{" "}{t("enables_native_file_receipt_and_consent_based_928319d")}</p>
        {!endpoint.setup?.messagingEndpoint && (
          <p className="text-sm text-destructive">{t("configure_a_public_https_url_for_this_26fe4e2")}</p>
        )}
        <Button
          disabled={
            (!repairing &&
              (!credentials.clientId ||
                !credentials.tenantId ||
                !credentials.clientSecret)) ||
            !endpoint.setup?.messagingEndpoint ||
            pending
          }
          onClick={() =>
            onAction(repairing ? "reconnect" : "configure", credentials)
          }
        >
          {pending && <Loader2 className="h-4 w-4 animate-spin" />}
          {repairing
            ? t("reconnect_microsoft_app_f3e4748")
            : t("verify_microsoft_credentials_e2cde25")}
        </Button>
      </div>
    );
  if (provider === "github")
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-xl font-bold">
            {repairing
              ? t("reconnect_github_app_ae8203e")
              : t("create_or_connect_a_github_app_8793caa")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {repairing
              ? t("reconnect_verifies_this_same_app_and_installation_cbf9398")
              : t("configure_its_webhook_and_permissions_then_verify_dc89f22")}
          </p>
        </div>
        {!repairing && (
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            <li>{t("under_the_target_user_or_organization_create_7edbd8d")}</li>
            <li><Trans ns="connections" i18nKey="reviewBGitHubSsl" components={{ strong: <strong /> }} /></li>
            <li><Trans ns="connections" i18nKey="reviewBGitHubPermissions" components={{ strong: <strong /> }} /></li>
            <li><Trans ns="final-pages" i18nKey="Subscribe_to_issueLabel_Issue_comment_issueLabel_issue_issue_comm_e8b0f1" components={{ issueLabel: <strong />, issue: <code />, reviewLabel: <strong />, review: <code />, installation: <code />, repositories: <code /> }} /></li>
            <li>{t("choose_bcf399c")}<strong>{t("only_on_this_account_53b11b1")}</strong>{t("create_the_app_copy_its_app_id_7494eff")}</li>
          </ol>
        )}
        {endpointValue(
          finalPagesT("final-pages:Paperclip_homepage_URL_d06f60"),
          publicOrigin(endpoint.setup?.webhookUrl),
        )}
        {endpointValue(finalPagesT("final-pages:Paperclip_webhook_URL_57aa8a"), endpoint.setup?.webhookUrl)}
        <Button
          variant="outline"
          onClick={() =>
            window.open(
              repairing
                ? "https://github.com/settings/apps"
                : (endpoint.setup?.authorizationUrl ??
                    "https://github.com/settings/apps/new"),
              "_blank",
              "noopener,noreferrer",
            )
          }
        >
          {repairing ? t("open_github_app_settings_fe0cef0") : t("open_new_github_app_form_35af273")}{" "}
          <ExternalLink />
        </Button>
        {field("appId", finalPagesT("final-pages:GitHub_App_ID_7c8675"), "text")}
        <div className="grid gap-2 text-sm font-medium">
          <label htmlFor="github-private-key">{t("private_key_pem_9fa9e69")}</label>
          <div className="relative">
            {privateKeyVisible ? (
              <Textarea
                id="github-private-key"
                className="min-h-24 pr-11 font-mono text-xs"
                value={credentials.privateKey ?? ""}
                onChange={(event) => replacePrivateKey(event.target.value)}
              />
            ) : (
              <Input
                id="github-private-key"
                type="password"
                className="pr-11 font-mono text-xs"
                value={credentials.privateKey ?? ""}
                onChange={(event) => replacePrivateKey(event.target.value)}
                onPaste={(event) => {
                  event.preventDefault();
                  replacePrivateKey(event.clipboardData.getData("text"));
                }}
              />
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-1 top-1"
              aria-label={
                privateKeyVisible ? t("hide_private_key_cd85f90") : t("show_private_key_5c0f22f")
              }
              onClick={() => setPrivateKeyVisible((visible) => !visible)}
            >
              {privateKeyVisible ? <EyeOff /> : <Eye />}
            </Button>
          </div>
          <input
            ref={privateKeyFileInputRef}
            type="file"
            accept=".pem,.key,application/x-pem-file,application/pkcs8,text/plain"
            className="hidden"
            aria-label={t("choose_github_app_private_key_file_0e2673b")}
            onChange={loadPrivateKeyFile}
          />
          <div>
            <Button
              type="button"
              variant="outline"
              onClick={() => privateKeyFileInputRef.current?.click()}
            >{t("choose_pem_file_0b0f518")}</Button>
          </div>
          {privateKeyFileError ? (
            <p role="alert" className="text-sm text-destructive">
              {privateKeyFileError}
            </p>
          ) : null}
          {privateKeyFileLoading ? (
            <p
              role="status"
              aria-live="polite"
              className="text-sm text-muted-foreground"
            >{t("reading_private_key_file_f362605")}</p>
          ) : privateKeyFileLoaded ? (
            <p
              role="status"
              aria-live="polite"
              className="text-sm text-muted-foreground"
            >{t("private_key_loaded_it_stays_in_this_7eaed7f")}</p>
          ) : null}
        </div>
        <div className="grid gap-2">
          <p className="text-sm font-medium">{t("webhook_secret_ba261e9")}</p>
          {generatedWebhookSecret ? (
            <>
              <Input
                aria-label={t("generated_webhook_secret_43d3181")}
                className="font-mono text-xs"
                readOnly
                value={generatedWebhookSecret}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    // Both signals, and each covers the other's blind spot.
                    // The toast is the loud one, the way this step's other two
                    // copy buttons report failure — but the provider dedupes an
                    // identical toast inside 3.5s, so a reader who clicks twice
                    // on a blocked clipboard would see nothing the second time.
                    // The inline state answers every click.
                    void webhookSecretCopy
                      .copy(generatedWebhookSecret)
                      .then((status) => {
                        if (status === "failed") reportCopyFailure();
                      });
                  }}
                >
                  {webhookSecretCopy.copied
                    ? t("webhook_secret_copied_54bbcee")
                    : webhookSecretCopy.failed
                      ? t("couldn_t_copy_select_it_manually_e71d3a3")
                      : t("copy_webhook_secret_b011afb")}
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">{t("copy_this_value_now_paperclip_will_not_65150ee")}</p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              {endpoint.setup?.webhookSecretConfigured
                ? t("a_webhook_secret_is_configured_and_cannot_6feb89f")
                : t("generate_the_secret_in_paperclip_then_paste_22f5501")}
            </p>
          )}
          <div>
            <Button
              type="button"
              variant="outline"
              disabled={generatingSetupSecret}
              onClick={onGenerateSetupSecret}
            >
              {generatingSetupSecret && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              {endpoint.setup?.webhookSecretConfigured
                ? t("regenerate_webhook_secret_afc5928")
                : t("generate_webhook_secret_3bd1796")}
            </Button>
          </div>
          {endpoint.setup?.webhookSecretConfigured && (
            <p className="text-sm text-muted-foreground">
              {endpoint.providerAccountId || endpoint.botExternalId
                ? t("regenerating_immediately_invalidates_github_webhook_signatures_until_68d203b")
                : t("generating_another_secret_replaces_the_previous_value_cab4402")}
            </p>
          )}
          {endpoint.setup?.webhookSecretConfigured && (
            <p
              className={`text-sm ${endpoint.setup.webhookVerifiedAt ? "text-foreground" : "text-muted-foreground"}`}
            >
              {endpoint.setup.webhookVerifiedAt
                ? t("github_has_verified_this_webhook_56fe109")
                : t("waiting_for_github_to_deliver_its_signed_d563bc7")}
            </p>
          )}
        </div>
        {(!endpoint.setup?.webhookUrl || automaticSlack && !endpoint.setup?.slackOAuthCallbackUri?.startsWith("https://")) && (
          <p className="text-sm text-destructive">{t("configure_a_public_https_url_for_this_39e67e5")}</p>
        )}
        <Button
          disabled={
            (!repairing && (!credentials.appId || !credentials.privateKey)) ||
            !endpoint.setup?.webhookSecretConfigured ||
            !endpoint.setup?.webhookVerifiedAt ||
            !endpoint.setup?.webhookUrl ||
            privateKeyFileLoading ||
            generatingSetupSecret ||
            pending
          }
          onClick={() =>
            onAction(repairing ? "reconnect" : "configure", credentials)
          }
        >
          {pending && <Loader2 className="h-4 w-4 animate-spin" />}
          {repairing ? t("reconnect_and_verify_2c066c4") : t("connect_and_verify_8885f3f")}
        </Button>
      </div>
    );
  const slackRequestUrlInstructions = <ol className="list-decimal space-y-2 pl-5 text-sm">
      <li><a className="underline underline-offset-4" href={endpoint.setup?.slackRegistration?.appId ? `https://api.slack.com/apps/${encodeURIComponent(endpoint.setup.slackRegistration.appId)}/event-subscriptions` : "https://api.slack.com/apps"} target="_blank" rel="noopener noreferrer">{t("open_slack_app_settings_8ea374a")}<ExternalLink className="inline size-3" /></a>{t("and_choose_0cf27fd")}<strong>{slackApp.appName}</strong>.</li>
      <li>{t("choose_bcf399c")}<strong>{t("event_subscriptions_3b29882")}</strong>.</li>
      <li>{t("beside_the_prefilled_c8cf236")}<strong>{t("request_url_befd91c")}</strong>{t("click_6a71648")}<strong>{t("retry_9f5cd8a")}</strong>{t("if_it_isn_t_verified_save_changes_a9b149f")}</li>
    </ol>;
  if (slackStage === "finish")
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-xl font-bold">{automaticSlack ? t("send_a_message_to_your_agent_29aab2e") : t("verify_slack_connection_cfb7021")}</h1>
          {!automaticSlack && <p className="mt-1 text-sm text-muted-foreground">{t("slack_needs_to_confirm_that_it_can_6e22941")}</p>}
        </div>
        {automaticSlack ? <Button asChild variant="outline"><a href={slackConversationUrl(endpoint, identitySettled ? userId : null)} target="_blank" rel="noopener noreferrer">{t("open_slack_8245d1b")}<ExternalLink className="size-4" /></a></Button> : slackRequestUrlInstructions}
        {endpoint.setup?.webhookVerifiedAt ? (
          <p role="status" className="flex items-center gap-2 text-sm">
            <CheckCircle2 className="size-4 text-(--status-task-done)" />{t("your_slack_connection_is_working_176b182")}{pending ? automaticSlack ? t("finishing_setup_e7616b3") : t("opening_the_message_test_dbd1816") : ""}
          </p>
        ) : slackVerificationError ? (
          <p role="alert" className="text-sm text-destructive">{t("couldn_t_check_verification_we_ll_keep_f460189")}</p>
        ) : (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> {automaticSlack ? t("waiting_for_your_message_d33c496") : t("waiting_for_slack_we_ll_continue_automatically_ed79b8b")}
          </p>
        )}
        <SlackSetupAdvanced label={automaticSlack ? t("didn_t_work_b0b0979") : t("troubleshooting_285ec85")}>
          {automaticSlack && slackRequestUrlInstructions}
          <p className="text-muted-foreground">{t("if_the_request_url_is_missing_or_399531f")}</p>
          {endpointValue(finalPagesT("final-pages:Paperclip_webhook_URL_57aa8a"), endpoint.setup?.webhookUrl)}
        </SlackSetupAdvanced>
        <div className="flex items-center justify-between gap-3">
          <Button variant="ghost" className="text-muted-foreground" onClick={() => navigate("/apps")}>{t("save_exit_fc5599f")}</Button>
          {(!automaticSlack || endpoint.setup?.webhookVerifiedAt) && <Button disabled={pending || !endpoint.setup?.webhookVerifiedAt} onClick={() =>
            endpoint.setup?.step === "provider_setup" ? onAction("verify") : onSlackVerificationContinue()
          }>
            {pending && <Loader2 className="size-4 animate-spin" />}{t("continue_4f5e94c")}</Button>}
        </div>
      </div>
    );

  return (
    <div className="space-y-5">
      {(!endpoint.setup?.webhookUrl || automaticSlack && !endpoint.setup?.slackOAuthCallbackUri?.startsWith("https://")) && (
        <div role="alert" className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4">
          <AlertTriangle className="size-5 shrink-0 text-destructive" />
          <div className="space-y-1">
            <p className="text-sm font-semibold">{t("public_https_url_required_05b3278")}</p>
            <p className="text-sm">{t("slack_needs_a_public_https_url_to_d99abc4")}</p>
            <a
              href="https://docs.paperclip.ing/reference/deploy/https/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm underline underline-offset-4"
            >{t("learn_how_to_set_up_https_c0f95c6")}</a>
          </div>
        </div>
      )}
      <div>
        <h1 className="text-xl font-bold">{endpoint.setup?.slackSetupMethod === "managed" ? t("connect_to_slack_2860f46") : slackStage === "app" ? automaticSlack ? t("app_configuration_access_token_4c31df4") : t("create_a_slack_app_07c1027") : automaticSlack ? t("install_slack_app_84ec17b") : t("add_slack_credentials_6662486")}</h1>
        {repairing && !automaticSlack && (
          <p className="mt-1 text-sm text-muted-foreground">{t("reconnect_verifies_or_replaces_credentials_for_this_ecfe955")}</p>
        )}
      </div>
      <div hidden={slackStage !== "app" || automaticSlack} className="space-y-5">
        <div className="space-y-3 text-sm">
          <div className="flex justify-end">
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="link" className="h-auto p-0 text-xs text-muted-foreground underline underline-offset-4">{t("view_slack_app_manifest_0dc2152")}</Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-2xl">
                <DialogHeader>
                  <DialogTitle>{t("slack_app_manifest_341846a")}</DialogTitle>
                  <DialogDescription>{t("generated_from_your_app_name_bot_name_e96f74c")}</DialogDescription>
                </DialogHeader>
                <Textarea
                  aria-label={t("slack_app_manifest_341846a")}
                  className="h-80 font-mono text-xs"
                  readOnly
                  value={slackManifest}
                />
                <DialogFooter>
                  <Button
                    variant="outline"
                    disabled={!slackValidation.success}
                    onClick={() => {
                      void copyTextToClipboard(slackManifest).then(
                        () => setManifestCopied(true),
                        reportCopyFailure,
                      );
                    }}
                  >
                    {manifestCopied ? t("manifest_copied_ac3a931") : t("copy_manifest_787420a")}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </div>
        {!automaticSlack && <div className="flex flex-wrap items-center justify-between gap-3 pt-3">
          <Button variant="ghost" className="text-muted-foreground" onClick={() => void saveSlackAndExit()}>{t("save_exit_ea61678")}</Button>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            <Button variant="outline" disabled={openingSlackApp || !endpoint.setup?.webhookUrl || !slackValidation.success} onClick={onSlackAppCreated}>{t("i_already_created_the_app_253c0b6")}</Button>
            {!repairing && (
              <Button
                disabled={openingSlackApp || !endpoint.setup?.webhookUrl || !slackValidation.success}
                onClick={() => {
                  window.open(slackCreateUrl, "_blank", "noopener,noreferrer");
                  setOpeningSlackApp(true);
                  // Let Slack open before changing the step behind its new tab.
                  slackAdvanceTimer.current = setTimeout(() => {
                    slackAdvanceTimer.current = null;
                    setOpeningSlackApp(false);
                    onSlackAppCreated();
                  }, 1000);
                }}
              >{t("create_slack_app_9f41b46")}<ExternalLink />
              </Button>
            )}
          </div>
        </div>}
      </div>
      {automaticSlack && <SlackSetup
        key={endpoint.id}
        autoStart={managedAutoStart}
        reconnect={repairing}
        endpoint={endpoint} stage={slackStage} disabled={!endpoint.setup?.webhookUrl || !endpoint.setup?.slackOAuthCallbackUri?.startsWith("https://") || !slackValidation.success}
        saveDetails={async () => {}}
        onBusy={onAutomaticBusy} onSaved={onEndpointSaved} onContinue={onSlackAppCreated}
        onManual={async existing => {
          onEndpointSaved(await chatEndpointsApi.update(endpoint.id, { slackSetupMethod: existing ? "existing" : "manual" }));
          if (existing) onSlackAppCreated();
        }}
        onSaveExit={() => void saveSlackAndExit()}
      />}
      {!automaticSlack && <div hidden={slackStage !== "credentials"} className="space-y-5">
        <p className="text-sm">{t("now_you_need_to_find_two_secrets_6c61ebf")}</p>
        {slackCredentialsSaved && !repairing && (
          <p className="text-sm text-muted-foreground">{t("your_credentials_are_saved_leave_the_fields_d532847")}</p>
        )}
        <section className="space-y-3">
          <h2 className="text-sm font-semibold"><label htmlFor="slack-bot-token">{t("bot_user_oauth_token_e202229")}</label></h2>
          <ul id="slack-bot-token-help" className="list-disc space-y-1 pl-5 text-sm">
            <li>
              <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">{t("open_slack_app_settings_8ea374a")}<ExternalLink className="inline size-3" />
              </a>{t("and_choose_0cf27fd")}<strong>{slackApp.appName}</strong>.
            </li>
            <li>{t("choose_bcf399c")}<strong>{t("oauth_permissions_efd4808")}</strong></li>
            <li>{t("copy_and_paste_your_634dabe")}<strong>{t("bot_oauth_token_de4f25f")}</strong></li>
          </ul>
          <Input
            id="slack-bot-token"
            type="password"
            placeholder={slackCredentialsSaved ? t("saved_leave_blank_to_keep_c4a627d") : undefined}
            value={credentials.botToken ?? ""}
            aria-invalid={slackBotTokenInvalid || undefined}
            aria-describedby={`slack-bot-token-help${slackBotTokenInvalid ? " slack-bot-token-warning" : ""}`}
            onChange={(event) => setCredentials({ ...credentials, botToken: event.target.value })}
          />
          {slackBotTokenInvalid && (
            <p id="slack-bot-token-warning" role="alert" className="text-sm text-destructive">{t("your_bot_user_oauth_token_must_start_4accc15")}<code>xoxb-</code>{t("copy_it_from_b2ade07")}<strong>{t("oauth_permissions_efd4808")}</strong>.
            </p>
          )}
        </section>
        <section className="space-y-3">
          <h2 className="text-sm font-semibold"><label htmlFor="slack-signing-secret">{t("signing_secret_7898d07")}</label></h2>
          <ul id="slack-signing-secret-help" className="list-disc space-y-1 pl-5 text-sm">
            <li>
              <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">{t("open_slack_app_settings_8ea374a")}<ExternalLink className="inline size-3" />
              </a>{t("and_choose_0cf27fd")}<strong>{slackApp.appName}</strong>.
            </li>
            <li>{t("choose_bcf399c")}<strong>{t("basic_information_b0d5be3")}</strong></li>
            <li>{t("copy_and_paste_your_634dabe")}<strong>{t("signing_secret_7898d07")}</strong></li>
          </ul>
          <Input
            id="slack-signing-secret"
            type="password"
            placeholder={slackCredentialsSaved ? t("saved_leave_blank_to_keep_c4a627d") : undefined}
            value={credentials.signingSecret ?? ""}
            aria-invalid={slackSigningSecretHasTokenPrefix || undefined}
            aria-describedby={`slack-signing-secret-help${slackSigningSecretHasTokenPrefix ? " slack-signing-secret-warning" : ""}`}
            onChange={(event) => setCredentials({ ...credentials, signingSecret: event.target.value })}
          />
          {slackSigningSecretHasTokenPrefix && (
            <p id="slack-signing-secret-warning" role="alert" className="text-sm text-destructive">{t("use_the_8fd4b07")}<strong>{t("signing_secret_7898d07")}</strong>{t("not_an_app_or_bot_token_the_f028d12")}</p>
          )}
        </section>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button variant="ghost" className="text-muted-foreground" onClick={() => navigate("/apps")}>{t("save_exit_ea61678")}</Button>
          <Button
            className="ml-auto"
            disabled={
              (!repairing && !slackCredentialsSaved && (!slackBotToken || !credentials.signingSecret?.trim())) ||
              !endpoint.setup?.webhookUrl || !slackValidation.success ||
              pending || slackSigningSecretHasTokenPrefix || slackBotTokenInvalid
            }
            onClick={() => continueWithSavedSlackCredentials
              ? onSlackCredentialsContinue()
              : onAction(repairing || slackCredentialsSaved ? "reconnect" : "configure", credentials)}
          >
            {pending && <Loader2 className="h-4 w-4 animate-spin" />}
            {continueWithSavedSlackCredentials ? t("continue_2e02623") : repairing || slackCredentialsSaved ? t("reconnect_slack_app_bcef806") : t("connect_slack_app_a0cefff")}
          </Button>
        </div>
      </div>}
    </div>
  );
}

function TryStep({
  endpointId,
  provider,
  agentName,
  botLabel,
  botUsername,
  slackAccount,
  photonAllocation,
  providerUrl,
  guestIsolationState,
  pending,
  onOpenAccess,
  onTest,
  onSaveExit,
}: {
  endpointId: string;
  provider: ChatProvider;
  agentName: string;
  botLabel?: string | null;
  botUsername?: string | null;
  slackAccount?: import("@paperclipai/shared").SlackAccountState;
  photonAllocation?: "dedicated" | "shared";
  providerUrl?: string | null;
  guestIsolationState: "loading" | "enabled" | "disabled" | "unknown";
  pending: boolean;
  onOpenAccess: () => void;
  onTest: () => void;
  onSaveExit: () => void;
}) {
  const { t } = useTranslation("connections");
  const [commandCopied, setCommandCopied] = useState(false);
  const [commandCopyError, setCommandCopyError] = useState(false);
  const principalsQuery = useQuery({
    queryKey: queryKeys.chatEndpoints.principals(endpointId),
    queryFn: () => chatEndpointsApi.listPrincipals(endpointId),
    enabled: provider !== "slack",
    refetchInterval: 1_500,
  });
  const principalsView = useQueryView(principalsQuery);
  const principalsLoaded = principalsView.kind === "ready" || principalsView.kind === "stale";
  const principalsFailed = principalsView.kind === "error";
  const [numberCopied, setNumberCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const identities = principalsQuery.data ?? [];
  const unlinkedIdentities = identities.filter(
    (identity) => identity.status !== "linked",
  );
  const freshConversationInstruction =
    provider === "imessage-photon" ? t("send_a_fresh_message_to_your_photon_0cf2f9a") : provider === "telegram"
      ? t("start_a_fresh_conversation_with_new_and_1aa7aa9")
      : provider === "github"
        ? t("start_a_new_issue_or_pull_request_f96c49a")
        : provider === "microsoft-teams"
          ? t("start_a_new_channel_post_and_mention_6ebd10b")
          : t("send_a_new_root_mention_to_the_51f276c");
  const identityGuidance = provider === "slack" ? null : provider === "imessage-photon" && principalsLoaded && (identities.length === 0 || unlinkedIdentities.length > 0)
    ? { tone: "info" as const, title: t("link_your_messages_identity_97e73c4"), body: t("send_one_message_to_discover_your_phone_de4bf46") }
    : principalsFailed
    ? {
        tone: "warning" as const,
        title: t("identity_readiness_could_not_be_checked_5437faa"),
        body: t("review_access_before_expecting_an_agent_reply_40068ce", { freshConversationInstruction: freshConversationInstruction }),
      }
    : !principalsLoaded || guestIsolationState === "loading"
      ? null
      : identities.length === 0
        ? guestIsolationState === "disabled"
          ? {
              tone: "warning" as const,
              title: t("link_the_account_you_re_testing_0d1e1de"),
              body:
                provider === "telegram"
                  ? t("tap_start_in_telegram_to_discover_your_de80b82")
                  : t("your_first_message_discovers_the_external_account_01dd70c", { value: providerNames[provider], agentName: agentName, freshConversationInstruction: freshConversationInstruction }),
            }
          : {
              tone: "info" as const,
              title: t("your_first_message_identifies_your_account_a06ad08"),
              body:
                provider === "telegram"
                  ? t("tap_start_in_telegram_to_discover_your_b6a36ac")
                  : t("until_linked_the_account_is_a_restricted_b320d88", { freshConversationInstruction: freshConversationInstruction }),
            }
        : unlinkedIdentities.length > 0
          ? guestIsolationState === "disabled"
            ? {
                tone: "warning" as const,
                title: t("link_the_account_you_re_testing_0d1e1de"),
                body: t("an_observed_external_account_is_unlinked_and_ed77d81", { agentName: agentName, freshConversationInstruction: freshConversationInstruction }),
              }
            : {
                tone: "info" as const,
                title: t("unlinked_identity_detected_19a084e"),
                body: t("an_unlinked_account_is_a_restricted_guest_84dfe71", { freshConversationInstruction: freshConversationInstruction }),
              }
          : null;
  const providerBotUsername = botUsername?.replace(/^@/, "");
  const normalizedBotUsername =
    provider === "github"
      ? providerBotUsername?.replace(/\[bot\]$/i, "")
      : providerBotUsername;
  const botMention = normalizedBotUsername
    ? `@${normalizedBotUsername}`
    : (botLabel ?? agentName);
  const slackTestMessage = slackAccount?.status === "linked" ? "you there?" : `${botMention.startsWith("@") ? botMention : `@${botMention}`} you there?`;
  const instructions =
    provider === "imessage-photon" ? [
      photonAllocation === "shared" ? t("in_your_photon_project_enroll_your_sender_10c27b5") : t("open_apple_messages_and_send_a_fresh_be601d4", { value: botUsername ?? botLabel ?? t("the_dedicated_number_e03824f") }),
      t("link_the_discovered_sender_to_a_paperclip_cdadff1"),
      t("wait_for_the_agent_s_actual_reply_c859b12"),
      ...(photonAllocation === "shared" ? [t("this_pro_compatible_channel_supports_dms_only_f3572da")] : [t("for_a_group_add_the_number_in_dc65f4e")]),
    ] : provider === "discord"
      ? [
          t("open_a_text_channel_where_the_bot_a48cb07"),
          t("mention_in_a_new_root_message_4eea781", { botMention: botMention }),
          t("reply_once_inside_s_new_discord_thread_f78dfc8", { agentName: agentName }),
        ]
      : provider === "telegram"
        ? [
            t("open_the_bot_s_private_chat_1e27cc5"),
            t("tap_start_b770f27"),
            t("send_help_me_test_this_4789e58"),
          ]
        : provider === "github"
          ? [
              t("open_an_installed_issue_or_pull_request_fb9af9d"),
              t("mention_in_a_comment_31f9577", { botMention: botMention }),
              t("add_another_comment_to_continue_the_same_743a98d"),
            ]
          : provider === "microsoft-teams"
            ? [
                t("open_an_installed_channel_and_start_a_9564716"),
                t("mention_in_the_post_297e038", { botMention: botMention }),
                t("reply_once_beneath_the_post_753be7e"),
              ]
            : [
                t("open_a_channel_and_invite_if_needed_1728995", { botMention: botMention }),
                t("mention_in_a_new_channel_message_3b062d7", { botMention: botMention }),
                t("reply_once_in_s_thread_70d6c1b", { agentName: agentName }),
              ];
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold">{t("try_in_2a1468c", { agentName: agentName, value: providerNames[provider] })}</h1>
        {provider !== "slack" && <p className="mt-1 text-sm text-muted-foreground">{t("complete_this_real_conversation_to_finish_setup_474bcb4")}</p>}
      </div>
      {provider !== "slack" && (!principalsLoaded || guestIsolationState === "loading") &&
      !principalsFailed ? (
        <p role="status" className="text-sm text-muted-foreground">{t("checking_identity_and_guest_readiness_f464b8c")}</p>
      ) : null}
      {identityGuidance ? (
        <div
          role={identityGuidance.tone === "warning" ? "alert" : "status"}
          className={
            identityGuidance.tone === "warning"
              ? "rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm"
              : "rounded-lg border border-border bg-muted/30 p-4 text-sm"
          }
        >
          <h2 className="font-medium">{identityGuidance.title}</h2>
          <p className="mt-1 text-muted-foreground">{identityGuidance.body}</p>
          <Button
            className="mt-3"
            size="sm"
            variant="outline"
            onClick={onOpenAccess}
          >{t("review_identity_access_ed811b8")}</Button>
        </div>
      ) : null}
      {provider === "imessage-photon" && botUsername && <div className="space-y-2"><Button variant="outline" onClick={() => { void copyTextToClipboard(botUsername).then(() => { setNumberCopied(true); setCopyError(null); }, () => setCopyError("Could not copy the number. Select it in the instructions below.")); }}>{numberCopied ? t("number_copied_11116c5") : t("copy_10caeb0", { botUsername: botUsername })}</Button>{copyError && <p role="alert" className="text-sm text-destructive">{copyError}</p>}</div>}
      {provider === "slack" ? (
        <>
          <ol className="list-decimal space-y-4 pl-5 text-sm">
            <li>{slackAccount?.status === "linked" ? <Button asChild variant="outline"><a href={providerUrl ?? "https://app.slack.com"} target="_blank" rel="noopener noreferrer">{slackAccount.dmChannelId ? t("open_your_slack_dm_0674789") : t("open_slack_eec851c")}<ExternalLink /></a></Button> : <>{t("open_a_channel_and_invite_da5d6b6")}{botMention}{t("if_needed_0a64c38")}</>}</li>
            <li>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3">
                <code>{slackTestMessage}</code>
                <Button size="sm" variant="ghost" onClick={() => {
                  void copyTextToClipboard(slackTestMessage).then(() => { setCommandCopied(true); setCommandCopyError(false); }, () => setCommandCopyError(true));
                }}><Copy className="size-4" />{commandCopied ? t("copied_8e3df45") : t("copy_message_26902ef")}</Button>
              </div>
              {slackAccount?.status !== "linked" && <p className="mt-2 text-muted-foreground">{t("select_the_bot_from_slack_s_mention_49b4640")}</p>}
            </li>
            <li>{t("continue_the_conversation_in_the_thread_12b3772")}</li>
          </ol>
          {commandCopyError && <p role="alert" className="text-sm text-destructive">{t("couldn_t_copy_select_and_copy_the_3a1a0ac")}</p>}
          <SetupWizardFooter onSaveExit={onSaveExit} disabled={pending}>
            <Button disabled={pending} onClick={onTest}>{pending && <Loader2 className="size-4 animate-spin" />}{t("done_e9b450d")}</Button>
          </SetupWizardFooter>
        </>
      ) : <>
      <ol className="list-decimal space-y-2 pl-5 text-sm">
        {instructions.map((item) => <li key={item}>{item}</li>)}
      </ol>
      <div className="flex flex-wrap gap-2">
        {providerUrl && (
          <Button asChild variant="outline">
            <a href={providerUrl} target="_blank" rel="noopener noreferrer">{t("open_79d37e2")}{providerNames[provider]} <ExternalLink />
            </a>
          </Button>
        )}
        <Button disabled={pending} onClick={onTest}>
          {pending && <Loader2 className="h-4 w-4 animate-spin" />}{t("i_ve_sent_the_test_message_4a0d0f7")}</Button>
      </div>
      </>}
    </div>
  );
}
