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
import { t, useTranslation } from "@/i18n";

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
  const { t } = useTranslation();
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => {
    setBreadcrumbs([{ label: t("apps.chatSetup.connectors", "Connectors"), href: "/apps" }, { label: t("apps.chatSetup.chooseConnection", "Choose connection") }]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs]);
  return (
      <div className="max-w-2xl space-y-6">
        <ChatSetupNavigation labels={provider === "slack" ? slackLabels ?? [t("apps.chatSetup.chooseActiveAgent", "Choose agent"), t("common.connect", "Connect")] : undefined} step={0} availableStep={0} onSelect={onChat} />
        <div>
          <h1 className="text-xl font-bold">{t("apps.ChatEndpointSetup.chooseHowToConnect")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("apps.ChatEndpointSetup.connectionPurposeQuestion", { provider: providerNames[provider] })}
          </p>
        </div>
        <div className="grid gap-3">
          <button
            type="button"
            className="flex items-center gap-4 rounded-xl border border-border p-4 text-left hover:bg-accent/40"
            onClick={onChat}
          >
            <AgentAvatar size={48} />
            <span>
              <span className="block text-sm font-semibold">
                {t("apps.ChatEndpointSetup.chatWithAgent")}
              </span>
              <span className="mt-1 block text-sm text-muted-foreground">
                {t("apps.ChatEndpointSetup.peoplePurpose", { provider: providerNames[provider] })}
              </span>
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
              <span className="block text-sm font-semibold">
                {t("apps.ChatEndpointSetup.useConnectionAsTool")}
              </span>
              <span className="mt-1 block text-sm text-muted-foreground">
                {t("apps.ChatEndpointSetup.useAsToolDescription", { provider: providerNames[provider] })}
              </span>
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
  const { t } = useTranslation();
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
      { label: t("apps.ChatEndpointSetup.connectors"), href: "/apps" },
      { label: t("apps.ChatEndpointSetup.connectChat") },
    ]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs]);

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
    [agentsQuery.data],
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
      if (provider === "slack" && !slackChoices.data) throw new Error("Slack setup is still loading. Try again.");
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
        title: t("apps.chatSetup.cantStartSetupTitle", "Couldn't start setup"),
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
    onError: () => pushToast({ title: t("apps.chatSetup.cantSwitchSlackTitle", "Couldn't switch Slack setup"), body: t("apps.chatSetup.tryAgainBody", "Try again."), tone: "error" }),
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
        title: t("apps.chatSetup.cantGenerateWebhookSecretTitle", "Couldn't generate webhook secret"),
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
        title: provider === "slack" ? t("apps.chatSetup.cantFinishSetupTitle", "Couldn't finish setup") : t("apps.chatSetup.testNotCompleteTitle", "Test not complete"),
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
      <p className="text-sm text-destructive">
        {t("apps.ChatEndpointSetup.providerNotSupported")}
      </p>
    );
  if (!selectedCompanyId)
    return (
      <p className="text-sm text-muted-foreground">
        {t("apps.ChatEndpointSetup.selectCompanyToConnect")}
      </p>
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
              <h1 className="text-xl font-bold">
                {t("apps.ChatEndpointSetup.whichAgentPrompt")}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("apps.ChatEndpointSetup.permanentAgentNotice")}
              </p>
            </div>
            {endpoint ? (
              <Input aria-label={t("apps.chatSetup.assignedAgentAria", "Assigned agent")} value={endpoint.assignedAgentName ?? selectedAgent?.name ?? agentId} readOnly />
            ) : <AgentSelect
              agents={activeAgents}
              value={agentId}
              onChange={setAgentId}
              placeholder={t("apps.ChatEndpointSetup.chooseActiveAgent")}
              emptyMessage={t("apps.ChatEndpointSetup.noActiveAgents")}
            />}
            {isSlack && (selectedAgent || endpoint) && <SlackSetupAdvanced>
              <SlackAppDetails value={slackDetails} readOnly={!slackDetailsEditable || agentStepBusy}
                onChange={app => setSlackDraft({ agentId, app })}
                onBlur={() => void persistSlackDetails().catch(() => {})} />
              {saveSlackDetails.error && <p role="alert" className="text-sm text-destructive">{t("apps.ChatEndpointSetup.cantSaveSlackDetails")}</p>}
              {slackChoices.data?.defaultMethod === "managed" && (!endpoint || endpoint.setup?.slackSetupMethod === "managed") && !endpoint?.setup?.slackRegistration && <Button
                variant="link" className="h-auto p-0 text-muted-foreground"
                disabled={agentStepBusy || !slackDetailsValidation.success}
                onClick={() => useOwnSlackApp.mutate()}
              >{t("apps.chatSetup.useYourOwnApp", "Use your own app")}</Button>}
            </SlackSetupAdvanced>}
            {isSlack && !endpoint && !slackChoices.data && ((slackChoicesView.kind === "error")
              ? <div role="alert" className="text-sm text-destructive">{t("apps.ChatEndpointSetup.cantLoadSlackSetup")} <Button variant="link" disabled={slackChoices.isFetching} onClick={() => void slackChoices.refetch()}>{t("common.retry")}</Button></div>
              : <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("apps.ChatEndpointSetup.loadingSlack")}</p>)}
            {provider === "github" && <GitHubAgentTrustWarning agent={selectedAgent} />}
            <SetupWizardFooter disabled={agentStepBusy || isSlack && !endpoint && Boolean(agentId) && !slackChoices.data} onSaveExit={() => void continueFromAgent(true)}>
              <Button
                disabled={!agentId || agentStepBusy || isSlack && (!slackDetailsValidation.success || !endpoint && !slackChoices.data)}
                onClick={() => void continueFromAgent(false)}
              >
                {createEndpoint.isPending && (
                  <Loader2 className="h-4 w-4 animate-spin" />
                )}
                {t("apps.ChatEndpointSetup.continueButton")}
              </Button>
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
                <p className="font-medium">{t("apps.chatSetup.connectionFailed", "Connection failed")}</p>
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
            <h1 className="text-xl font-bold">{t("apps.ChatEndpointSetup.testSpekoTitle")}</h1>
            <p className="text-sm text-muted-foreground">{t("apps.ChatEndpointSetup.testSpekoDescription")}</p>
            <NativeVoiceConversation companyId={endpoint.companyId} endpointId={endpoint.id} agentName={selectedAgent?.name ?? endpoint.assignedAgentName} />
            <SetupWizardFooter onSaveExit={() => navigate("/apps")}><Button disabled={testConnection.isPending} onClick={() => testConnection.mutate()}>{t("apps.chatSetup.verifyTestConversation", "Verify test conversation")}</Button></SetupWizardFooter>
          </div>
        )}
        {endpoint && step === tryStep && provider !== "speko" && (!automaticSlack || automaticSlackComplete) && (
          automaticSlack ? <div className="flex flex-col items-center gap-6 py-8 text-center">
            <AgentCharacter
              agent={selectedAgent ?? { id: endpoint.assignedAgentId, name: endpoint.assignedAgentName }}
              size={256} state="success" trackingScope="page"
              label={`${selectedAgent?.name ?? endpoint.assignedAgentName} avatar`}
            />
            <div className="flex flex-col items-center gap-3">
              <h1 className="flex items-center gap-2 text-2xl font-bold">
                <CheckCircle2 aria-hidden="true" className="size-6 text-(--status-task-done)" />
                {t("apps.ChatEndpointSetup.success")}
              </h1>
              <p className="flex flex-wrap items-center justify-center gap-2 text-base text-muted-foreground">
                <span>{t("apps.ChatEndpointSetup.talkToAgentInSlack", { agentName: selectedAgent?.name ?? endpoint.assignedAgentName })}</span>
                <img src="/brands/apps/slack.svg" alt="" aria-hidden="true" className="size-6" />
              </p>
              <Button asChild variant="link"><a href={slackConversationUrl(endpoint, identitySettled ? userId : null)} target="_blank" rel="noopener noreferrer">{t("apps.chatSetup.openSlack", "Open Slack")} <ExternalLink className="size-4" /></a></Button>
            </div>
            <Button disabled={testConnection.isPending} onClick={finishSetup}>
              {testConnection.isPending && <Loader2 className="size-4 animate-spin" />}{t("common.done")}
            </Button>
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
          <Button className="text-muted-foreground" variant="ghost" onClick={() => navigate("/apps")}>
            {t("apps.ChatEndpointSetup.saveAndExit")}
          </Button>
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
  const { t } = useTranslation();
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
      title: t("apps.ChatEndpointSetup.couldntCopyClipboard"),
      body: t("apps.ChatEndpointSetup.selectCopyManually"),
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
          t("apps.ChatEndpointSetup.endpointUnavailable")}
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
    endpoint.setup?.webhookUrl ?? "<paperclip-webhook-url>";
  const slackManifest = JSON.stringify(buildSlackAppManifest({
    app: { appName: slackAppName, botName: slackBotName, command: slackCommand }, agentName,
    webhookUrl: slackWebhookUrl,
    ...(automaticSlack && endpoint.setup?.slackOAuthCallbackUri ? { redirectUri: endpoint.setup.slackOAuthCallbackUri } : {}),
  }), null, 2);
  const slackCreateUrl = `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(slackManifest)}`;
  useEffect(() => setManifestCopied(false), [slackManifest]);
  const teamsClientId =
    credentials.clientId?.trim() || "<application-client-id>";
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
                  description: "Show the active Paperclip task status",
                },
                {
                  title: "/new",
                  description: "Start a new Paperclip task in this chat",
                },
                {
                  title: "/close",
                  description: "Close the active chat conversation",
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
          <h1 className="text-xl font-bold">{t("apps.ChatEndpointSetup.discordConnectTitle", { agentName })}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {repairing
              ? t("apps.ChatEndpointSetup.discordReconnectDescription")
              : t("apps.ChatEndpointSetup.discordCreateDescription")}
          </p>
        </div>
      <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>
            {t("apps.ChatEndpointSetup.discordStepApp")}
          </li>
          <li>
            {t("apps.ChatEndpointSetup.discordStepBot")}
          </li>
          <li>
            {t("apps.ChatEndpointSetup.discordStepServer")}
          </li>
          <li>
            {t("apps.ChatEndpointSetup.discordStepInstall")}
          </li>
        </ol>
        <Button
          variant="outline"
          onClick={() =>
            openProviderSetup("https://discord.com/developers/applications")
          }
        >
          {t("apps.ChatEndpointSetup.openDiscordPortal")} <ExternalLink />
        </Button>
        {field("applicationId", t("apps.ChatEndpointSetup.applicationId"), "text")}
        {field("guildId", t("apps.ChatEndpointSetup.serverId"), "text")}
        {field("botToken", t("apps.ChatEndpointSetup.botToken"))}
        {installUrl && (
          <Button asChild variant="outline">
            <a href={installUrl} target="_blank" rel="noreferrer">
              {t("apps.ChatEndpointSetup.installBotInServer")} <ExternalLink />
            </a>
          </Button>
        )}
        <p className="text-sm text-muted-foreground">
          {t("apps.ChatEndpointSetup.discordInstallPermissions")}
        </p>
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
          {repairing ? t("apps.ChatEndpointSetup.discordReconnectButton") : t("apps.ChatEndpointSetup.discordConnectButton")}
        </Button>
      </div>
    );
  }
  if (provider === "telegram")
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-xl font-bold">{t("apps.ChatEndpointSetup.telegramCreateTitle", { agentName })}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {repairing
              ? t("apps.ChatEndpointSetup.telegramReconnectDescription")
              : t("apps.ChatEndpointSetup.telegramCreateDescription")}
          </p>
        </div>
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>
            {t("apps.ChatEndpointSetup.telegramSendNewBot")} <code>/newbot</code>.
          </li>
          <li>{t("apps.ChatEndpointSetup.telegramEnterName")}</li>
          <li>
            {t("apps.ChatEndpointSetup.telegramChooseUsername")} <code>bot</code>.
          </li>
        </ol>
        <p className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          {t("apps.ChatEndpointSetup.telegramPrivacyNote")}{" "}
          <code>/task@bot_username &lt;request&gt;</code>, {t("apps.ChatEndpointSetup.telegramReplyNote")}
        </p>
        <Button
          variant="outline"
          onClick={() => openProviderSetup("https://t.me/BotFather")}
        >
          {t("apps.ChatEndpointSetup.openBotFather")} <ExternalLink />
        </Button>
        {field("botToken", t("apps.ChatEndpointSetup.botToken"))}
        {(!endpoint.setup?.webhookUrl || automaticSlack && !endpoint.setup?.slackOAuthCallbackUri?.startsWith("https://")) && (
          <p className="text-sm text-destructive">
            {t("apps.ChatEndpointSetup.telegramHttpsRequired")}
          </p>
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
          {repairing ? t("apps.ChatEndpointSetup.telegramReconnectButton") : t("apps.ChatEndpointSetup.telegramConnectButton")}
        </Button>
      </div>
    );
  if (provider === "microsoft-teams")
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-xl font-bold">
            {t("apps.ChatEndpointSetup.teamsConnectTitle", { agentName })}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {repairing
              ? t("apps.ChatEndpointSetup.teamsReconnectDescription")
              : t("apps.ChatEndpointSetup.teamsCreateDescription")}
          </p>
        </div>
        <p className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          {t("apps.ChatEndpointSetup.teamsRequirements")}
        </p>
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>
            {t("apps.ChatEndpointSetup.teamsStepEntra")}
          </li>
          <li>
            {t("apps.ChatEndpointSetup.teamsStepAzure")}
          </li>
          <li>
            {t("apps.ChatEndpointSetup.teamsStepPortal")}
          </li>
        </ol>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <a
              href="https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade"
              target="_blank"
              rel="noreferrer"
            >
              {t("apps.ChatEndpointSetup.openMicrosoftEntra")} <ExternalLink />
            </a>
          </Button>
          <Button asChild variant="outline">
            <a
              href="https://portal.azure.com/#create/Microsoft.AzureBot"
              target="_blank"
              rel="noreferrer"
            >
              {t("apps.ChatEndpointSetup.createAzureBot")} <ExternalLink />
            </a>
          </Button>
          <Button asChild variant="outline">
            <a
              href="https://dev.teams.microsoft.com/apps"
              target="_blank"
              rel="noreferrer"
            >
              {t("apps.ChatEndpointSetup.openTeamsPortal")} <ExternalLink />
            </a>
          </Button>
        </div>
        {endpointValue(
          t("apps.ChatEndpointSetup.messagingEndpoint"),
          endpoint.setup?.messagingEndpoint,
        )}
        {field("clientId", t("apps.ChatEndpointSetup.appClientId"), "text")}
        {field("tenantId", t("apps.ChatEndpointSetup.directoryTenantId"), "text")}
        {field("clientSecret", t("apps.ChatEndpointSetup.clientSecretValue"))}
        <section className="space-y-3 rounded-lg border border-border p-4">
          <div>
            <h2 className="text-sm font-semibold">
              {t("apps.ChatEndpointSetup.portalFieldMap")}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("apps.ChatEndpointSetup.portalFieldMapHint")}
            </p>
          </div>
          <ol className="list-decimal space-y-3 pl-5 text-sm">
            <li>
              <strong>{t("apps.ChatEndpointSetup.microsoftEntraAdminCenter")}</strong>: {t("apps.ChatEndpointSetup.portalSelect")} <strong>{t("apps.ChatEndpointSetup.newRegistration")}</strong>, {t("apps.ChatEndpointSetup.portalChoose")} <strong>{t("apps.ChatEndpointSetup.accountsInThisOrganizational")}</strong>, {t("apps.ChatEndpointSetup.portalThenSelect")} <strong>{t("apps.ChatEndpointSetup.register")}</strong>. {t("apps.ChatEndpointSetup.portalCopy")} <strong>{t("apps.ChatEndpointSetup.applicationClientId")}</strong> {t("apps.ChatEndpointSetup.portalAnd")} <strong>{t("apps.ChatEndpointSetup.directoryTenantId")}</strong>. {t("apps.ChatEndpointSetup.portalUnder")} <strong>{t("apps.ChatEndpointSetup.certificatesSecretsClientSecrets")}</strong>, {t("apps.ChatEndpointSetup.portalSelect")} <strong>{t("apps.ChatEndpointSetup.newClientSecret")}</strong> {t("apps.ChatEndpointSetup.portalAndCopyIts")} <strong>{t("apps.ChatEndpointSetup.value")}</strong>, {t("apps.ChatEndpointSetup.portalNotItsSecretId")}
            </li>
            <li>
              <strong>{t("apps.ChatEndpointSetup.azureCreateAzureBot")}</strong>: {t("apps.ChatEndpointSetup.portalSet")} <strong>{t("apps.ChatEndpointSetup.microsoftAppId")}</strong> {t("apps.ChatEndpointSetup.portalTo")} <strong>{t("apps.ChatEndpointSetup.singleTenant")}</strong>, {t("apps.ChatEndpointSetup.portalSet")} <strong>{t("apps.ChatEndpointSetup.creationType")}</strong> {t("apps.ChatEndpointSetup.portalTo")} <strong>{t("apps.ChatEndpointSetup.useExistingAppRegistration")}</strong>{t("apps.ChatEndpointSetup.teamsEnterAndOpen")} <strong>{t("apps.ChatEndpointSetup.settingsConfiguration")}</strong> {t("apps.ChatEndpointSetup.teamsAndPaste")} <strong>{t("apps.ChatEndpointSetup.messagingEndpoint")}</strong>; {t("apps.ChatEndpointSetup.teamsThenOpen")} <strong>{t("apps.ChatEndpointSetup.settingsChannels")}</strong> {t("apps.ChatEndpointSetup.teamsAndEnable")} <strong>{t("apps.ChatEndpointSetup.microsoftTeams")}</strong>.
            </li>
            <li>
              <strong>{t("apps.ChatEndpointSetup.teamsDeveloperPortalApps")}</strong>: {t("apps.ChatEndpointSetup.portalSelect")} <strong>{t("apps.ChatEndpointSetup.newApp")}</strong>. {t("apps.ChatEndpointSetup.portalUnder")} <strong>{t("apps.ChatEndpointSetup.configureAppFeaturesBot")}</strong>{t("apps.ChatEndpointSetup.teamsAddBot")} <strong>{t("apps.ChatEndpointSetup.personal")}</strong>, <strong>{t("apps.ChatEndpointSetup.team")}</strong>, {t("apps.ChatEndpointSetup.portalAnd")} <strong>{t("apps.ChatEndpointSetup.groupChat")}</strong> {t("apps.ChatEndpointSetup.teamsScopes")} <strong>{t("apps.ChatEndpointSetup.configurePermissions")}</strong>{t("apps.ChatEndpointSetup.teamsAddRsc")} <strong>{t("apps.ChatEndpointSetup.application")}</strong> {t("apps.ChatEndpointSetup.teamsRscRest")}
            </li>
            <li>
              <strong>{t("apps.ChatEndpointSetup.microsoftTeamsAppsManage")}</strong>: {t("apps.ChatEndpointSetup.portalSelect")} <strong>{t("apps.ChatEndpointSetup.uploadAnAppUpload")}</strong>{t("apps.ChatEndpointSetup.teamsUploadRest")}
            </li>
          </ol>
        </section>
        <label className="grid gap-2 text-sm font-medium">
          {t("apps.ChatEndpointSetup.teamsManifestBlock")}
          <Textarea
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
              ? t("apps.ChatEndpointSetup.manifestSettingsCopied")
              : t("apps.ChatEndpointSetup.copyManifestSettings")}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          {t("apps.ChatEndpointSetup.teamsManifestNote")}
        </p>
        <p className="text-sm text-muted-foreground">
          {t("apps.ChatEndpointSetup.teamsNoSsoA")} <code>webApplicationInfo</code> {t("apps.ChatEndpointSetup.teamsNoSsoB")}
        </p>
        <p className="text-sm text-muted-foreground">
          {t("apps.ChatEndpointSetup.teamsRscPermissions")}
        </p>
        <p className="text-sm text-muted-foreground">
          {t("apps.ChatEndpointSetup.teamsChatScope")} <code>supportsFiles: true</code>{" "}
          {t("apps.ChatEndpointSetup.teamsFilesNote")}
        </p>
        {!endpoint.setup?.messagingEndpoint && (
          <p className="text-sm text-destructive">
            {t("apps.ChatEndpointSetup.teamsHttpsRequired")}
          </p>
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
            ? t("apps.ChatEndpointSetup.teamsReconnectButton")
            : t("apps.ChatEndpointSetup.teamsVerifyButton")}
        </Button>
      </div>
    );
  if (provider === "github")
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-xl font-bold">
            {repairing
              ? t("apps.ChatEndpointSetup.githubReconnectTitle")
              : t("apps.ChatEndpointSetup.githubCreateTitle")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {repairing
              ? t("apps.ChatEndpointSetup.githubReconnectDescription")
              : t("apps.ChatEndpointSetup.githubCreateDescription")}
          </p>
        </div>
        {!repairing && (
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            <li>
              {t("apps.ChatEndpointSetup.githubStepCreate")}
            </li>
            <li>
              {t("apps.ChatEndpointSetup.ghKeep")} <strong>{t("apps.ChatEndpointSetup.webhooksActive")}</strong> {t("apps.ChatEndpointSetup.ghOn")} <strong>{t("apps.ChatEndpointSetup.enableSslVerification")}</strong> {t("apps.ChatEndpointSetup.ghSelected")}
            </li>
            <li>
              {t("apps.ChatEndpointSetup.ghUnderRepo")} <strong>{t("apps.ChatEndpointSetup.issues")}</strong> {t("apps.ChatEndpointSetup.portalAnd")} <strong>{t("apps.ChatEndpointSetup.pullRequests")}</strong> {t("apps.ChatEndpointSetup.portalTo")} <strong>{t("apps.ChatEndpointSetup.readWrite")}</strong>{t("apps.ChatEndpointSetup.ghLeaveDefault")}
            </li>
            <li>
              {t("apps.ChatEndpointSetup.ghSubscribe")} <strong>{t("apps.ChatEndpointSetup.issueComment")}</strong> (<code>issue_comment</code>{t("apps.ChatEndpointSetup.closeParenComma")} <strong>{t("apps.ChatEndpointSetup.pullRequestReviewComment")}</strong> (<code>pull_request_review_comment</code>{t("apps.ChatEndpointSetup.closeParenDot")} {t("apps.ChatEndpointSetup.ghGitHubSends")} <code>installation</code> {t("apps.ChatEndpointSetup.portalAnd")} <code>installation_repositories</code> {t("apps.ChatEndpointSetup.ghAutoEvents")}
            </li>
            <li>
              {t("apps.ChatEndpointSetup.chooseVerb")} <strong>{t("apps.ChatEndpointSetup.onlyOnThisAccount")}</strong>{t("apps.ChatEndpointSetup.ghCreateSpec")}
            </li>
          </ol>
        )}
        {endpointValue(
          t("apps.ChatEndpointSetup.homepageUrl"),
          publicOrigin(endpoint.setup?.webhookUrl),
        )}
        {endpointValue(t("apps.ChatEndpointSetup.webhookUrl"), endpoint.setup?.webhookUrl)}
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
          {repairing ? t("apps.ChatEndpointSetup.githubOpenSettings") : t("apps.ChatEndpointSetup.githubOpenNewForm")}{" "}
          <ExternalLink />
        </Button>
        {field("appId", t("apps.ChatEndpointSetup.githubAppId"), "text")}
        <div className="grid gap-2 text-sm font-medium">
          <label htmlFor="github-private-key">{t("apps.ChatEndpointSetup.privateKeyPem")}</label>
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
                privateKeyVisible ? t("apps.ChatEndpointSetup.hidePrivateKey") : t("apps.ChatEndpointSetup.showPrivateKey")
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
            aria-label={t("apps.ChatEndpointSetup.choosePrivateKeyFile")}
            onChange={loadPrivateKeyFile}
          />
          <div>
            <Button
              type="button"
              variant="outline"
              onClick={() => privateKeyFileInputRef.current?.click()}
            >
              {t("apps.ChatEndpointSetup.choosePemFile")}
            </Button>
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
            >
              {t("apps.ChatEndpointSetup.readingPrivateKey")}
            </p>
          ) : privateKeyFileLoaded ? (
            <p
              role="status"
              aria-live="polite"
              className="text-sm text-muted-foreground"
            >
              {t("apps.ChatEndpointSetup.privateKeyLoaded")}
            </p>
          ) : null}
        </div>
        <div className="grid gap-2">
          <p className="text-sm font-medium">{t("apps.ChatEndpointSetup.webhookSecret")}</p>
          {generatedWebhookSecret ? (
            <>
              <Input
                aria-label={t("apps.ChatEndpointSetup.generatedWebhookSecret")}
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
                    ? t("apps.ChatEndpointSetup.webhookSecretCopied")
                    : webhookSecretCopy.failed
                      ? t("apps.ChatEndpointSetup.webhookSecretCopyFailed")
                      : t("apps.ChatEndpointSetup.copyWebhookSecret")}
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">
                {t("apps.ChatEndpointSetup.copyWebhookSecretNow")}
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              {endpoint.setup?.webhookSecretConfigured
                ? t("apps.ChatEndpointSetup.webhookSecretConfigured")
                : t("apps.ChatEndpointSetup.generateSecretFirst")}
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
                ? t("apps.ChatEndpointSetup.regenerateWebhookSecret") : t("apps.ChatEndpointSetup.generateWebhookSecret")}
            </Button>
          </div>
          {endpoint.setup?.webhookSecretConfigured && (
            <p className="text-sm text-muted-foreground">
              {endpoint.providerAccountId || endpoint.botExternalId
                ? t("apps.ChatEndpointSetup.regenerateInvalidates")
                : t("apps.ChatEndpointSetup.generateReplacesPrevious")}
            </p>
          )}
          {endpoint.setup?.webhookSecretConfigured && (
            <p
              className={`text-sm ${endpoint.setup.webhookVerifiedAt ? "text-foreground" : "text-muted-foreground"}`}
            >
              {endpoint.setup.webhookVerifiedAt
                ? t("apps.ChatEndpointSetup.githubWebhookVerified")
                : t("apps.ChatEndpointSetup.waitingWebhookPing")}
            </p>
          )}
        </div>
        {(!endpoint.setup?.webhookUrl || automaticSlack && !endpoint.setup?.slackOAuthCallbackUri?.startsWith("https://")) && (
          <p className="text-sm text-destructive">
            {t("apps.ChatEndpointSetup.githubHttpsRequired")}
          </p>
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
          {repairing ? t("apps.ChatEndpointSetup.githubReconnectButton") : t("apps.ChatEndpointSetup.githubConnectButton")}
        </Button>
      </div>
    );
  const slackRequestUrlInstructions = <ol className="list-decimal space-y-2 pl-5 text-sm">
      <li><a className="underline underline-offset-4" href={endpoint.setup?.slackRegistration?.appId ? `https://api.slack.com/apps/${encodeURIComponent(endpoint.setup.slackRegistration.appId)}/event-subscriptions` : "https://api.slack.com/apps"} target="_blank" rel="noopener noreferrer">{t("apps.ChatEndpointSetup.slackOpenAppSettings")} <ExternalLink className="inline size-3" /></a> {t("apps.ChatEndpointSetup.slackAndChoose")} <strong>{slackApp.appName}</strong>.</li>
      <li>{t("apps.ChatEndpointSetup.chooseVerb")} <strong>{t("apps.ChatEndpointSetup.eventSubscriptions")}</strong>.</li>
      <li>{t("apps.ChatEndpointSetup.slackBeside")} <strong>{t("apps.ChatEndpointSetup.requestUrl")}</strong>, {t("apps.ChatEndpointSetup.slackClick")} <strong>{t("apps.ChatEndpointSetup.retry")}</strong> {t("apps.ChatEndpointSetup.slackIfNot")}</li>
    </ol>;
  if (slackStage === "finish")
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-xl font-bold">{automaticSlack ? t("apps.ChatEndpointSetup.slackSendMessageTitle") : t("apps.ChatEndpointSetup.slackVerifyTitle")}</h1>
          {!automaticSlack && <p className="mt-1 text-sm text-muted-foreground">{t("apps.ChatEndpointSetup.slackConfirmReach")}</p>}
        </div>
        {automaticSlack ? <Button asChild variant="outline"><a href={slackConversationUrl(endpoint, identitySettled ? userId : null)} target="_blank" rel="noopener noreferrer">{t("apps.ChatEndpointSetup.openSlack")} <ExternalLink className="size-4" /></a></Button> : slackRequestUrlInstructions}
        {endpoint.setup?.webhookVerifiedAt ? (
          <p role="status" className="flex items-center gap-2 text-sm">
            <CheckCircle2 className="size-4 text-(--status-task-done)" />
            {pending ? (automaticSlack ? t("apps.ChatEndpointSetup.slackWorkingFinishing") : t("apps.ChatEndpointSetup.slackWorkingOpening")) : t("apps.ChatEndpointSetup.slackWorking")}
          </p>
        ) : slackVerificationError ? (
          <p role="alert" className="text-sm text-destructive">{t("apps.ChatEndpointSetup.slackVerifyFailed")}</p>
        ) : (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> {automaticSlack ? t("apps.ChatEndpointSetup.waitingForMessage") : t("apps.ChatEndpointSetup.waitingForSlack")}
          </p>
        )}
        <SlackSetupAdvanced label={automaticSlack ? t("apps.ChatEndpointSetup.slackDidntWork") : t("apps.ChatEndpointSetup.troubleshooting")}>
          {automaticSlack && slackRequestUrlInstructions}
          <p className="text-muted-foreground">{t("apps.ChatEndpointSetup.slackTroubleshoot")}</p>
          {endpointValue(t("apps.ChatEndpointSetup.webhookUrl"), endpoint.setup?.webhookUrl)}
        </SlackSetupAdvanced>
        <div className="flex items-center justify-between gap-3">
          <Button variant="ghost" className="text-muted-foreground" onClick={() => navigate("/apps")}>{t("apps.ChatEndpointSetup.saveAndExit")}</Button>
          {(!automaticSlack || endpoint.setup?.webhookVerifiedAt) && <Button disabled={pending || !endpoint.setup?.webhookVerifiedAt} onClick={() =>
            endpoint.setup?.step === "provider_setup" ? onAction("verify") : onSlackVerificationContinue()
          }>
            {pending && <Loader2 className="size-4 animate-spin" />}
            {t("apps.ChatEndpointSetup.continueButton")}
          </Button>}
        </div>
      </div>
    );

  return (
    <div className="space-y-5">
      {(!endpoint.setup?.webhookUrl || automaticSlack && !endpoint.setup?.slackOAuthCallbackUri?.startsWith("https://")) && (
        <div role="alert" className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4">
          <AlertTriangle className="size-5 shrink-0 text-destructive" />
          <div className="space-y-1">
            <p className="text-sm font-semibold">{t("apps.ChatEndpointSetup.publicHttpsRequired")}</p>
            <p className="text-sm">
              {t("apps.ChatEndpointSetup.slackHttpsBody")}
            </p>
            <a
              href="https://docs.paperclip.ing/reference/deploy/https/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm underline underline-offset-4"
            >
              {t("apps.ChatEndpointSetup.learnHttps")}
            </a>
          </div>
        </div>
      )}
      <div>
        <h1 className="text-xl font-bold">{endpoint.setup?.slackSetupMethod === "managed" ? t("apps.ChatEndpointSetup.connectToSlack") : slackStage === "app" ? automaticSlack ? t("apps.ChatEndpointSetup.appConfigToken") : t("apps.ChatEndpointSetup.createSlackAppTitle") : automaticSlack ? t("apps.ChatEndpointSetup.installSlackApp") : t("apps.ChatEndpointSetup.addSlackCredentials")}</h1>
        {repairing && !automaticSlack && (
          <p className="mt-1 text-sm text-muted-foreground">
            {t("apps.ChatEndpointSetup.slackReconnectDescription")}
          </p>
        )}
      </div>
      <div hidden={slackStage !== "app" || automaticSlack} className="space-y-5">
        <div className="space-y-3 text-sm">
          <div className="flex justify-end">
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="link" className="h-auto p-0 text-xs text-muted-foreground underline underline-offset-4">
                  {t("apps.ChatEndpointSetup.viewSlackManifest")}
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-2xl">
                <DialogHeader>
                  <DialogTitle>{t("apps.ChatEndpointSetup.slackManifestTitle")}</DialogTitle>
                  <DialogDescription>
                    {t("apps.ChatEndpointSetup.slackManifestDescription")}
                  </DialogDescription>
                </DialogHeader>
                <Textarea
                  aria-label={t("apps.ChatEndpointSetup.slackManifestTitle")}
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
                    {manifestCopied ? t("apps.ChatEndpointSetup.manifestCopied") : t("apps.ChatEndpointSetup.copyManifest")}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </div>
        {!automaticSlack && <div className="flex flex-wrap items-center justify-between gap-3 pt-3">
          <Button variant="ghost" className="text-muted-foreground" onClick={() => void saveSlackAndExit()}>
            {t("apps.ChatEndpointSetup.saveAndExit")}
          </Button>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            <Button variant="outline" disabled={openingSlackApp || !endpoint.setup?.webhookUrl || !slackValidation.success} onClick={onSlackAppCreated}>
              {t("apps.ChatEndpointSetup.alreadyCreatedApp")}
            </Button>
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
              >
                {t("apps.ChatEndpointSetup.createSlackAppButton")} <ExternalLink />
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
        <p className="text-sm">
          {t("apps.ChatEndpointSetup.findTwoSecrets")}
        </p>
        {slackCredentialsSaved && !repairing && (
          <p className="text-sm text-muted-foreground">{t("apps.ChatEndpointSetup.credentialsSaved")}</p>
        )}
        <section className="space-y-3">
          <h2 className="text-sm font-semibold"><label htmlFor="slack-bot-token">{t("apps.ChatEndpointSetup.botUserOauthToken")}</label></h2>
          <ul id="slack-bot-token-help" className="list-disc space-y-1 pl-5 text-sm">
            <li>
              <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">
                {t("apps.ChatEndpointSetup.slackOpenAppSettings")} <ExternalLink className="inline size-3" />
              </a> {t("apps.ChatEndpointSetup.slackAndChoose")} <strong>{slackApp.appName}</strong>.
            </li>
            <li>{t("apps.ChatEndpointSetup.chooseVerb")} <strong>{t("apps.ChatEndpointSetup.oauthPermissions")}</strong></li>
            <li>{t("apps.ChatEndpointSetup.copyPasteYour")} <strong>{t("apps.ChatEndpointSetup.botOauthToken")}</strong></li>
          </ul>
          <Input
            id="slack-bot-token"
            type="password"
            placeholder={slackCredentialsSaved ? t("apps.ChatEndpointSetup.savedLeaveBlank") : undefined}
            value={credentials.botToken ?? ""}
            aria-invalid={slackBotTokenInvalid || undefined}
            aria-describedby={`slack-bot-token-help${slackBotTokenInvalid ? " slack-bot-token-warning" : ""}`}
            onChange={(event) => setCredentials({ ...credentials, botToken: event.target.value })}
          />
          {slackBotTokenInvalid && (
            <p id="slack-bot-token-warning" role="alert" className="text-sm text-destructive">
              {t("apps.ChatEndpointSetup.slackMustStart")} <code>xoxb-</code>. {t("apps.ChatEndpointSetup.slackCopyItFrom")} <strong>{t("apps.ChatEndpointSetup.oauthPermissions")}</strong>.
            </p>
          )}
        </section>
        <section className="space-y-3">
          <h2 className="text-sm font-semibold"><label htmlFor="slack-signing-secret">{t("apps.ChatEndpointSetup.signingSecret")}</label></h2>
          <ul id="slack-signing-secret-help" className="list-disc space-y-1 pl-5 text-sm">
            <li>
              <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">
                {t("apps.ChatEndpointSetup.slackOpenAppSettings")} <ExternalLink className="inline size-3" />
              </a> {t("apps.ChatEndpointSetup.slackAndChoose")} <strong>{slackApp.appName}</strong>.
            </li>
            <li>{t("apps.ChatEndpointSetup.chooseVerb")} <strong>{t("apps.ChatEndpointSetup.basicInformation")}</strong></li>
            <li>{t("apps.ChatEndpointSetup.copyPasteYour")} <strong>{t("apps.ChatEndpointSetup.signingSecret")}</strong></li>
          </ul>
          <Input
            id="slack-signing-secret"
            type="password"
            placeholder={slackCredentialsSaved ? t("apps.ChatEndpointSetup.savedLeaveBlank") : undefined}
            value={credentials.signingSecret ?? ""}
            aria-invalid={slackSigningSecretHasTokenPrefix || undefined}
            aria-describedby={`slack-signing-secret-help${slackSigningSecretHasTokenPrefix ? " slack-signing-secret-warning" : ""}`}
            onChange={(event) => setCredentials({ ...credentials, signingSecret: event.target.value })}
          />
          {slackSigningSecretHasTokenPrefix && (
            <p id="slack-signing-secret-warning" role="alert" className="text-sm text-destructive">
              {t("apps.ChatEndpointSetup.slackUseThe")} <strong>{t("apps.ChatEndpointSetup.signingSecret")}</strong>, {t("apps.ChatEndpointSetup.slackNotAppToken")}
            </p>
          )}
        </section>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button variant="ghost" className="text-muted-foreground" onClick={() => navigate("/apps")}>
            {t("apps.ChatEndpointSetup.saveAndExit")}
          </Button>
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
            {continueWithSavedSlackCredentials ? t("apps.ChatEndpointSetup.continueButton") : repairing || slackCredentialsSaved ? t("apps.ChatEndpointSetup.reconnectSlackApp") : t("apps.ChatEndpointSetup.connectSlackApp")}
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
  const { t } = useTranslation();
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
    provider === "imessage-photon" ? t("apps.ChatEndpointSetup.freshPhoton") : provider === "telegram"
      ? t("apps.ChatEndpointSetup.freshTelegram")
      : provider === "github"
        ? t("apps.ChatEndpointSetup.freshGithub")
        : provider === "microsoft-teams"
          ? t("apps.ChatEndpointSetup.freshTeams")
          : t("apps.ChatEndpointSetup.freshDefault");
  const identityGuidance = provider === "slack" ? null : provider === "imessage-photon" && principalsLoaded && (identities.length === 0 || unlinkedIdentities.length > 0)
    ? { tone: "info" as const, title: t("apps.ChatEndpointSetup.identityLinkMessagesTitle"), body: t("apps.ChatEndpointSetup.identityLinkMessagesBody") }
    : principalsFailed
    ? {
        tone: "warning" as const,
        title: t("apps.ChatEndpointSetup.identityCheckFailedTitle"),
        body: t("apps.ChatEndpointSetup.identityReviewFresh", { instruction: freshConversationInstruction }),
      }
    : !principalsLoaded || guestIsolationState === "loading"
      ? null
      : identities.length === 0
        ? guestIsolationState === "disabled"
          ? {
              tone: "warning" as const,
              title: t("apps.ChatEndpointSetup.linkTestedAccount"),
              body:
                provider === "telegram"
                  ? t("apps.ChatEndpointSetup.telegramTapStartDisabled")
                  : t("apps.ChatEndpointSetup.identityFirstMessageDisabled", { provider: providerNames[provider], agentName, instruction: freshConversationInstruction }),
            }
          : {
              tone: "info" as const,
              title: t("apps.ChatEndpointSetup.firstMessageIdentifies"),
              body:
                provider === "telegram"
                  ? t("apps.ChatEndpointSetup.telegramTapStartInfo")
                  : t("apps.ChatEndpointSetup.identityUnlinkedGuest", { instruction: freshConversationInstruction }),
            }
        : unlinkedIdentities.length > 0
          ? guestIsolationState === "disabled"
            ? {
                tone: "warning" as const,
                title: t("apps.ChatEndpointSetup.linkTestedAccount"),
                body: t("apps.ChatEndpointSetup.identityObservedDisabled", { agentName, instruction: freshConversationInstruction }),
              }
            : {
                tone: "info" as const,
                title: t("apps.ChatEndpointSetup.unlinkedIdentityTitle"),
                body: t("apps.ChatEndpointSetup.identityUnlinkedInfo", { instruction: freshConversationInstruction }),
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
      photonAllocation === "shared" ? t("apps.ChatEndpointSetup.photonSharedInstruction") : t("apps.ChatEndpointSetup.photonDedicatedInstruction", { number: botUsername ?? botLabel ?? t("apps.ChatEndpointSetup.dedicatedNumber") }),
      t("apps.ChatEndpointSetup.photonLinkSender"),
      t("apps.ChatEndpointSetup.photonWaitReply"),
      ...(photonAllocation === "shared" ? [t("apps.ChatEndpointSetup.photonSharedDmOnly")] : [t("apps.ChatEndpointSetup.photonGroupInstructions")]),
    ] : provider === "discord"
      ? [
          t("apps.ChatEndpointSetup.discordOpenChannel"),
          t("apps.ChatEndpointSetup.discordMention", { bot: botMention }),
          t("apps.ChatEndpointSetup.discordReplyThread", { agentName }),
        ]
      : provider === "telegram"
        ? [
            t("apps.ChatEndpointSetup.telegramOpenChat"),
            t("apps.ChatEndpointSetup.telegramTapStart"),
            t("apps.ChatEndpointSetup.telegramSendSample"),
          ]
        : provider === "github"
          ? [
              t("apps.ChatEndpointSetup.githubOpenItem"),
              t("apps.ChatEndpointSetup.githubMention", { bot: botMention }),
              t("apps.ChatEndpointSetup.githubAddComment"),
            ]
          : provider === "microsoft-teams"
            ? [
                t("apps.ChatEndpointSetup.teamsOpenChannel"),
                t("apps.ChatEndpointSetup.teamsMention", { bot: botMention }),
                t("apps.ChatEndpointSetup.teamsReplyPost"),
              ]
            : [
                t("apps.ChatEndpointSetup.defaultInvite", { bot: botMention }),
                t("apps.ChatEndpointSetup.defaultMention", { bot: botMention }),
                t("apps.ChatEndpointSetup.defaultReplyThread", { agentName }),
              ];
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold">
          {t("apps.ChatEndpointSetup.tryAgentIn", { agentName, provider: providerNames[provider] })}
        </h1>
        {provider !== "slack" && <p className="mt-1 text-sm text-muted-foreground">
          {t("apps.ChatEndpointSetup.completeRealConversation")}
        </p>}
      </div>
      {provider !== "slack" && (!principalsLoaded || guestIsolationState === "loading") &&
      !principalsFailed ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("apps.ChatEndpointSetup.checkingIdentity")}
        </p>
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
          >
            {t("apps.ChatEndpointSetup.reviewIdentityAccess")}
          </Button>
        </div>
      ) : null}
      {provider === "imessage-photon" && botUsername && <div className="space-y-2"><Button variant="outline" onClick={() => { void copyTextToClipboard(botUsername).then(() => { setNumberCopied(true); setCopyError(null); }, () => setCopyError("Could not copy the number. Select it in the instructions below.")); }}>{numberCopied ? "Number copied" : `Copy ${botUsername}`}</Button>{copyError && <p role="alert" className="text-sm text-destructive">{copyError}</p>}</div>}
      {provider === "slack" ? (
        <>
          <ol className="list-decimal space-y-4 pl-5 text-sm">
            <li>{slackAccount?.status === "linked" ? <Button asChild variant="outline"><a href={providerUrl ?? "https://app.slack.com"} target="_blank" rel="noopener noreferrer">{slackAccount.dmChannelId ? t("apps.ChatEndpointSetup.openSlackDm") : t("apps.ChatEndpointSetup.openSlack")}<ExternalLink /></a></Button> : <>{t("apps.ChatEndpointSetup.defaultInvite", { bot: botMention })}</>}</li>
            <li>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3">
                <code>{slackTestMessage}</code>
                <Button size="sm" variant="ghost" onClick={() => {
                  void copyTextToClipboard(slackTestMessage).then(() => { setCommandCopied(true); setCommandCopyError(false); }, () => setCommandCopyError(true));
                }}><Copy className="size-4" />{commandCopied ? t("common.copied") : t("apps.ChatEndpointSetup.copyMessage")}</Button>
              </div>
              {slackAccount?.status !== "linked" && <p className="mt-2 text-muted-foreground">{t("apps.ChatEndpointSetup.selectBotFromSuggestions")}</p>}
            </li>
            <li>{t("apps.ChatEndpointSetup.continueInThread")}</li>
          </ol>
          {commandCopyError && <p role="alert" className="text-sm text-destructive">{t("apps.ChatEndpointSetup.couldntCopyCommand")}</p>}
          <SetupWizardFooter onSaveExit={onSaveExit} disabled={pending}>
            <Button disabled={pending} onClick={onTest}>{pending && <Loader2 className="size-4 animate-spin" />}{t("common.done")}</Button>
          </SetupWizardFooter>
        </>
      ) : <>
      <ol className="list-decimal space-y-2 pl-5 text-sm">
        {instructions.map((item) => <li key={item}>{item}</li>)}
      </ol>
      <div className="flex flex-wrap gap-2">
        {providerUrl && (
          <Button asChild variant="outline">
            <a href={providerUrl} target="_blank" rel="noopener noreferrer">
              {t("apps.ChatEndpointSetup.openProvider", { provider: providerNames[provider] })} <ExternalLink />
            </a>
          </Button>
        )}
        <Button disabled={pending} onClick={onTest}>
          {pending && <Loader2 className="h-4 w-4 animate-spin" />}
          {t("apps.ChatEndpointSetup.sentTestMessage")}
        </Button>
      </div>
      </>}
    </div>
  );
}
