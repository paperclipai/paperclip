import { useTranslation } from "@/i18n";
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
  const { t } = useTranslation("connections");
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
    [mutatePhase, t],
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
            throw new Error(t("the_agent_s_ai_connection_changed_reload_0f660f2"));
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
    requestedAgentId: setupQuery.data.requestedAgentId,
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
          title: accessRequest ? t("access_granted_128de21", { serviceName: serviceName }) : interaction.payload.upstreamService ? t("external_provider_connected_bde41e0") : t("connected_a52c652", { serviceName: serviceName }),
          body: accessRequest ? null : interaction.payload.upstreamService ? t("can_now_verify_and_authorize_through_this_24bd0e1", { requestingAgentName: interaction.payload.requestingAgentName, name: interaction.payload.upstreamService.name }) : isAi ? t("this_agent_can_now_use_the_connection_ee25acc") : t("can_use_this_connection_on_the_continuation_1b44db0", { requestingAgentName: interaction.payload.requestingAgentName }),
        }
      : interaction.status === "cancelled"
        ? {
            icon: XCircle,
            title: t("connection_request_withdrawn_bc60dc8"),
            body: t("this_request_is_no_longer_active_e0aa7b1"),
          }
      : interaction.status === "rejected"
        ? {
            icon: XCircle,
            title: accessRequest ? t("access_declined_fc75015") : t("connection_declined_4ce8768"),
            body: accessRequest ? null : isAi ? t("the_task_still_needs_a_working_ai_11f0117") : t("was_notified_and_can_continue_without_it_91b4281", { requestingAgentName: interaction.payload.requestingAgentName }),
          }
        : interaction.status === "expired"
          ? {
              icon: Clock,
              title:
                resultOutcome === "superseded"
                  ? t("request_superseded_7970014")
                  : t("connection_request_expired_42c3686"),
              body:
                resultOutcome === "superseded"
                  ? t("this_request_was_replaced_use_the_latest_47b569d")
                  : // The server stores the reason an expiry happened and what to
                    // do next; without it the card only says the request is gone.
                    interaction.result?.reason?.trim()
                    || t("this_request_is_no_longer_active_e0aa7b1"),
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
            <p className="font-medium text-foreground">{t("waiting_for_5d13e3e", { addresseeLabel: addresseeLabel })}</p>
            {!accessRequest ? <p className="mt-1 text-sm text-muted-foreground">{t("only_the_addressed_person_can_choose_an_5f5eb37")}</p> : null}
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
            <p className="text-sm font-medium text-foreground">{t("grant_access_to_2b069c1", { requestingAgentName: interaction.payload.requestingAgentName, connectionName: accessRequest.connectionName })}</p>
          </div>
          <AppLogo name={interaction.payload.serviceName} logoUrl={interaction.payload.serviceLogoUrl} darkLogoUrl={interaction.payload.serviceDarkLogoUrl} size={32} />
        </div>
        <ul aria-label={t("tool_permissions_a5465e3")} className="max-h-48 space-y-2 overflow-y-auto text-xs">
          {accessRequest.tools.map(tool => <li key={tool.catalogEntryId} className="flex items-start justify-between gap-3">
            <span className="min-w-0 break-all font-mono text-foreground">{tool.toolName}</span>
            <span className="shrink-0 text-muted-foreground">{tool.permission === "allowed" ? t("allowed_77c7b49") : t("ask_first_1aeb84d")}</span>
          </li>)}
        </ul>
        {setupView.kind === "error" ? <QueryErrorState size="inline" error={setupQuery.error} action="load this access request" onRetry={setupView.retry} retrying={setupView.isFetching} /> : null}
        {completeMutation.error || declineMutation.error ? <p role="alert" className="text-sm text-destructive">{describeError(completeMutation.error ?? declineMutation.error).body}</p> : null}
        {setupQuery.data?.canGrantAccess === false ? <p role="status" className="text-sm text-muted-foreground">{t("connection_manager_required_8e95adc")}</p> : null}
        <DecisionCardFooter leading={footerSlot}>
          <div className={footerSlot ? "flex flex-wrap items-center justify-end gap-2" : "flex items-center justify-between gap-2"}>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => declineMutation.mutate()}>{t("not_now_e457149")}</Button>
          <Button size="sm" disabled={busy || !setupQuery.data?.canGrantAccess} onClick={() => completeMutation.mutate(accessRequest.connectionId)}>
            {completeMutation.isPending ? t("granting_access_98efa22") : t("grant_access_6c7847a")}
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
                  <Loader2 className="h-4 w-4 animate-spin" />{t("loading_connection_options_4763b52")}</div>
              ) : setupView.kind === "error" ? (
                <div className="py-6">
                  <QueryErrorState
                    error={setupQuery.error}
                    action="load connection setup"
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
        <p className="text-sm">{t("use_your_connection_for_this_replaces_the_a0fc84c", { aiProviderName: aiProviderName, requestingAgentName: interaction.payload.requestingAgentName })}</p>
        <Button disabled={adoptMutation.isPending} onClick={() => adoptMutation.mutate(readyForAdoption)}>
          {adoptMutation.isPending ? t("checking_connection_7bf9820") : t("use_connection_and_continue_4fcfdef")}
        </Button>
      </div>
    : selectedReady ? <div className="space-y-3">
        <p className="text-sm">{t("is_ready_68983a5", { name: repair.connection.name })}</p>
        <Button disabled={completeMutation.isPending} onClick={() => completeMutation.mutate(repair.connection.id)}>
          {completeMutation.isPending ? t("continuing_ce1e90d") : t("continue_task_df1a735")}
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
      /> : <p role="status" className="text-sm text-muted-foreground">{t("you_can_continue_here_once_it_is_be10abf", { owner: repair.connection.ownership === "personal" ? repair.connection.ownerName ?? t("reviewBAccountOwner") : t("reviewBAccountOwner"), connectionName: repair.connection.name })}</p>
    : aiConnection && aiConnection.mode !== "responsible_user"
      ? <p role="status" className="text-sm text-muted-foreground">{t("the_selected_account_is_no_longer_available_e0e7191")}</p>
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
              {readyForAdoption ? t("use_your_account_6150cde", { aiProviderName: aiProviderName }) : needsOwnAiConnection ? t("connect_your_account_9d2614f", { aiProviderName: aiProviderName }) : isAi ? t("authentication_required_c164286", { aiProviderName: aiProviderName }) : t("needs_2e90186", { requestingAgentName: interaction.payload.requestingAgentName, serviceName: interaction.payload.serviceName })}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {readyForAdoption
                ? t("your_account_is_connected_use_it_for_cf6be3c", { requestingAgentName: interaction.payload.requestingAgentName })
                : needsOwnAiConnection
                ? t("needs_your_own_ai_connection_connect_here_2cbc218", { requestingAgentName: interaction.payload.requestingAgentName })
                : interaction.payload.purpose === "ai"
                ? t("this_task_can_t_run_until_the_dcb0409")
                : isChatHandoff ? t("complete_the_human_sign_in_step_in_fd2c705")
                : isEmail ? t("connect_agentmail_to_create_an_email_address_3f43470")
                : t("connect_your_identity_or_reuse_an_eligible_3147332")}
            </p>
          </div>
        </div>

        {needsRetry ? (
          <p className="mt-4 flex items-center gap-2 text-sm text-destructive">
            <RotateCcw className="h-4 w-4" />{t("authorization_didn_t_finish_your_previous_choices_e95fcfa")}</p>
        ) : null}

        {isChatHandoff ? <div className="mt-4 flex items-center justify-between gap-2">
          <Button type="button" variant="ghost" disabled={declineMutation.isPending} onClick={() => declineMutation.mutate()}>{t("not_now_e457149")}</Button>
          {setupQuery.data?.chatSetup ? <Button asChild><a href={setupQuery.data.chatSetup.path} target="_blank" rel="noopener noreferrer">{t("continue_authentication_ab8ec82")}</a></Button> : setupContent}
        </div> : isEmail ? setupUnavailable ? <>
          {setupContent}
          <Button type="button" variant="ghost" disabled={declineMutation.isPending} onClick={() => declineMutation.mutate()}>{t("not_now_e457149")}</Button>
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
            >{t("not_now_6448c81")}</Button>}
            {isAi ? <Button type="button" disabled={completeMutation.isPending || adoptMutation.isPending || selectAiAccountMutation.isPending} onClick={() => open ? closeSetup() : setOpen(true)}>
              <Plug className="h-4 w-4" />{open ? t("close_setup_0a8c2ab") : readyForAdoption ? t("continue_setup_7a4e54c") : needsOwnAiConnection ? t("connect_ed16a8c", { aiProviderName: aiProviderName }) : t("fix_connection_b7ed986")}
            </Button> : <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger asChild>
                <Button type="button">
                  {authorizing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Plug className="h-4 w-4" />
                  )}
                  {authorizing
                    ? t("continue_setup_7a4e54c")
                    : needsRetry
                      ? t("try_again_042c862")
                      : setupQuery.data?.existingConnections.length ? t("connect_use_existing_ce6aea2") : t("connect_b65463c")}
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
                  <DialogTitle>{t("connect_b8895da", { serviceName: interaction.payload.serviceName })}</DialogTitle>
                  <DialogDescription>{t("complete_connection_setup_without_leaving_this_task_356f69a")}</DialogDescription>
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
          <Button className="mt-3" onClick={() => selectAiAccountMutation.mutate(selectAiAccountMutation.variables!)}>{t("retry_using_this_connection_b34d551")}</Button>
        )}
      </div>
    </div>
  );
}
