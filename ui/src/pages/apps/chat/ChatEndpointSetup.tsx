import { Trans } from "react-i18next";
import { t, useTranslation } from "@/i18n";
import { slackAppValidationMessage, chatUiErrorMessage, type ChatUiError } from "./chat-copy";
import { SLACK_BOT_TOOL_SCOPES } from "@paperclipai/shared";
import { defaultSlackAppName, slackBotNameForAgent } from "./slack-app-name";
import { GitHubChatSetup } from "./GitHubChatSetup";
import { SlackSetupPrompt } from "./SlackSetupPrompt";
import { GitHubAgentTrustWarning } from "@/components/GitHubAgentTrustWarning";
import { SetupWizardFooter } from "@/components/SetupWizard";
import { ChatSetupNavigation } from "@/components/chat/ChatSetupNavigation";
import { SlackAvatarStep } from "./SlackAvatarStep";
import { useSlackAvatarProgress } from "./slack-avatar-progress";
import { agentAvatarUrl } from "@/lib/agent-avatar-url";
import { resolveAgentAppearance } from "@paperclipai/shared";
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
import { AlertTriangle, CheckCircle2, Copy, CircleHelp, ExternalLink, Eye, EyeOff, Loader2 } from "lucide-react";
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
  GitHubPrivateKeyFileError,
  readGitHubPrivateKeyFile,
} from "./github-private-key-file";

const providerNames: Record<ChatProvider, string> = {
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

function ChatConnectionPurpose({ provider, onChat, onTools }: {
  provider: ChatProvider;
  onChat: () => void;
  onTools: () => void;
}) {
  useTranslation();
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => {
    setBreadcrumbs([{ label: t("localizationConnections.connectors16"), href: "/apps" }, { label: t("localizationConnections.chooseConnection52") }]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs, t]);
  return (
      <div className="max-w-2xl space-y-6">
        <ChatSetupNavigation labels={provider === "slack" ? [t("chatUi.chatEndpointSetup.chooseAgent"), t("sep28Apps.copy235"), t("sep28Apps.copy236"), t("sep28Apps.copy237"), t("sep28Apps.copy238"), t("sep28Apps.copy198"), t("chatUi.chatEndpointSetup.tryIt")] : undefined} step={0} availableStep={0} onSelect={onChat} />
        <div>
          <h1 className="text-xl font-bold">{t("chatUi.chatEndpointSetup.chooseHowToConnect")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("chatUi.chatEndpointSetup.whatShouldThisConnectionDo", { value0: providerNames[provider] })}
          </p>
        </div>
        <div className="grid gap-3">
          <button
            type="button"
            className="rounded-xl border border-border p-4 text-left hover:bg-accent/40"
            onClick={onChat}
          >
            <span className="block text-sm font-semibold">{t("stable916Shell.chatWithAgent")}</span>
            <span className="mt-1 block text-sm text-muted-foreground">
              {t("sep28Apps.chatPurpose", { provider: providerNames[provider] })}
            </span>
          </button>
          <button
            type="button"
            className="rounded-xl border border-border p-4 text-left hover:bg-accent/40"
            onClick={onTools}
          >
            <span className="block text-sm font-semibold">{t("chatUi.chatEndpointSetup.useThisConnectionAsAnAgentTool")}</span>
            <span className="mt-1 block text-sm text-muted-foreground">
              {t("sep28Apps.toolsPurpose", { provider: providerNames[provider] })}
            </span>
          </button>
        </div>
      </div>
  );
}

export function ChatEndpointSetup() {
  useTranslation();
  const [params] = useSearchParams();
  if (params.get("provider") === "github") return <GitHubChatSetup />;
  return params.get("provider") === "agentmail" ? <EmailEndpointSetup /> : <ChatSdkEndpointSetup />;
}

function ChatSdkEndpointSetup() {
  const { i18n } = useTranslation();
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
  const [endpoint, setEndpoint] = useState<ChatEndpoint | null>(null);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [generatedWebhookSecret, setGeneratedWebhookSecret] = useState("");
  const [setupError, setSetupError] = useState<ChatUiError | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: t("localizationConnections.connectors16"), href: "/apps" },
      { label: t("chatUi.chatEndpointSetup.connectChat") },
    ]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs, i18n.resolvedLanguage]);

  const agentsQuery = useQuery({
    queryKey: ["chat-endpoint-setup-agents", selectedCompanyId],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const resumeQuery = useQuery({
    queryKey: ["chat-endpoint-setup-resume", resumeEndpointId],
    queryFn: () => chatEndpointsApi.get(resumeEndpointId),
    enabled: Boolean(resumeEndpointId),
  });
  useEffect(() => {
    if (!resumeQuery.data) return;
    setEndpoint(resumeQuery.data);
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
  const activeAgents = useMemo(
    () =>
      (agentsQuery.data ?? []).filter((agent) =>
        isAgentStatusInvokable(agent.status),
      ),
    [agentsQuery.data],
  );
  const syncEndpointSnapshot = (
    next: ChatEndpoint,
    onlyIfStillVisible = false,
  ) => {
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
  const createEndpoint = useMutation({
    mutationFn: () =>
      chatEndpointsApi.create(selectedCompanyId!, {
        provider: provider!,
        assignedAgentId: agentId,
      }),
    onSuccess: (next) => {
      setViewedStep(null);
      syncEndpointSnapshot(next);
      if (next.provider === "imessage-photon") {
        const resumed = new URLSearchParams(params);
        resumed.set("resume", next.id);
        setParams(resumed, { replace: true });
      }
    },
    onError: (error) =>
      pushToast({
        title: t("chatUi.chatEndpointSetup.couldnTStartSetup"),
        body: error instanceof Error ? error.message : t("localizationConnections.tryAgain227"),
        tone: "error",
      }),
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
      setSetupError(error instanceof Error && error.message.trim()
        ? sanitizedSetupErrorMessage(error, variables.values)
        : { key: "chatUi.setupErrorFallback" }),
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
        title: t("chatUi.chatEndpointSetup.couldnTGenerateWebhookSecret"),
        body: error instanceof Error ? error.message : t("localizationConnections.tryAgain227"),
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
        title: t("chatUi.chatEndpointSetup.testNotComplete"),
        body:
          error instanceof Error
            ? error.message
            : t("chatUi.chatEndpointSetup.sendTheProviderMessageThenTryAgain"),
        tone: "error",
      }),
  });

  const repairing = isChatEndpointRepairing(
    endpoint,
    resumeEndpointId,
    reconnectRequested,
  );
  const isSlack = provider === "slack";
  const avatarProgress = useSlackAvatarProgress(selectedCompanyId, endpoint?.id);
  const tryStep = isSlack ? 6 : 2;
  const availableStep = endpoint
    ? !repairing &&
      (endpoint.setup?.step === "test" || endpoint.setup?.step === "complete")
      ? isSlack && endpoint.setup?.step !== "complete"
        ? !avatarProgress.progress ? 4 : !slackIdentityReady ? 5 : tryStep
        : tryStep
      : isSlack && endpoint.providerAccountId && !repairing ? 3
      : isSlack && (slackCredentialsReady || repairing) ? 2 : 1
    : 0;
  const step = Math.min(viewedStep ?? availableStep, availableStep);
  const avatarAgent = useQuery({
    queryKey: queryKeys.agents.detail(endpoint?.assignedAgentId ?? ""),
    queryFn: () => agentsApi.get(endpoint!.assignedAgentId, endpoint!.companyId),
    enabled: Boolean(isSlack && endpoint && step === 4),
  });
  const slackVerificationQuery = useQuery({
    queryKey: ["chat-endpoint-slack-webhook-verification", endpoint?.id],
    queryFn: () => chatEndpointsApi.get(endpoint!.id),
    enabled: Boolean(isSlack && step === 3 && endpoint?.setup?.step === "provider_setup" &&
      !endpoint.setup.webhookVerifiedAt && !setupAction.isPending),
    refetchInterval: 1_500,
  });
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
      <p className="text-sm text-destructive">{t("chatUi.chatEndpointSetup.thisChatProviderIsNotSupported")}</p>
    );
  if (!selectedCompanyId)
    return (
      <p className="text-sm text-muted-foreground">{t("chatUi.chatEndpointSetup.selectAnOrganizationToConnectChat")}</p>
    );

  if (purpose === "choice") {
    return <ChatConnectionPurpose provider={provider} onChat={() => setPurpose("chat")} onTools={() => navigate(toolHref)} />;
  }

  const selectedAgent = agentsQuery.data?.find((agent) => agent.id === agentId);
  return (
    <div className="max-w-2xl space-y-6">
      <ChatSetupNavigation
        labels={isSlack ? [t("chatUi.chatEndpointSetup.chooseAgent"), t("sep28Apps.copy235"), t("sep28Apps.copy236"), t("sep28Apps.copy237"), t("sep28Apps.copy238"), t("sep28Apps.copy198"), t("chatUi.chatEndpointSetup.tryIt")] : undefined}
        step={step}
        availableStep={availableStep}
        disabled={createEndpoint.isPending || setupAction.isPending || generateSetupSecret.isPending || testConnection.isPending}
        onSelect={setViewedStep}
      />
      <div className="min-w-0 space-y-6">
        {step === 0 ? (
          <>
            <div>
              <h1 className="text-xl font-bold">{t("chatUi.chatEndpointSetup.whichAgentDoYouWantToChatWith")}</h1>
              <p className="mt-1 text-sm text-muted-foreground">{t("chatUi.chatEndpointSetup.thisAgentIsPermanentForTheConnectionConnectAnotherChannel")}</p>
            </div>
            {isSlack && <SlackSetupPrompt />}
            {endpoint ? (
              <Input aria-label={t("sep28Apps.copy120")} value={endpoint.assignedAgentName ?? selectedAgent?.name ?? agentId} readOnly />
            ) : <AgentSelect
              agents={activeAgents}
              value={agentId}
              onChange={setAgentId}
              placeholder={t("chatUi.chatEndpointSetup.chooseAnActiveAgent")}
              emptyMessage={t("chatUi.chatEndpointSetup.noActiveAgentsAreAvailable")}
            />}
            {provider === "github" && <GitHubAgentTrustWarning agent={selectedAgent} />}
            <SetupWizardFooter onSaveExit={() => navigate("/apps")}>
              <Button
                disabled={!agentId || createEndpoint.isPending}
                onClick={() => endpoint ? setViewedStep(1) : createEndpoint.mutate()}
              >
                {createEndpoint.isPending && (
                  <Loader2 className="h-4 w-4 animate-spin" />
                )} {t("pages.inviteLanding.actions.continue")}</Button>
            </SetupWizardFooter>
          </>
        ) : null}
        {endpoint && (
          <div hidden={step !== 1 && !(isSlack && (step === 2 || step === 3))} className="space-y-6">
            {setupError ? (
              <div
                role="alert"
                className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive"
              >
                <p className="font-medium">{t("localizationOperations.environment_Connection_failed")}</p>
                <p className="mt-1">{chatUiErrorMessage(setupError)}</p>
              </div>
            ) : null}
            <ProviderConnectStep
              key={`${provider}:${endpoint.id}`}
              provider={provider}
              slackStage={step === 1 ? "app" : step === 3 ? "finish" : "credentials"}
              onSlackCredentialsContinue={() => setViewedStep(3)}
              onSlackVerificationContinue={() => setViewedStep(4)}
              slackVerificationError={slackVerificationQuery.isError}
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
              generatedWebhookSecret={generatedWebhookSecret}
              generatingSetupSecret={generateSetupSecret.isPending}
              onGenerateSetupSecret={() => generateSetupSecret.mutate()}
              onAction={(action, values) =>
                setupAction.mutate({ action, values })
              }
            />
          </div>
        )}
        {endpoint && isSlack && step === 4 && (
          <div className="space-y-4">
            {avatarAgent.isPending ? <p role="status" className="text-sm text-muted-foreground">{t("sep28Apps.copy239")}</p>
              : avatarAgent.isError ? <p role="alert" className="text-sm text-destructive">{t("sep28Apps.copy240")} <button className="underline" onClick={() => void avatarAgent.refetch()}>{t("localizationProjectRepositories.retry")}</button></p>
              : <SlackAvatarStep
                  agentName={avatarAgent.data?.name ?? endpoint.assignedAgentName}
                  appName={endpoint.setup?.slackApp?.appName ?? defaultSlackAppName(avatarAgent.data?.name ?? endpoint.assignedAgentName)}
                  avatarUrl={agentAvatarUrl(resolveAgentAppearance(avatarAgent.data?.appearance, endpoint.assignedAgentId), 512, 1, "rest")}
                  uploaded={avatarProgress.progress === "uploaded"}
                  onUploaded={() => { avatarProgress.save("uploaded"); setViewedStep(5); }}
                  onSkip={() => { if (!avatarProgress.progress) avatarProgress.save("skipped"); setViewedStep(5); }}
                  onSaveExit={() => navigate("/apps")}
                />}
            {(avatarAgent.isPending || avatarAgent.isError) && <SetupWizardFooter onSaveExit={() => navigate("/apps")}><Button onClick={() => { avatarProgress.save("skipped"); setViewedStep(5); }}>{t("sep28Apps.copy193")}</Button></SetupWizardFooter>}
          </div>
        )}
        {endpoint && isSlack && step === 5 && (
          <SlackIdentityStep
            endpointId={endpoint.id}
            command={endpoint.setup?.slackApp?.command ?? endpoint.setup?.command ?? "/paperclip"}
            testStartedAt={endpoint.setup?.testStartedAt}
            onSaveExit={() => navigate("/apps")}
            onConnected={() => {
              setSlackIdentityReady(true);
              setViewedStep(6);
            }}
          />
        )}
        {endpoint && step === tryStep && (
          <TryStep
            endpointId={endpoint.id}
            provider={provider}
            agentName={selectedAgent?.name ?? endpoint.assignedAgentName}
            botLabel={endpoint.botLabel}
            botUsername={endpoint.botUsername}
            photonAllocation={endpoint.photonAllocation}
            providerUrl={endpoint.setup?.providerUrl}
            guestIsolationState={
              experimentalSettingsQuery.isPending
                ? "loading"
                : experimentalSettingsQuery.isError
                  ? "unknown"
                  : experimentalSettingsQuery.data?.enableIsolatedWorkspaces ===
                      true
                    ? "enabled"
                    : "disabled"
            }
            pending={testConnection.isPending}
            onOpenAccess={() => navigate(`/apps/chat/${endpoint.id}/access`)}
            onTest={() => testConnection.mutate()}
            onSaveExit={() => navigate("/apps")}
          />
        )}
        {step !== 0 && !(isSlack && (step === 1 || step === 2 || step === 3 || step === 4 || step === 5 || step === 6)) && <div className="flex justify-start">
          <Button className="text-muted-foreground" variant="ghost" onClick={() => navigate("/apps")}>{t("chatUi.chatEndpointSetup.saveExit")}</Button>
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
  onEndpointSaved: (endpoint: ChatEndpoint) => void;
  generatedWebhookSecret: string;
  generatingSetupSecret: boolean;
  onGenerateSetupSecret: () => void;
  onAction: (
    action: ChatEndpointSetupAction,
    values?: Record<string, string>,
  ) => void;
}) {
  useTranslation();
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
      title: t("chatUi.chatEndpointSetup.couldnTCopyToClipboard"),
      body: t("chatUi.chatEndpointSetup.selectAndCopyTheValueManually"),
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
          t("chatUi.chatEndpointSetup.thisEndpointIsUnavailableCheckTheServerSPublicURL")}
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
  const [privateKeyFileError, setPrivateKeyFileError] = useState<ChatUiError | null>(
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
        error instanceof GitHubPrivateKeyFileError ? { key: error.messageKey } : error instanceof Error
          ? error.message
          : { key: "chatUi.chatEndpointSetup.paperclipCouldnTReadThatFileChooseThePemFile" },
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
  const defaultSlackCommand =
    endpoint.setup?.command ??
    `/${
      agentName
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 24) || "paperclip"
    }`;
  const defaultSlackBotName = slackBotNameForAgent(agentName);
  const [slackApp, setSlackApp] = useState<SlackAppConfiguration>(() =>
    endpoint.setup?.slackApp ?? {
      appName: defaultSlackAppName(agentName),
      botName: defaultSlackBotName,
      command: defaultSlackCommand,
    },
  );
  const slackDetailsEditable = endpoint.status === "draft" && !endpoint.botExternalId;
  const slackValidation = slackAppConfigurationSchema.safeParse(slackApp);
  const saveSlackApp = useMutation({
    scope: { id: `slack-app-details:${endpoint.id}` },
    mutationFn: (details: SlackAppConfiguration) =>
      chatEndpointsApi.update(endpoint.id, { slackApp: details }),
    onSuccess: onEndpointSaved,
  });
  const persistSlackApp = () => {
    if (!slackDetailsEditable || !slackValidation.success) return;
    if (JSON.stringify(slackValidation.data) === JSON.stringify(endpoint.setup?.slackApp)) return;
    saveSlackApp.mutate(slackValidation.data);
  };
  const slackAppName = slackApp.appName.trim();
  const slackBotName = slackApp.botName.trim();
  const slackCommand = slackApp.command.trim();
  const slackWebhookUrl =
    endpoint.setup?.webhookUrl ?? "<paperclip-webhook-url>";
  const slackManifest = `display_information:
  name: ${JSON.stringify(slackAppName)}
features:
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  agent_view:
    agent_description: "Work with a Paperclip agent in a task-backed conversation."
  bot_user:
    display_name: ${JSON.stringify(slackBotName)}
  slash_commands:
    - command: ${JSON.stringify(slackCommand)}
      description: ${JSON.stringify(`Start or manage work with ${agentName}`)}
      usage_hint: ${JSON.stringify("status | new | close | <task>")}
      should_escape: false
      url: ${JSON.stringify(slackWebhookUrl)}
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - assistant:write
      - channels:history
      - channels:read
      - chat:write
      - commands
      - files:read
      - files:write
      - groups:history
      - groups:read
      - im:history
      - im:read
      - mpim:history
      - mpim:read
      - reactions:read
      - reactions:write
      - users:read
${SLACK_BOT_TOOL_SCOPES.map(scope => `      - ${scope}`).join("\n")}
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
  event_subscriptions:
    request_url: ${JSON.stringify(slackWebhookUrl)}
    bot_events:
      - agent_session_stopped
      - app_mention
      - message.channels
      - message.groups
      - message.im
      - message.mpim
      - member_joined_channel
      - member_left_channel
      - channel_left
      - group_left
      - reaction_added
      - reaction_removed
      - channel_archive
      - group_archive
      - channel_unarchive
      - group_unarchive
      - channel_deleted
      - channel_rename
      - group_rename
      - app_uninstalled
      - tokens_revoked
  interactivity:
    is_enabled: true
    request_url: ${JSON.stringify(slackWebhookUrl)}`;
  // Slack's documented creation link accepts a URL-encoded YAML manifest.
  const slackCreateUrl = `https://api.slack.com/apps?new_app=1&manifest_yaml=${encodeURIComponent(slackManifest)}`;
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
            { name: "ChannelMessage.Read.Group", type: t("localizationTools.application15") },
            { name: "ChatMessage.Read.Chat", type: t("localizationTools.application15") },
          ],
        },
      },
    },
    null,
    2,
  );
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
          <h1 className="text-xl font-bold">{t("chatUi.chatEndpointSetup.connectToDiscord", { agentName: agentName })}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {repairing
              ? t("chatUi.chatEndpointSetup.reconnectVerifiesThisSameDiscordApplicationAndServerInstallationIt")
              : t("chatUi.chatEndpointSetup.createOneDedicatedDiscordApplicationAndBotForThisPaperclip")}
          </p>
        </div>
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>{t("chatUi.chatEndpointSetup.inDiscordDeveloperPortalCreateAnApplicationCopyItsApplication")}</li>
          <li>{t("chatUi.chatEndpointSetup.openBotCreateTheBotEnableMessageContentIntentThen")}</li>
          <li>{t("chatUi.chatEndpointSetup.enableDeveloperModeInDiscordRightClickTheTargetServer")}</li>
          <li>{t("chatUi.chatEndpointSetup.enterThoseValuesBelowThenUseTheGeneratedInstallLink")}</li>
        </ol>
        <Button
          variant="outline"
          onClick={() =>
            openProviderSetup("https://discord.com/developers/applications")
          }
        ><Trans i18nKey="chatUi.chatEndpointSetup.openDiscordDeveloperPortal" components={{ externallink0: <ExternalLink  /> }} /></Button>
        {field("applicationId", t("chatUi.chatEndpointSetup.applicationID"), "text")}
        {field("guildId", t("chatUi.chatEndpointSetup.serverID"), "text")}
        {field("botToken", t("chatUi.chatEndpointSetup.botToken"))}
        {installUrl && (
          <Button asChild variant="outline">
            <a href={installUrl} target="_blank" rel="noreferrer"><Trans i18nKey="chatUi.chatEndpointSetup.installBotInThisServer" components={{ externallink0: <ExternalLink  /> }} /></a>
          </Button>
        )}
        <p className="text-sm text-muted-foreground">{t("chatUi.chatEndpointSetup.theInstallLinkGrantsOnlyViewChannelsSendMessagesCreate")}</p>
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
          {repairing ? t("chatUi.chatEndpointSetup.reconnectDiscordBot") : t("chatUi.chatEndpointSetup.connectDiscordBot")}
        </Button>
      </div>
    );
  }
  if (provider === "telegram")
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-xl font-bold">{t("chatUi.chatEndpointSetup.createInTelegram", { agentName: agentName })}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {repairing
              ? t("chatUi.chatEndpointSetup.reconnectVerifiesThisSameBotFatherBotAndAutomaticallyRefreshesIts")
              : t("chatUi.chatEndpointSetup.createABotWithBotFatherThenPasteTheTokenIt")}
          </p>
        </div>
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li><Trans i18nKey="chatUi.chatEndpointSetup.openBotFatherAndSend" components={{ code0: <code>/newbot</code> }} /></li>
          <li>{t("chatUi.chatEndpointSetup.enterTheBotDisplayName")}</li>
          <li><Trans i18nKey="chatUi.chatEndpointSetup.chooseAnAvailableUsernameEndingIn" components={{ code0: <code>bot</code> }} /></li>
        </ol>
        <p className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground"><Trans i18nKey="chatUi.chatEndpointSetup.paperclipWorksWithTelegramSDefaultBotPrivacyModeAnd" components={{ code0: <code>/task@bot_username &lt;request&gt;</code> }} /></p>
        <Button
          variant="outline"
          onClick={() => openProviderSetup("https://t.me/BotFather")}
        ><Trans i18nKey="chatUi.chatEndpointSetup.openBotFather" components={{ externallink0: <ExternalLink  /> }} /></Button>
        {field("botToken", t("chatUi.chatEndpointSetup.botToken"))}
        {!endpoint.setup?.webhookUrl && (
          <p className="text-sm text-destructive">{t("chatUi.chatEndpointSetup.configureAPublicHTTPSURLForThisPaperclipInstanceBefore")}</p>
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
          {repairing ? t("chatUi.chatEndpointSetup.reconnectBot") : t("chatUi.chatEndpointSetup.connectBot")}
        </Button>
      </div>
    );
  if (provider === "microsoft-teams")
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-xl font-bold">{t("chatUi.chatEndpointSetup.connectToMicrosoftTeams", { agentName: agentName })}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {repairing
              ? t("chatUi.chatEndpointSetup.reconnectVerifiesThisSameMicrosoftAppTenantAndBotIdentity")
              : t("chatUi.chatEndpointSetup.useYourOwnMicrosoftAppCredentialsForThisBot")}
          </p>
        </div>
        <p className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">{t("chatUi.chatEndpointSetup.thisSetupRequiresAMicrosoft365WorkOrSchoolOrganization")}</p>
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>{t("chatUi.chatEndpointSetup.inMicrosoftEntraCreateASingleTenantAppRegistrationCopy")}</li>
          <li>{t("chatUi.chatEndpointSetup.inAzureCreateAnAzureBotChooseSingleTenantUse")}</li>
          <li>{t("chatUi.chatEndpointSetup.inTeamsDeveloperPortalCreateAnAppAddABot")}</li>
        </ol>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <a
              href="https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade"
              target="_blank"
              rel="noreferrer"
            ><Trans i18nKey="chatUi.chatEndpointSetup.openMicrosoftEntra" components={{ externallink0: <ExternalLink  /> }} /></a>
          </Button>
          <Button asChild variant="outline">
            <a
              href="https://portal.azure.com/#create/Microsoft.AzureBot"
              target="_blank"
              rel="noreferrer"
            ><Trans i18nKey="chatUi.chatEndpointSetup.createAzureBot" components={{ externallink0: <ExternalLink  /> }} /></a>
          </Button>
          <Button asChild variant="outline">
            <a
              href="https://dev.teams.microsoft.com/apps"
              target="_blank"
              rel="noreferrer"
            ><Trans i18nKey="chatUi.chatEndpointSetup.openTeamsDeveloperPortal" components={{ externallink0: <ExternalLink  /> }} /></a>
          </Button>
        </div>
        {endpointValue(
          t("chatUi.chatEndpointSetup.paperclipMessagingEndpoint"),
          endpoint.setup?.messagingEndpoint,
        )}
        {field("clientId", t("chatUi.chatEndpointSetup.applicationClientID"), "text")}
        {field("tenantId", t("chatUi.chatEndpointSetup.directoryTenantID"), "text")}
        {field("clientSecret", t("chatUi.chatEndpointSetup.clientSecretValue"))}
        <section className="space-y-3 rounded-lg border border-border p-4">
          <div>
            <h2 className="text-sm font-semibold">{t("chatUi.chatEndpointSetup.microsoftPortalFieldMap")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("chatUi.chatEndpointSetup.useTheseExactPortalSectionsAndReuseTheSameApplication")}</p>
          </div>
          <ol className="list-decimal space-y-3 pl-5 text-sm">
            <li><Trans i18nKey="chatUi.chatEndpointSetup.microsoftEntraAdminCenterAppRegistrationsSelectNewRegistrationChoose" components={{ strong0: <strong />, strong1: <strong />, strong2: <strong />, strong3: <strong />, strong4: <strong />, strong5: <strong />, strong6: <strong />, strong7: <strong />, strong8: <strong /> }} /></li>
            <li><Trans i18nKey="chatUi.chatEndpointSetup.azureCreateAzureBotSetMicrosoftAppIDToSingle" components={{ strong0: <strong />, strong1: <strong />, strong2: <strong />, strong3: <strong />, strong4: <strong />, strong5: <strong />, strong6: <strong />, strong7: <strong />, strong8: <strong /> }} /></li>
            <li><Trans i18nKey="chatUi.chatEndpointSetup.teamsDeveloperPortalAppsSelectNewAppUnderConfigureApp" components={{ strong0: <strong />, strong1: <strong />, strong2: <strong />, strong3: <strong />, strong4: <strong />, strong5: <strong />, strong6: <strong />, strong7: <strong /> }} /></li>
            <li><Trans i18nKey="chatUi.chatEndpointSetup.microsoftTeamsAppsManageYourAppsSelectUploadAnApp" components={{ strong0: <strong />, strong1: <strong /> }} /></li>
          </ol>
        </section>
        <label className="grid gap-2 text-sm font-medium">{t("chatUi.chatEndpointSetup.requiredTeamsAppManifestBlock")}<Textarea
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
              ? t("chatUi.chatEndpointSetup.manifestSettingsCopied")
              : t("chatUi.chatEndpointSetup.copyManifestSettings")}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">{t("chatUi.chatEndpointSetup.enterTheApplicationClientIDAboveBeforeCopyingSoThe")}</p>
        <p className="text-sm text-muted-foreground"><Trans i18nKey="chatUi.chatEndpointSetup.paperclipDoesNotUseTeamsSingleSignOnInThis" components={{ code0: <code>webApplicationInfo</code> }} /></p>
        <p className="text-sm text-muted-foreground">{t("chatUi.chatEndpointSetup.theTwoApplicationRSCPermissionsLetTheBotReceiveEvery")}</p>
        <p className="text-sm text-muted-foreground"><Trans i18nKey="chatUi.chatEndpointSetup.thisReleaseSupportsPersonalChatsGroupChatsAndStandardTeam" components={{ code0: <code>supportsFiles: true</code> }} /></p>
        {!endpoint.setup?.messagingEndpoint && (
          <p className="text-sm text-destructive">{t("chatUi.chatEndpointSetup.configureAPublicHTTPSURLForThisPaperclipInstanceBefore1061")}</p>
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
            ? t("chatUi.chatEndpointSetup.reconnectMicrosoftApp")
            : t("chatUi.chatEndpointSetup.verifyMicrosoftCredentials")}
        </Button>
      </div>
    );
  if (provider === "github")
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-xl font-bold">
            {repairing
              ? t("chatUi.chatEndpointSetup.reconnectGitHubApp")
              : t("chatUi.chatEndpointSetup.createOrConnectAGitHubApp")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {repairing
              ? t("chatUi.chatEndpointSetup.reconnectVerifiesThisSameAppAndInstallationThenUpdatesIts")
              : t("chatUi.chatEndpointSetup.configureItsWebhookAndPermissionsThenVerifyTheAppWith")}
          </p>
        </div>
        {!repairing && (
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            <li>{t("chatUi.chatEndpointSetup.underTheTargetUserOrOrganizationCreateANewGitHub")}</li>
            <li><Trans i18nKey="chatUi.chatEndpointSetup.keepWebhooksActiveOnEnterThePaperclipWebhookURLAnd" components={{ strong0: <strong />, strong1: <strong /> }} /></li>
            <li><Trans i18nKey="chatUi.chatEndpointSetup.underRepositoryPermissionsSetIssuesAndPullRequestsToRead" components={{ strong0: <strong />, strong1: <strong />, strong2: <strong /> }} /></li>
            <li><Trans i18nKey="chatUi.chatEndpointSetup.subscribeToIssueCommentPullRequestReviewCommentGitHubSends" components={{ strong0: <strong />, code1: <code>issue_comment</code>, strong2: <strong />, code3: <code>pull_request_review_comment</code>, code4: <code>installation</code>, code5: <code>installation_repositories</code> }} /></li>
            <li><Trans i18nKey="chatUi.chatEndpointSetup.chooseOnlyOnThisAccountCreateTheAppCopyIts" components={{ strong0: <strong /> }} /></li>
          </ol>
        )}
        {endpointValue(
          t("chatUi.chatEndpointSetup.paperclipHomepageURL"),
          publicOrigin(endpoint.setup?.webhookUrl),
        )}
        {endpointValue(t("chatUi.chatEndpointSetup.paperclipWebhookURL"), endpoint.setup?.webhookUrl)}
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
          {repairing ? t("chatUi.chatEndpointSetup.openGitHubAppSettings") : t("chatUi.chatEndpointSetup.openNewGitHubAppForm")}{" "}
          <ExternalLink />
        </Button>
        {field("appId", t("chatUi.chatEndpointSetup.githubAppID"), "text")}
        <div className="grid gap-2 text-sm font-medium">
          <label htmlFor="github-private-key">{t("chatUi.chatEndpointSetup.privateKeyPEM")}</label>
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
                privateKeyVisible ? t("chatUi.chatEndpointSetup.hidePrivateKey") : t("chatUi.chatEndpointSetup.showPrivateKey")
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
            aria-label={t("chatUi.chatEndpointSetup.chooseGitHubAppPrivateKeyFile")}
            onChange={loadPrivateKeyFile}
          />
          <div>
            <Button
              type="button"
              variant="outline"
              onClick={() => privateKeyFileInputRef.current?.click()}
            >{t("chatUi.chatEndpointSetup.choosePemFile")}</Button>
          </div>
          {privateKeyFileError ? (
            <p role="alert" className="text-sm text-destructive">
                {chatUiErrorMessage(privateKeyFileError)}
            </p>
          ) : null}
          {privateKeyFileLoading ? (
            <p
              role="status"
              aria-live="polite"
              className="text-sm text-muted-foreground"
            >{t("chatUi.chatEndpointSetup.readingPrivateKeyFile")}</p>
          ) : privateKeyFileLoaded ? (
            <p
              role="status"
              aria-live="polite"
              className="text-sm text-muted-foreground"
            >{t("chatUi.chatEndpointSetup.privateKeyLoadedItStaysInThisFormUntilYou")}</p>
          ) : null}
        </div>
        <div className="grid gap-2">
          <p className="text-sm font-medium">{t("localizationRoutines.webhookSecret")}</p>
          {generatedWebhookSecret ? (
            <>
              <Input
                aria-label={t("chatUi.chatEndpointSetup.generatedWebhookSecret")}
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
                    ? t("sep28Apps.copy131")
                    : webhookSecretCopy.failed
                      ? t("sep28Apps.copy132")
                      : t("chatUi.chatEndpointSetup.copyWebhookSecret")}
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">{t("chatUi.chatEndpointSetup.copyThisValueNowPaperclipWillNotShowItAgain")}</p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              {endpoint.setup?.webhookSecretConfigured
                ? t("chatUi.chatEndpointSetup.aWebhookSecretIsConfiguredAndCannotBeShownAgain")
                : t("chatUi.chatEndpointSetup.generateTheSecretInPaperclipThenPasteItIntoThe")}
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
                ? t("chatUi.chatEndpointSetup.regenerateWebhookSecret")
                : t("chatUi.chatEndpointSetup.generateWebhookSecret")}
            </Button>
          </div>
          {endpoint.setup?.webhookSecretConfigured && (
            <p className="text-sm text-muted-foreground">
              {endpoint.providerAccountId || endpoint.botExternalId
                ? t("chatUi.chatEndpointSetup.regeneratingImmediatelyInvalidatesGitHubWebhookSignaturesUntilYouReplaceThe")
                : t("chatUi.chatEndpointSetup.generatingAnotherSecretReplacesThePreviousValuePasteTheNewest")}
            </p>
          )}
          {endpoint.setup?.webhookSecretConfigured && (
            <p
              className={`text-sm ${endpoint.setup.webhookVerifiedAt ? "text-foreground" : "text-muted-foreground"}`}
            >
              {endpoint.setup.webhookVerifiedAt
                ? t("chatUi.chatEndpointSetup.githubHasVerifiedThisWebhook")
                : t("chatUi.chatEndpointSetup.waitingForGitHubToDeliverItsSignedWebhookPing")}
            </p>
          )}
        </div>
        {!endpoint.setup?.webhookUrl && (
          <p className="text-sm text-destructive">{t("chatUi.chatEndpointSetup.configureAPublicHTTPSURLForThisPaperclipInstanceBefore1300")}</p>
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
          {repairing ? t("chatUi.chatEndpointSetup.reconnectAndVerify") : t("chatUi.chatEndpointSetup.connectAndVerify")}
        </Button>
      </div>
    );
  if (slackStage === "finish")
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-xl font-bold">{t("sep28Apps.copy237")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("sep28Apps.copy241")}</p>
        </div>
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li><Trans i18nKey="sep28Apps.openSlackSettings" values={{ app: slackApp.appName }} components={{ settings: <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer" className="underline underline-offset-4" />, app: <strong /> }} /></li>
          <li><Trans i18nKey="sep28Apps.slackChooseSection" values={{ section: "Event Subscriptions" }} components={{ section: <strong /> }} /></li>
          <li><Trans i18nKey="sep28Apps.slackVerifyInstructions" components={{ url: <strong />, retry: <strong /> }} /></li>
        </ol>
        {endpoint.setup?.webhookVerifiedAt ? (
          <p role="status" className="flex items-center gap-2 text-sm">
            <CheckCircle2 className="size-4 text-(--status-task-done)" />{t("sep28Apps.copy242")}{pending ? t("sep28Apps.openingMessageTest") : ""}
          </p>
        ) : slackVerificationError ? (
          <p role="alert" className="text-sm text-destructive">{t("sep28Apps.copy244")}</p>
        ) : (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />{t("sep28Apps.copy245")}</p>
        )}
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">{t("sep28Apps.copy246")}</summary>
          <div className="mt-3 space-y-3">
            <p className="text-muted-foreground">{t("sep28Apps.copy247")}</p>
            {endpointValue(t("chatUi.chatEndpointSetup.paperclipWebhookURL"), endpoint.setup?.webhookUrl)}
          </div>
        </details>
        <div className="flex items-center justify-between gap-3">
          <Button variant="ghost" className="text-muted-foreground" onClick={() => navigate("/apps")}>{t("chatUi.chatEndpointSetup.saveExit")}</Button>
          <Button disabled={pending || !endpoint.setup?.webhookVerifiedAt} onClick={() =>
            endpoint.setup?.step === "provider_setup" ? onAction("verify") : onSlackVerificationContinue()
          }>
            {pending && <Loader2 className="size-4 animate-spin" />}{t("pages.inviteLanding.actions.continue")}</Button>
        </div>
      </div>
    );

  return (
    <div className="space-y-5">
      {!endpoint.setup?.webhookUrl && (
        <div role="alert" className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4">
          <AlertTriangle className="size-5 shrink-0 text-destructive" />
          <div className="space-y-1">
            <p className="text-sm font-semibold">{t("sep28Apps.copy248")}</p>
            <p className="text-sm">{t("sep28Apps.copy249")}</p>
            <a
              href="https://docs.paperclip.ing/reference/deploy/https/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm underline underline-offset-4"
            >{t("sep28Apps.copy123")}</a>
          </div>
        </div>
      )}
      <div>
        <h1 className="text-xl font-bold">{slackStage === "app" ? t("sep28Apps.copy250") : t("sep28Apps.copy251")}</h1>
        {repairing && (
          <p className="mt-1 text-sm text-muted-foreground">{t("chatUi.chatEndpointSetup.reconnectVerifiesOrReplacesCredentialsForThisSameSlackApp")}</p>
        )}
      </div>
      <div hidden={slackStage !== "app"} className="space-y-5">
        <div className="space-y-3 text-sm">
          {([
            ["appName", t("chatUi.chatEndpointSetup.slackAppName"), 35, t("sep28Apps.copy252")],
            ["botName", t("chatUi.chatEndpointSetup.botDisplayName"), 80, t("sep28Apps.copy253")],
            ["command", t("chatUi.chatEndpointDetail.slashCommand"), 32, t("sep28Apps.copy254")],
          ] as const).map(([key, label, maxLength, help]) => (
            <div key={key} className="grid items-center gap-2 sm:grid-cols-2">
              <div className="flex items-center gap-1.5">
                <label htmlFor={`slack-${key}`}>{label}</label>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={t("sep28Apps.helpWith", { label })}
                      className="rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <CircleHelp className="size-3.5" aria-hidden="true" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">{help}</TooltipContent>
                </Tooltip>
              </div>
              <Input
                id={`slack-${key}`}
                className="bg-background text-foreground dark:bg-background"
                value={slackApp[key]}
                maxLength={maxLength}
                readOnly={!slackDetailsEditable}
                aria-invalid={!slackValidation.success && slackValidation.error.issues.some((issue) => issue.path[0] === key)}
                onChange={(event) => setSlackApp({ ...slackApp, [key]: event.target.value })}
                onBlur={persistSlackApp}
              />
            </div>
          ))}
          {!slackValidation.success && (
            <p role="alert" className="text-sm text-destructive">{slackAppValidationMessage(slackValidation.error.issues[0])}</p>
          )}
          {saveSlackApp.isError && (
            <div role="alert" className="space-y-2 text-sm text-destructive">
              <p>{t("sep28Apps.copy255")}</p>
              <Button variant="outline" size="sm" onClick={persistSlackApp}>{t("sep28Apps.copy256")}</Button>
            </div>
          )}
          <div className="flex justify-end">
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="link" className="h-auto p-0 text-xs text-muted-foreground underline underline-offset-4">{t("sep28Apps.copy257")}</Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-2xl">
                <DialogHeader>
                  <DialogTitle>{t("chatUi.chatEndpointSetup.slackAppManifest")}</DialogTitle>
                  <DialogDescription>{t("sep28Apps.copy258")}</DialogDescription>
                </DialogHeader>
                <Textarea
                  aria-label={t("chatUi.chatEndpointSetup.slackAppManifest")}
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
                    {manifestCopied ? t("chatUi.chatEndpointSetup.manifestCopied") : t("chatUi.chatEndpointSetup.copyManifest")}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 pt-3">
          <Button variant="ghost" className="text-muted-foreground" onClick={() => navigate("/apps")}>{t("chatUi.chatEndpointSetup.saveExit")}</Button>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            <Button variant="outline" disabled={openingSlackApp || !endpoint.setup?.webhookUrl || !slackValidation.success || saveSlackApp.isPending || saveSlackApp.isError} onClick={onSlackAppCreated}>{t("sep28Apps.copy259")}</Button>
            {!repairing && (
              <Button
                disabled={openingSlackApp || !endpoint.setup?.webhookUrl || !slackValidation.success || saveSlackApp.isPending || saveSlackApp.isError}
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
              >{t("sep28Apps.copy235")}<ExternalLink />
              </Button>
            )}
          </div>
        </div>
      </div>
      <div hidden={slackStage !== "credentials"} className="space-y-5">
        <p className="text-sm">{t("sep28Apps.copy260")}</p>
        {slackCredentialsSaved && !repairing && (
          <p className="text-sm text-muted-foreground">{t("sep28Apps.copy261")}</p>
        )}
        <section className="space-y-3">
          <h2 className="text-sm font-semibold"><label htmlFor="slack-bot-token">{t("chatUi.chatEndpointSetup.botUserOAuthToken")}</label></h2>
          <ul id="slack-bot-token-help" className="list-disc space-y-1 pl-5 text-sm">
            <li><Trans i18nKey="sep28Apps.openSlackSettings" values={{ app: slackApp.appName }} components={{ settings: <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer" className="underline underline-offset-4" />, app: <strong /> }} /></li>
            <li><Trans i18nKey="sep28Apps.slackChooseSection" values={{ section: "OAuth & Permissions" }} components={{ section: <strong /> }} /></li>
            <li><Trans i18nKey="sep28Apps.slackCopyField" values={{ field: "Bot OAuth Token" }} components={{ field: <strong /> }} /></li>
          </ul>
          <Input
            id="slack-bot-token"
            type="password"
            placeholder={slackCredentialsSaved ? t("sep28Apps.copy262") : undefined}
            value={credentials.botToken ?? ""}
            aria-invalid={slackBotTokenInvalid || undefined}
            aria-describedby={`slack-bot-token-help${slackBotTokenInvalid ? " slack-bot-token-warning" : ""}`}
            onChange={(event) => setCredentials({ ...credentials, botToken: event.target.value })}
          />
          {slackBotTokenInvalid && (
            <p id="slack-bot-token-warning" role="alert" className="text-sm text-destructive">
              <Trans i18nKey="sep28Apps.slackTokenWarning" components={{ prefix: <code />, section: <strong /> }} />
            </p>
          )}
        </section>
        <section className="space-y-3">
          <h2 className="text-sm font-semibold"><label htmlFor="slack-signing-secret">{t("chatUi.chatEndpointSetup.signingSecret")}</label></h2>
          <ul id="slack-signing-secret-help" className="list-disc space-y-1 pl-5 text-sm">
            <li><Trans i18nKey="sep28Apps.openSlackSettings" values={{ app: slackApp.appName }} components={{ settings: <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer" className="underline underline-offset-4" />, app: <strong /> }} /></li>
            <li><Trans i18nKey="sep28Apps.slackChooseSection" values={{ section: "Basic Information" }} components={{ section: <strong /> }} /></li>
            <li><Trans i18nKey="sep28Apps.slackCopyField" values={{ field: t("chatUi.chatEndpointSetup.signingSecret") }} components={{ field: <strong /> }} /></li>
          </ul>
          <Input
            id="slack-signing-secret"
            type="password"
            placeholder={slackCredentialsSaved ? t("sep28Apps.copy262") : undefined}
            value={credentials.signingSecret ?? ""}
            aria-invalid={slackSigningSecretHasTokenPrefix || undefined}
            aria-describedby={`slack-signing-secret-help${slackSigningSecretHasTokenPrefix ? " slack-signing-secret-warning" : ""}`}
            onChange={(event) => setCredentials({ ...credentials, signingSecret: event.target.value })}
          />
          {slackSigningSecretHasTokenPrefix && (
            <p id="slack-signing-secret-warning" role="alert" className="text-sm text-destructive">
              <Trans i18nKey="sep28Apps.slackSecretWarning" components={{ secret: <strong /> }} />
            </p>
          )}
        </section>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button variant="ghost" className="text-muted-foreground" onClick={() => navigate("/apps")}>{t("chatUi.chatEndpointSetup.saveExit")}</Button>
          <Button
            className="ml-auto"
            disabled={
              (!repairing && !slackCredentialsSaved && (!slackBotToken || !credentials.signingSecret?.trim())) ||
              !endpoint.setup?.webhookUrl || !slackValidation.success ||
              saveSlackApp.isPending || saveSlackApp.isError || pending || slackSigningSecretHasTokenPrefix || slackBotTokenInvalid
            }
            onClick={() => continueWithSavedSlackCredentials
              ? onSlackCredentialsContinue()
              : onAction(repairing || slackCredentialsSaved ? "reconnect" : "configure", credentials)}
          >
            {pending && <Loader2 className="h-4 w-4 animate-spin" />}
            {continueWithSavedSlackCredentials ? t("pages.inviteLanding.actions.continue") : repairing || slackCredentialsSaved ? t("chatUi.chatEndpointSetup.reconnectSlackApp") : t("chatUi.chatEndpointSetup.connectSlackApp")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function TryStep({
  endpointId,
  provider,
  agentName,
  botLabel,
  botUsername,
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
  photonAllocation?: "dedicated" | "shared";
  providerUrl?: string | null;
  guestIsolationState: "loading" | "enabled" | "disabled" | "unknown";
  pending: boolean;
  onOpenAccess: () => void;
  onTest: () => void;
  onSaveExit: () => void;
}) {
  useTranslation();
  const messageStatus = useQuery({
    queryKey: ["chat-endpoint-setup-test-status", endpointId],
    queryFn: () => chatEndpointsApi.setupTestStatus(endpointId),
    enabled: provider === "slack", refetchInterval: 1_500,
  });
  const [commandCopied, setCommandCopied] = useState(false);
  const [commandCopyError, setCommandCopyError] = useState(false);
  const principalsQuery = useQuery({
    queryKey: queryKeys.chatEndpoints.principals(endpointId),
    queryFn: () => chatEndpointsApi.listPrincipals(endpointId),
    refetchInterval: 1_500,
  });
  const [numberCopied, setNumberCopied] = useState(false);
  const [copyError, setCopyError] = useState<ChatUiError | null>(null);
  const identities = principalsQuery.data ?? [];
  const unlinkedIdentities = identities.filter(
    (identity) => identity.status !== "linked",
  );
  const freshConversationInstruction = t(`chatUi.freshConversation.${provider}`);
  const identityGuidance = provider === "slack" ? null : provider === "imessage-photon" && principalsQuery.isSuccess && (identities.length === 0 || unlinkedIdentities.length > 0)
    ? { tone: "info" as const, title: t("communityPhoton.linkIdentity"), body: t("communityPhoton.identityGuidance") }
    : principalsQuery.isError
    ? {
        tone: "warning" as const,
        title: t("chatUi.chatEndpointSetup.identityReadinessCouldNotBeChecked"),
        body: t("chatUi.identityCheckFailed"),
      }
    : !principalsQuery.isSuccess || guestIsolationState === "loading"
      ? null
      : identities.length === 0
        ? guestIsolationState === "disabled"
          ? {
              tone: "warning" as const,
              title: t("chatUi.chatEndpointSetup.linkTheAccountYouReTesting"),
              body:
                provider === "telegram"
                  ? t("chatUi.chatEndpointSetup.tapStartInTelegramToDiscoverYourAccountTheWelcome")
                  : t("chatUi.firstMessageGuestDisabled", { provider: providerNames[provider], agent: agentName }),
            }
          : {
              tone: "info" as const,
              title: t("chatUi.chatEndpointSetup.yourFirstMessageIdentifiesYourAccount"),
              body:
                provider === "telegram"
                  ? t("chatUi.chatEndpointSetup.tapStartInTelegramToDiscoverYourAccountUntilLinked")
                  : t("chatUi.firstMessageGuestEnabled"),
            }
        : unlinkedIdentities.length > 0
          ? guestIsolationState === "disabled"
            ? {
                tone: "warning" as const,
                title: t("chatUi.chatEndpointSetup.linkTheAccountYouReTesting"),
                body: t("chatUi.observedGuestDisabled", { agent: agentName }),
              }
            : {
                tone: "info" as const,
                title: t("chatUi.chatEndpointSetup.unlinkedIdentityDetected"),
                body: t("chatUi.observedGuestEnabled"),
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
  const photonDedicatedDestination = botUsername ?? botLabel;
  const slackTestMessage = `${botMention.startsWith("@") ? botMention : `@${botMention}`} you there?`;
  const instructions =
    provider === "imessage-photon" ? [
      photonAllocation === "shared" ? t("communityPhoton.tryShared")
        : photonDedicatedDestination == null ? t("communityPhoton.tryDedicatedWithoutNumber")
          : t("communityPhoton.tryDedicated", { number: photonDedicatedDestination }),
      t("communityPhoton.tryLink"),
      t("communityPhoton.tryReply"),
      photonAllocation === "shared" ? t("communityPhoton.trySharedBoundary") : t("communityPhoton.tryGroup"),
    ] : provider === "discord"
      ? [
          t("chatUi.chatEndpointSetup.openATextChannelWhereTheBotIsInstalled"),
          t("chatUi.mentionRoot", { mention: botMention }),
          t("chatUi.replyDiscordThread", { agent: agentName }),
        ]
      : provider === "telegram"
        ? [
            t("chatUi.chatEndpointSetup.openTheBotSPrivateChat"),
            t("chatUi.chatEndpointSetup.tapStart"),
            t("chatUi.chatEndpointSetup.sendHelpMeTestThis"),
          ]
        : provider === "github"
          ? [
              t("chatUi.chatEndpointSetup.openAnInstalledIssueOrPullRequest"),
              t("chatUi.mentionComment", { mention: botMention }),
              t("chatUi.chatEndpointSetup.addAnotherCommentToContinueTheSameTask"),
            ]
          : provider === "microsoft-teams"
            ? [
                t("chatUi.chatEndpointSetup.openAnInstalledChannelAndStartANewPost"),
                t("chatUi.mentionPost", { mention: botMention }),
                t("chatUi.chatEndpointSetup.replyOnceBeneathThePost"),
              ]
            : [
                t("sep28Apps.inviteChannel", { bot: botMention }),
                t("chatUi.mentionChannelMessage", { mention: botMention }),
                t("chatUi.replyThread", { agent: agentName }),
              ];
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold">
          {t("chatUi.chatEndpointSetup.tryIn", { agentName, value0: providerNames[provider] })}
        </h1>
        {provider !== "slack" && <p className="mt-1 text-sm text-muted-foreground">{t("chatUi.chatEndpointSetup.completeThisRealConversationToFinishSetup")}</p>}
      </div>
      {(!principalsQuery.isSuccess || guestIsolationState === "loading") &&
      !principalsQuery.isError ? (
        <p role="status" className="text-sm text-muted-foreground">{t("chatUi.chatEndpointSetup.checkingIdentityAndGuestReadiness")}</p>
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
          <p className="mt-1 text-muted-foreground">{freshConversationInstruction}</p>
          <Button
            className="mt-3"
            size="sm"
            variant="outline"
            onClick={onOpenAccess}
          >{t("chatUi.chatEndpointSetup.reviewIdentityAccess")}</Button>
        </div>
      ) : null}
      {provider === "imessage-photon" && botUsername && (
        <div className="space-y-2">
          <Button variant="outline" onClick={() => {
            void copyTextToClipboard(botUsername).then(
              () => { setNumberCopied(true); setCopyError(null); },
              () => setCopyError({ key: "communityPhoton.copySetupFailed" }),
            );
          }}>{numberCopied ? t("communityPhoton.numberCopied") : t("communityPhoton.copySpecificNumber", { number: botUsername })}</Button>
          {copyError && <p role="alert" className="text-sm text-destructive">{chatUiErrorMessage(copyError)}</p>}
        </div>
      )}
      {provider === "slack" ? (
        <>
          <ol className="list-decimal space-y-4 pl-5 text-sm">
            <li>{t("sep28Apps.inviteChannel", { bot: botMention })}</li>
            <li>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3">
                <code>{slackTestMessage}</code>
                <Button size="sm" variant="ghost" onClick={() => {
                  void copyTextToClipboard(slackTestMessage).then(() => { setCommandCopied(true); setCommandCopyError(false); }, () => setCommandCopyError(true));
                }}><Copy className="size-4" />{commandCopied ? t("pages.agentDetail.copied") : t("localizationTaskRuntime.ui_Copy_message_1b3i557")}</Button>
              </div>
              <p className="mt-2 text-muted-foreground">{t("sep28Apps.copy263")}</p>
            </li>
            <li>{t("sep28Apps.copy264")}</li>
          </ol>
          {commandCopyError && <p role="alert" className="text-sm text-destructive">{t("sep28Apps.copy265")}</p>}
          {messageStatus.data?.messageReceivedAt ? <p role="status" className="flex items-center gap-2 text-sm"><CheckCircle2 className="size-4 text-(--status-task-done)" />{t("sep28Apps.copy266")}</p>
            : <p role={messageStatus.isError ? "alert" : "status"} className="text-sm text-muted-foreground">{messageStatus.isError ? t("sep28Apps.copy267") : t("sep28Apps.copy268")}</p>}
          <div className="flex items-center justify-between gap-3">
            <Button variant="ghost" className="text-muted-foreground" onClick={onSaveExit}>{t("chatUi.chatEndpointSetup.saveExit")}</Button>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button variant="ghost" disabled={pending} onClick={onTest}>{t("sep28Apps.copy269")}</Button>
              <Button disabled={pending} onClick={onTest}>{pending && <Loader2 className="size-4 animate-spin" />}{t("chatUi.chatEndpointSetup.iVeSentTheTestMessage")}</Button>
            </div>
          </div>
        </>
      ) : <>
      <ol className="list-decimal space-y-2 pl-5 text-sm">
        {instructions.map((item) => <li key={item}>{item}</li>)}
      </ol>
      <div className="flex flex-wrap gap-2">
        {providerUrl && (
          <Button asChild variant="outline">
            <a href={providerUrl} target="_blank" rel="noopener noreferrer"><Trans i18nKey="chatUi.externallyConnectedTaskBanner.open" values={{ value0: providerNames[provider] }} components={{ externallink1: <ExternalLink  /> }} /></a>
          </Button>
        )}
        <Button disabled={pending} onClick={onTest}>
          {pending && <Loader2 className="h-4 w-4 animate-spin" />}{t("chatUi.chatEndpointSetup.iVeSentTheTestMessage")}</Button>
      </div>
      </>}
    </div>
  );
}
