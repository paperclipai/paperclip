import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  Clock,
  Loader2,
  Plug,
  RotateCcw,
  XCircle,
} from "lucide-react";
import { AI_CONNECTION_CAPABILITIES, aiProviderSchema, type AiAuthMethod, type ConnectionIntentInteraction } from "@paperclipai/shared";
import { AgentMailIntentSetup } from "./AgentMailIntentSetup";
import { connectionIntentsApi } from "@/api/connection-intents";
import { aiConnectionsApi } from "@/api/ai-connections";
import { agentsApi } from "@/api/agents";
import { describeError } from "@/api/errors";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { AiConnectionCredentialStep } from "@/components/ai-connections/AiConnectionCredentialStep";
import { AiProviderSetup } from "@/components/ai-connections/AiProviderSetup";
import { defaultAiConnectionName } from "@/components/ai-connections/model";
import { AppLogo } from "@/pages/apps/AppLogo";
import { AgentAvatar } from "@/components/AgentAvatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  ConnectionSetupFlow,
  type ConnectionSetupCompletion,
  type ConnectionSetupFlowProps,
} from "./ConnectionSetupFlow";

import { DecisionCardFooter } from "@/components/DecisionCardFooter";
import { useTranslation } from "@/i18n";

export interface ConnectionIntentInteractionBodyProps {
  footerSlot?: ReactNode;
  interaction: ConnectionIntentInteraction;
  currentUserId?: string | null;
  addresseeLabel: string;
  addresseeName?: string;
  renderSetup?: (props: ConnectionSetupFlowProps) => ReactNode;
}

export function ConnectionIntentInteractionBody({
  footerSlot,
  interaction,
  currentUserId,
  addresseeLabel,
  addresseeName,
  renderSetup,
}: ConnectionIntentInteractionBodyProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [adoptionConnectionId, setAdoptionConnectionId] = useState<string | null>(null);
  const focusTargetRef = useRef<HTMLDivElement>(null);
  const setupGeneration = useRef(0);
  const generation = setupGeneration.current;
  const closeSetup = () => {
    setupGeneration.current += 1;
    selectAiAccountMutation.reset();
    setOpen(false);
  };
  const queryClient = useQueryClient();
  const isAddressee = Boolean(
    currentUserId && interaction.addresseeUserId === currentUserId,
  );
  const isPending = interaction.status === "pending";
  const isAi = interaction.payload.purpose === "ai";
  const isChatHandoff = Boolean(interaction.payload.savedSetup);
  const provider = isAi ? aiProviderSchema.safeParse(interaction.payload.serviceSlug).data : undefined;
  const serviceName = provider ? AI_CONNECTION_CAPABILITIES[provider].name : interaction.payload.serviceName;
  const isEmail = interaction.payload.purpose === "channel" && interaction.payload.serviceSlug === "agentmail";
  const accessRequest = interaction.payload.accessRequest;
  const agentQuery = useQuery({
    queryKey: ["agents", "detail", interaction.payload.requestingAgentId, interaction.companyId],
    queryFn: () => agentsApi.get(interaction.payload.requestingAgentId, interaction.companyId),
    enabled: Boolean(accessRequest) && isPending,
  });
  const focusTargetId = `connection-intent-focus-target-${interaction.id}`;

  const invalidateTask = async (
    updatedInteraction?: ConnectionIntentInteraction,
  ) => {
    if (updatedInteraction) {
      queryClient.setQueriesData<ConnectionIntentInteraction[]>(
        { queryKey: ["issues", "interactions"] },
        (current) =>
          current?.map((candidate) =>
            candidate.id === updatedInteraction.id
              ? updatedInteraction
              : candidate,
          ),
      );
    }
    await Promise.all([
      // Task routes may key these caches by either UUID or human identifier.
      // Prefix invalidation reaches the mounted task without requiring that
      // routing identity to leak into the reusable interaction card.
      queryClient.invalidateQueries({ queryKey: ["issues", "interactions"] }),
      queryClient.invalidateQueries({ queryKey: ["issues", "detail"] }),
    ]);
  };
  const returnFocusToCard = () => {
    // Completing an intent can move it from the composer takeover to the
    // durable timeline. That replaces this component instance, so its ref can
    // be cleared before focus restoration runs. Retry for a few paint frames
    // and resolve the stable interaction-specific target from the new host.
    const focusCurrentTarget = (remainingAttempts: number) => {
      window.requestAnimationFrame(() => {
        const target =
          document.getElementById(focusTargetId) ?? focusTargetRef.current;
        target?.focus();
        if (remainingAttempts > 1) {
          focusCurrentTarget(remainingAttempts - 1);
        }
      });
    };
    focusCurrentTarget(3);
  };

  const setupQuery = useQuery({
    queryKey: ["connection-intent", interaction.id, "setup-options"],
    queryFn: () => connectionIntentsApi.setupOptions(interaction.id),
    enabled: isAddressee && isPending,
    refetchInterval: isPending && (open || interaction.payload.phase === "authorizing") ? 2_000 : false,
  });
  const setupView = useQueryView(setupQuery);
  // Loaded options stay usable through a transient refetch failure (`stale`);
  // only a real failure, or nothing loaded yet, shows the setup placeholder.
  const setupUnavailable = setupQuery.isLoading || setupView.kind === "reconnecting" || setupView.kind === "error";

  useEffect(() => {
    const current = setupQuery.data?.interaction;
    if (current && current.status !== "pending" && isPending) {
      void invalidateTask(current);
      setOpen(false);
      returnFocusToCard();
    }
  }, [setupQuery.data?.interaction, isPending]);

  const completeMutation = useMutation({
    mutationFn: (connectionId: string) =>
      connectionIntentsApi.complete(interaction.id, connectionId),
    onSuccess: async (updatedInteraction) => {
      await invalidateTask(updatedInteraction);
      setOpen(false);
      returnFocusToCard();
    },
  });
  const adoptMutation = useMutation({
    mutationFn: (connectionId: string) => agentsApi.adoptAiConnection(
      interaction.payload.requestingAgentId, interaction.id, connectionId, interaction.companyId,
    ),
    onSuccess: async (updatedInteraction) => {
      await invalidateTask(updatedInteraction);
      setAdoptionConnectionId(null);
      setOpen(false);
      returnFocusToCard();
    },
  });
  const declineMutation = useMutation({
    mutationFn: () => connectionIntentsApi.decline(interaction.id),
    onSuccess: async (updatedInteraction) => {
      await invalidateTask(updatedInteraction);
      setOpen(false);
      returnFocusToCard();
    },
  });
  const phaseMutation = useMutation({
    mutationFn: (phase: ConnectionIntentInteraction["payload"]["phase"]) =>
      connectionIntentsApi.setPhase(interaction.id, phase),
    onSuccess: invalidateTask,
  });
  const mutatePhase = phaseMutation.mutate;
  const handlePhaseChange = useCallback(
    (phase: ConnectionIntentInteraction["payload"]["phase"]) =>
      mutatePhase(phase),
    [mutatePhase],
  );

  const finishNewConnection = async (completion: ConnectionSetupCompletion) => {
    // A completed credential save survives cancellation, but an abandoned form
    // must not accept the task request (even if a new form has since opened).
    if (isAi && generation !== setupGeneration.current) {
      await setupQuery.refetch();
      return;
    }
    if (completion.resolvedByCallback) {
      // A browser message cannot establish authorization. Read the durable result.
      const verified = await setupQuery.refetch();
      if (verified.data?.interaction.status !== "accepted") return;
      await invalidateTask(verified.data.interaction);
      setOpen(false);
      returnFocusToCard();
      return;
    }
    if (setupQuery.data?.aiConnectionRequiresAdoption) {
      setAdoptionConnectionId(completion.connectionId);
    } else {
      completeMutation.mutate(completion.connectionId);
    }
  };

  const selectAiAccountMutation = useMutation({
    mutationFn: async (result: { connectionId: string; grantId: string; method: AiAuthMethod; generation: number }) => {
      if (result.generation !== setupGeneration.current) {
        await setupQuery.refetch();
        return;
      }
      const binding = setupQuery.data?.aiConnection;
      const previous = setupQuery.data?.aiRepair?.connection;
      if (binding && previous && result.connectionId !== previous.id) {
        if (binding.mode === "responsible_user") {
          await aiConnectionsApi.setDefault(interaction.companyId, result.grantId);
        } else {
          const agent = await agentsApi.get(interaction.payload.requestingAgentId, interaction.companyId);
          const current = agent.runtimeConfig.aiConnection;
          if (!current || current.mode === "responsible_user" || current.mode === "router" || current.connectionId !== previous.id || current.grantId !== previous.grantId) {
            throw new Error(t("apps.ConnectionIntentInteractionBody.connectionChanged"));
          }
          if (result.generation !== setupGeneration.current) return;
          await agentsApi.update(agent.id, {
            runtimeConfig: { ...agent.runtimeConfig, aiConnection: { ...binding, method: result.method, connectionId: result.connectionId, grantId: result.grantId } },
          }, interaction.companyId);
        }
        await queryClient.invalidateQueries({ queryKey: ["ai-connections", interaction.companyId] });
      }
      if (result.generation === setupGeneration.current) await finishNewConnection(result);
    },
  });

  const setupProps: ConnectionSetupFlowProps | null = setupQuery.data ? {
    host: "dialog",
    upstreamServiceName: interaction.payload.upstreamService?.name,
    serviceSlug: interaction.payload.serviceSlug.startsWith("connection:") ? undefined : interaction.payload.serviceSlug,
    configuredConnection: interaction.payload.serviceSlug.startsWith("connection:") ? setupQuery.data.existingConnections[0] : undefined,
    // Tool setup uses the same audience defaults and controls as Apps.
    // Runtime authentication and inboxes still belong to the requesting agent.
    requestedAgentId: interaction.payload.purpose ? setupQuery.data.requestedAgentId : undefined,
    requiredAgentId: interaction.payload.purpose ? undefined : setupQuery.data.requestedAgentId,
    setupAccess: setupQuery.data.interaction?.payload.setupAccess,
    aiConnection: setupQuery.data.aiConnection,
    interactionId: interaction.id,
    existingConnections: setupQuery.data.existingConnections,
    onUseExisting: async (connectionId) => { await completeMutation.mutateAsync(connectionId); },
    onComplete: (completion) => { void finishNewConnection(completion); },
    onOAuthDeclined: () => declineMutation.mutate(),
    onPhaseChange: handlePhaseChange,
    onCancel: () => { closeSetup(); returnFocusToCard(); },
  } : null;

  const resultOutcome = interaction.result?.outcome;
  const status =
    interaction.status === "accepted"
      ? {
          icon: CheckCircle2,
          title: accessRequest ? t("apps.ConnectionIntentInteractionBody.accessGranted", { name: serviceName }) : interaction.payload.upstreamService ? t("apps.ConnectionIntentInteractionBody.externalConnected") : t("apps.ConnectionIntentInteractionBody.connected", { name: serviceName }),
          body: accessRequest ? null : interaction.payload.upstreamService ? t("apps.ConnectionIntentInteractionBody.upstreamVerified", { agent: interaction.payload.requestingAgentName, service: interaction.payload.upstreamService.name }) : isAi ? t("apps.ConnectionIntentInteractionBody.agentCanUse") : t("apps.ConnectionIntentInteractionBody.continuationRun", { agent: interaction.payload.requestingAgentName }),
        }
      : interaction.status === "cancelled"
        ? {
            icon: XCircle,
            title: t("apps.ConnectionIntentInteractionBody.withdrawn"),
            body: t("apps.ConnectionIntentInteractionBody.inactive"),
          }
      : interaction.status === "rejected"
        ? {
            icon: XCircle,
            title: accessRequest ? t("apps.ConnectionIntentInteractionBody.accessDeclined") : t("apps.ConnectionIntentInteractionBody.connectionDeclined"),
            body: accessRequest ? null : isAi ? t("apps.ConnectionIntentInteractionBody.needsAiConnection") : t("apps.ConnectionIntentInteractionBody.agentNotified", { agent: interaction.payload.requestingAgentName }),
          }
        : interaction.status === "expired"
          ? {
              icon: Clock,
              title:
                resultOutcome === "superseded"
                  ? t("apps.ConnectionIntentInteractionBody.superseded")
                  : t("apps.ConnectionIntentInteractionBody.expired"),
              body:
                resultOutcome === "superseded"
                  ? t("apps.ConnectionIntentInteractionBody.supersededBody")
                  : // The server stores the reason an expiry happened and what to
                    // do next; without it the card only says the request is gone.
                    interaction.result?.reason?.trim()
                    || t("apps.ConnectionIntentInteractionBody.inactive"),
            }
          : null;
  const StatusIcon = status?.icon;

  if (status && StatusIcon) {
    return (
      <div
        id={focusTargetId}
        ref={focusTargetRef}
        tabIndex={-1}
        data-testid="connection-intent-focus-target"
      >
        <div
          className="flex items-start gap-3"
          data-testid="connection-intent-terminal"
        >
          <StatusIcon className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          <div>
            <p className="font-medium text-foreground">{status.title}</p>
            {status.body ? <p className="mt-1 text-sm text-muted-foreground">{status.body}</p> : null}
          </div>
        </div>
        <DecisionCardFooter leading={footerSlot} className="mt-4" />
      </div>
    );
  }

  if (!isAddressee) {
    return (
      <div
        id={focusTargetId}
        ref={focusTargetRef}
        tabIndex={-1}
        data-testid="connection-intent-focus-target"
      >
        <div
          className="flex items-start gap-3"
          data-testid="connection-intent-waiting"
        >
          <Clock className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          <div>
            <p className="font-medium text-foreground">
              {t("apps.ConnectionIntentInteractionBody.waitingFor", { label: addresseeLabel })}
            </p>
            {!accessRequest ? <p className="mt-1 text-sm text-muted-foreground">
              {t("apps.ConnectionIntentInteractionBody.onlyAddressed")}
            </p> : null}
          </div>
        </div>
        <DecisionCardFooter leading={footerSlot} className="mt-4" />
      </div>
    );
  }

  const needsRetry = interaction.payload.phase === "needs_retry";
  const authorizing = interaction.payload.phase === "authorizing";

  if (accessRequest) {
    const busy = completeMutation.isPending || declineMutation.isPending;
    return <div id={focusTargetId} ref={focusTargetRef} tabIndex={-1} data-testid="connection-intent-focus-target">
      <div data-testid="connection-intent-access-request" className="space-y-3 rounded-lg border border-border bg-card p-4">
        <div className="flex items-center gap-3">
          <AgentAvatar agent={agentQuery.data ?? { id: interaction.payload.requestingAgentId, name: interaction.payload.requestingAgentName }} size={32} label={interaction.payload.requestingAgentName} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">{t("apps.ConnectionIntentInteractionBody.grantAccess", { agent: interaction.payload.requestingAgentName, connection: accessRequest.connectionName })}</p>
          </div>
          <AppLogo name={interaction.payload.serviceName} logoUrl={interaction.payload.serviceLogoUrl} darkLogoUrl={interaction.payload.serviceDarkLogoUrl} size={32} />
        </div>
        <ul aria-label={t("apps.ConnectionIntentInteractionBody.toolPermissions")} className="max-h-48 space-y-2 overflow-y-auto text-xs">
          {accessRequest.tools.map(tool => <li key={tool.catalogEntryId} className="flex items-start justify-between gap-3">
            <span className="min-w-0 break-all font-mono text-foreground">{tool.toolName}</span>
            <span className="shrink-0 text-muted-foreground">{tool.permission === "allowed" ? t("apps.ConnectionIntentInteractionBody.allowed") : t("apps.ConnectionIntentInteractionBody.askFirst")}</span>
          </li>)}
        </ul>
        {setupView.kind === "error" ? <QueryErrorState size="inline" error={setupQuery.error} action={t("apps.ConnectionIntentInteractionBody.loadAccess")} onRetry={setupView.retry} retrying={setupView.isFetching} /> : null}
        {completeMutation.error || declineMutation.error ? <p role="alert" className="text-sm text-destructive">{describeError(completeMutation.error ?? declineMutation.error).body}</p> : null}
        {setupQuery.data?.canGrantAccess === false ? <p role="status" className="text-sm text-muted-foreground">{t("apps.ConnectionIntentInteractionBody.managerRequired")}</p> : null}
        <DecisionCardFooter leading={footerSlot}>
          <div className={footerSlot ? "flex flex-wrap items-center justify-end gap-2" : "flex items-center justify-between gap-2"}>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => declineMutation.mutate()}>{t("apps.ConnectionIntentInteractionBody.notNow")}</Button>
          <Button size="sm" disabled={busy || !setupQuery.data?.canGrantAccess} onClick={() => completeMutation.mutate(accessRequest.connectionId)}>
            {completeMutation.isPending ? t("apps.ConnectionIntentInteractionBody.granting") : t("apps.ConnectionIntentInteractionBody.grant")}
          </Button>
          </div>
        </DecisionCardFooter>
      </div>
    </div>;
  }

  const repair = setupQuery.data?.aiRepair;
  const selectedReady = repair && setupQuery.data?.existingConnections.some((connection) => connection.id === repair.connection.id);
  const readyForAdoption = setupQuery.data?.aiConnectionRequiresAdoption
    ? adoptionConnectionId ?? (selectedReady ? repair.connection.id : null)
    : null;
  const setupContent = setupQuery.isLoading || setupView.kind === "reconnecting" ? (
                <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> {t("apps.ConnectionIntentInteractionBody.loadingOptions")}
                </div>
              ) : setupView.kind === "error" ? (
                <div className="py-6">
                  <QueryErrorState
                    error={setupQuery.error}
                    action={t("apps.ConnectionIntentInteractionBody.loadSetup")}
                    onRetry={setupView.retry}
                    retrying={setupView.isFetching}
                  />
                </div>
              ) : setupProps ? (
                renderSetup ? renderSetup(setupProps) : <ConnectionSetupFlow {...setupProps} />
              ) : null;
  const aiConnection = setupQuery.data?.aiConnection;
  const needsOwnAiConnection = isAi && (!repair || setupQuery.data?.aiConnectionRequiresAdoption) && aiConnection?.mode === "responsible_user";
  const aiProviderName = aiConnection ? AI_CONNECTION_CAPABILITIES[aiConnection.provider].name : serviceName;
  const inlineContent = setupUnavailable ? setupContent
    : readyForAdoption ? <div className="space-y-3">
        <p className="text-sm">
          {t("apps.ConnectionIntentInteractionBody.adoptPrompt", { provider: aiProviderName, agent: interaction.payload.requestingAgentName })}
        </p>
        <Button disabled={adoptMutation.isPending} onClick={() => adoptMutation.mutate(readyForAdoption)}>
          {adoptMutation.isPending ? t("apps.ConnectionIntentInteractionBody.checkingConnection") : t("apps.ConnectionIntentInteractionBody.useAndContinue")}
        </Button>
      </div>
    : selectedReady ? <div className="space-y-3">
        <p className="text-sm">{t("apps.ConnectionIntentInteractionBody.ready", { name: repair.connection.name })}</p>
        <Button disabled={completeMutation.isPending} onClick={() => completeMutation.mutate(repair.connection.id)}>
          {completeMutation.isPending ? t("apps.ConnectionIntentInteractionBody.continuing") : t("apps.ConnectionIntentInteractionBody.continueTask")}
        </Button>
      </div>
    : repair ? repair.canReconnect ? repair.connection.routing ? <AiProviderSetup
        companyId={interaction.companyId}
        agentId={interaction.payload.requestingAgentId}
        reconnect={repair.connection}
        onComplete={(binding) => selectAiAccountMutation.mutate({ connectionId: binding.connectionId, grantId: binding.grantId, method: binding.method ?? "api_key", generation })}
        onCancel={() => { closeSetup(); returnFocusToCard(); }}
      /> : <AiConnectionCredentialStep
        companyId={interaction.companyId}
        provider={repair.connection.provider}
        initialMethod={repair.connection.method}
        fixedMethod={false}
        connectionId={repair.connection.id}
        name={repair.connection.name}
        nameForMethod={(method) => defaultAiConnectionName(addresseeName ?? addresseeLabel, repair.connection.provider, method)}
        hideName
        ownership={repair.connection.ownership}
        agentIds={[interaction.payload.requestingAgentId]}
        allAgents={false}
        onComplete={(result) => selectAiAccountMutation.mutate({ ...result, generation })}
        onCancel={() => { closeSetup(); returnFocusToCard(); }}
      /> : <p role="status" className="text-sm text-muted-foreground">
        {repair.connection.ownership === "personal" ? t("apps.ConnectionIntentInteractionBody.reconnectOwner", { owner: repair.connection.ownerName ?? t("apps.ConnectionIntentInteractionBody.accountOwner"), name: repair.connection.name }) : t("apps.ConnectionIntentInteractionBody.reconnectNoOwner", { name: repair.connection.name })}
        {" "}{t("apps.ConnectionIntentInteractionBody.continueOnceRestored")}
      </p>
    : aiConnection && aiConnection.mode !== "responsible_user"
      ? <p role="status" className="text-sm text-muted-foreground">{t("apps.ConnectionIntentInteractionBody.accountUnavailable")}</p>
      : aiConnection ? <AiConnectionCredentialStep
          companyId={interaction.companyId}
          provider={aiConnection.provider}
          name={defaultAiConnectionName(addresseeName ?? addresseeLabel, aiConnection.provider, "subscription")}
          hideName
          nameForMethod={(method) => defaultAiConnectionName(addresseeName ?? addresseeLabel, aiConnection.provider, method)}
          ownership="personal"
          agentIds={[interaction.payload.requestingAgentId]}
          allAgents={false}
          onComplete={(result) => selectAiAccountMutation.mutate({ ...result, generation })}
          onCancel={() => { closeSetup(); returnFocusToCard(); }}
        /> : setupContent;

  return (
    <div
      id={focusTargetId}
      ref={focusTargetRef}
      tabIndex={-1}
      data-testid="connection-intent-focus-target"
    >
      <div data-testid="connection-intent-actions">
        <div className="flex items-start gap-3">
          <AppLogo
            name={interaction.payload.serviceName}
            logoUrl={interaction.payload.serviceLogoUrl}
            darkLogoUrl={interaction.payload.serviceDarkLogoUrl}
            size={40}
          />
          <div>
            <p className="font-medium text-foreground">
              {readyForAdoption ? t("apps.ConnectionIntentInteractionBody.titleUseAccount", { provider: aiProviderName }) : needsOwnAiConnection ? t("apps.ConnectionIntentInteractionBody.titleConnectAccount", { provider: aiProviderName }) : isAi ? t("apps.ConnectionIntentInteractionBody.titleAuthRequired", { provider: aiProviderName }) : t("apps.ConnectionIntentInteractionBody.titleNeeds", { agent: interaction.payload.requestingAgentName, service: interaction.payload.serviceName })}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {readyForAdoption
                ? t("apps.ConnectionIntentInteractionBody.accountConnected", { agent: interaction.payload.requestingAgentName })
                : needsOwnAiConnection
                ? t("apps.ConnectionIntentInteractionBody.needsOwnAi", { agent: interaction.payload.requestingAgentName })
                : interaction.payload.purpose === "ai"
                ? t("apps.ConnectionIntentInteractionBody.aiRequired")
                : isChatHandoff ? t("apps.ConnectionIntentInteractionBody.chatHandoff")
                : isEmail ? t("apps.ConnectionIntentInteractionBody.emailNotice")
                : "New connections default to all agents; you can choose fewer during setup. Reusing an account adds access for this agent."}
            </p>
          </div>
        </div>

        {needsRetry ? (
          <p className="mt-4 flex items-center gap-2 text-sm text-destructive">
            <RotateCcw className="h-4 w-4" />
            {t("apps.ConnectionIntentInteractionBody.retryNotice")}
          </p>
        ) : null}

        {isChatHandoff ? <div className="mt-4 flex items-center justify-between gap-2">
          <Button type="button" variant="ghost" disabled={declineMutation.isPending} onClick={() => declineMutation.mutate()}>{t("apps.ConnectionIntentInteractionBody.notNow")}</Button>
          {setupQuery.data?.chatSetup ? <Button asChild><a href={setupQuery.data.chatSetup.path} target="_blank" rel="noopener noreferrer">{t("apps.ConnectionIntentInteractionBody.continueAuth")}</a></Button> : setupContent}
        </div> : isEmail ? setupUnavailable ? <>
          {setupContent}
          <Button type="button" variant="ghost" disabled={declineMutation.isPending} onClick={() => declineMutation.mutate()}>{t("apps.ConnectionIntentInteractionBody.notNow")}</Button>
        </> : <AgentMailIntentSetup
          companyId={interaction.companyId}
          agentId={interaction.payload.requestingAgentId}
          requestId={interaction.id}
          savedCredentialId={setupQuery.data?.emailSetup?.credentialConnectionId}
          readyConnectionId={setupQuery.data?.emailSetup?.readyConnectionId}
          onComplete={async connectionId => { await completeMutation.mutateAsync(connectionId); }}
          onDecline={() => declineMutation.mutate()}
          declining={declineMutation.isPending}
        /> : <DecisionCardFooter leading={footerSlot} className="mt-4">
          <div className={footerSlot ? "flex flex-wrap items-center justify-end gap-2" : "mt-4 flex flex-wrap justify-end gap-2"}>
            {!isAi && <Button
              type="button"
              variant="ghost"
              disabled={declineMutation.isPending || completeMutation.isPending || authorizing}
              onClick={() => declineMutation.mutate()}
            >
              {t("apps.ConnectionIntentInteractionBody.notNow")}
            </Button>}
            {isAi ? <Button type="button" disabled={completeMutation.isPending || adoptMutation.isPending || selectAiAccountMutation.isPending} onClick={() => open ? closeSetup() : setOpen(true)}>
              <Plug className="h-4 w-4" />{open ? t("apps.ConnectionIntentInteractionBody.closeSetup") : readyForAdoption ? t("apps.ConnectionIntentInteractionBody.continueSetup") : needsOwnAiConnection ? t("apps.ConnectionIntentInteractionBody.connectProvider", { provider: aiProviderName }) : t("apps.ConnectionIntentInteractionBody.fixConnection")}
            </Button> : <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger asChild>
                <Button type="button">
                  {authorizing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Plug className="h-4 w-4" />
                  )}
                  {authorizing
                    ? t("apps.ConnectionIntentInteractionBody.continueSetup")
                    : needsRetry
                      ? t("apps.ConnectionIntentInteractionBody.tryAgain")
                      : setupQuery.data?.existingConnections.length ? t("apps.ConnectionIntentInteractionBody.connectOrUse") : t("apps.ConnectionIntentInteractionBody.connect")}
                </Button>
              </DialogTrigger>
              <DialogContent
                className="max-h-(--sz-85vh) overflow-y-auto sm:max-w-3xl"
                showCloseButton={false}
                onCloseAutoFocus={(event) => {
                  event.preventDefault();
                  focusTargetRef.current?.focus();
                }}
              >
                <DialogHeader className="sr-only">
                  <DialogTitle>
                    {t("apps.ConnectionIntentInteractionBody.connectTitle", { name: interaction.payload.serviceName })}
                  </DialogTitle>
                  <DialogDescription>
                    {t("apps.ConnectionIntentInteractionBody.setupDescription")}
                  </DialogDescription>
                </DialogHeader>
                {setupContent}
              </DialogContent>
            </Dialog>}
          </div>
        </DecisionCardFooter>}
        {isEmail ? <DecisionCardFooter leading={footerSlot} className="mt-4" /> : null}
        {isAi && open ? <div className="mt-4 border-t border-border pt-4" data-testid="ai-connection-inline-repair">{inlineContent}</div> : null}

        {(!isEmail && completeMutation.error) ||
        (selectAiAccountMutation.error && selectAiAccountMutation.variables?.generation === generation) ||
        adoptMutation.error ||
        declineMutation.error ||
        phaseMutation.error ? (
          <p className="mt-3 text-sm text-destructive" role="alert">
            {describeError(
              completeMutation.error ??
                selectAiAccountMutation.error ??
                adoptMutation.error ??
                declineMutation.error ??
                phaseMutation.error,
            ).body}
          </p>
        ) : null}
        {selectAiAccountMutation.error && selectAiAccountMutation.variables?.generation === generation && (
          <Button className="mt-3" onClick={() => selectAiAccountMutation.mutate(selectAiAccountMutation.variables!)}>
            {t("apps.ConnectionIntentInteractionBody.retryUsing")}
          </Button>
        )}
      </div>
    </div>
  );
}
