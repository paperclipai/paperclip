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
import type { AiAuthMethod, ConnectionIntentInteraction } from "@paperclipai/shared";
import { AgentMailIntentSetup } from "./AgentMailIntentSetup";
import { connectionIntentsApi } from "@/api/connection-intents";
import { aiConnectionsApi } from "@/api/ai-connections";
import { agentsApi } from "@/api/agents";
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

export interface ConnectionIntentInteractionBodyProps {
  interaction: ConnectionIntentInteraction;
  currentUserId?: string | null;
  addresseeLabel: string;
  addresseeName?: string;
  renderSetup?: (props: ConnectionSetupFlowProps) => ReactNode;
}

export function ConnectionIntentInteractionBody({
  interaction,
  currentUserId,
  addresseeLabel,
  addresseeName,
  renderSetup,
}: ConnectionIntentInteractionBodyProps) {
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
            throw new Error("The agent’s AI connection changed. Reload the task and try again.");
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
          title: accessRequest ? `${interaction.payload.serviceName} access granted` : interaction.payload.upstreamService ? "External provider connected" : `${interaction.payload.serviceName} connected`,
          body: accessRequest ? null : interaction.payload.upstreamService ? `${interaction.payload.requestingAgentName} can now verify and authorize ${interaction.payload.upstreamService.name} through this provider. The app is not yet verified.` : isAi ? "This agent can now use the connection." : `${interaction.payload.requestingAgentName} can use this connection on the continuation run.`,
        }
      : interaction.status === "rejected"
        ? {
            icon: XCircle,
            title: accessRequest ? "Access declined" : "Connection declined",
            body: accessRequest ? null : isAi ? "The task still needs a working AI connection before it can run." : `${interaction.payload.requestingAgentName} was notified and can continue without it.`,
          }
        : interaction.status === "expired"
          ? {
              icon: Clock,
              title:
                resultOutcome === "superseded"
                  ? "Request superseded"
                  : "Connection request expired",
              body:
                resultOutcome === "superseded"
                  ? "This request was replaced. Use the latest connection card instead."
                  : "This request is no longer active.",
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
              Waiting for {addresseeLabel}
            </p>
            {!accessRequest ? <p className="mt-1 text-sm text-muted-foreground">
              Only the addressed person can choose an identity or authorize this
              connection.
            </p> : null}
          </div>
        </div>
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
            <p className="text-sm font-medium text-foreground">Grant {interaction.payload.requestingAgentName} access to “{accessRequest.connectionName}”?</p>
          </div>
          <AppLogo name={interaction.payload.serviceName} logoUrl={interaction.payload.serviceLogoUrl} darkLogoUrl={interaction.payload.serviceDarkLogoUrl} size={32} />
        </div>
        <ul aria-label="Tool permissions" className="max-h-48 space-y-2 overflow-y-auto text-xs">
          {accessRequest.tools.map(tool => <li key={tool.catalogEntryId} className="flex items-start justify-between gap-3">
            <span className="min-w-0 break-all font-mono text-foreground">{tool.toolName}</span>
            <span className="shrink-0 text-muted-foreground">{tool.permission === "allowed" ? "Allowed" : "Ask first"}</span>
          </li>)}
        </ul>
        {setupQuery.isError || completeMutation.isError || declineMutation.isError ? <p role="alert" className="text-sm text-destructive">{(completeMutation.error ?? declineMutation.error ?? setupQuery.error)?.message ?? "Couldn’t update this access request."}</p> : null}
        {setupQuery.data?.canGrantAccess === false ? <p role="status" className="text-sm text-muted-foreground">Connection manager required.</p> : null}
        <div className="flex items-center justify-between gap-2">
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => declineMutation.mutate()}>Not now</Button>
          <Button size="sm" disabled={busy || !setupQuery.data?.canGrantAccess} onClick={() => completeMutation.mutate(accessRequest.connectionId)}>
            {completeMutation.isPending ? "Granting access…" : "Grant access"}
          </Button>
        </div>
      </div>
    </div>;
  }

  const repair = setupQuery.data?.aiRepair;
  const selectedReady = repair && setupQuery.data?.existingConnections.some((connection) => connection.id === repair.connection.id);
  const readyForAdoption = setupQuery.data?.aiConnectionRequiresAdoption
    ? adoptionConnectionId ?? (selectedReady ? repair.connection.id : null)
    : null;
  const setupContent = setupQuery.isLoading ? (
                <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading
                  connection options…
                </div>
              ) : setupQuery.isError ? (
                <div className="py-8 text-center">
                  <p className="font-medium text-foreground">
                    Couldn’t load connection setup
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {setupQuery.error instanceof Error
                      ? setupQuery.error.message
                      : "Try again."}
                  </p>
                  <Button
                    className="mt-4"
                    variant="outline"
                    onClick={() => setupQuery.refetch()}
                  >
                    Try again
                  </Button>
                </div>
              ) : setupProps ? (
                renderSetup ? renderSetup(setupProps) : <ConnectionSetupFlow {...setupProps} />
              ) : null;
  const aiConnection = setupQuery.data?.aiConnection;
  const inlineContent = setupQuery.isLoading || setupQuery.isError ? setupContent
    : readyForAdoption ? <div className="space-y-3">
        <p className="text-sm">
          Use Connections for {interaction.payload.requestingAgentName}? This replaces the agent’s existing authentication
          with the responsible person’s {interaction.payload.serviceName} connection. The model stays the same.
        </p>
        <Button disabled={adoptMutation.isPending} onClick={() => adoptMutation.mutate(readyForAdoption)}>
          {adoptMutation.isPending ? "Checking connection…" : "Use connection and continue"}
        </Button>
      </div>
    : selectedReady ? <div className="space-y-3">
        <p className="text-sm">{repair.connection.name} is ready.</p>
        <Button disabled={completeMutation.isPending} onClick={() => completeMutation.mutate(repair.connection.id)}>
          {completeMutation.isPending ? "Continuing…" : "Continue task"}
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
        {repair.connection.ownership === "personal" ? `${repair.connection.ownerName ?? "The account owner"} must reconnect ${repair.connection.name}.` : `The account owner must reconnect ${repair.connection.name}.`}
        {" "}You can continue here once it is restored.
      </p>
    : aiConnection && aiConnection.mode !== "responsible_user"
      ? <p role="status" className="text-sm text-muted-foreground">The selected account is no longer available to you. Ask its owner to restore access, or choose an available AI connection in the agent’s settings.</p>
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
              {isAi ? `${interaction.payload.serviceName} authentication required` : `${interaction.payload.requestingAgentName} needs ${interaction.payload.serviceName}`}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {interaction.payload.purpose === "ai"
                ? "This task can’t run until the agent has a valid AI connection. Connect here and the task will resume automatically."
                : isEmail ? "Connect AgentMail to create an email address for this agent."
                : "Connect your identity or reuse an eligible connection. Access is added only for this agent."}
            </p>
          </div>
        </div>

        {needsRetry ? (
          <p className="mt-4 flex items-center gap-2 text-sm text-destructive">
            <RotateCcw className="h-4 w-4" />
            Authorization didn’t finish. Your previous choices are safe; try
            again.
          </p>
        ) : null}

        {isEmail ? setupQuery.isLoading || setupQuery.isError ? <>
          {setupContent}
          <Button type="button" variant="ghost" disabled={declineMutation.isPending} onClick={() => declineMutation.mutate()}>Not now</Button>
        </> : <AgentMailIntentSetup
          companyId={interaction.companyId}
          agentId={interaction.payload.requestingAgentId}
          requestId={interaction.id}
          savedCredentialId={setupQuery.data?.emailSetup?.credentialConnectionId}
          readyConnectionId={setupQuery.data?.emailSetup?.readyConnectionId}
          onComplete={async connectionId => { await completeMutation.mutateAsync(connectionId); }}
          onDecline={() => declineMutation.mutate()}
          declining={declineMutation.isPending}
        /> : <div className="mt-4 flex flex-wrap justify-end gap-2">
          {!isAi && <Button
            type="button"
            variant="ghost"
            disabled={declineMutation.isPending || completeMutation.isPending || authorizing}
            onClick={() => declineMutation.mutate()}
          >
            Not now
          </Button>}
          {isAi ? <Button type="button" disabled={completeMutation.isPending || adoptMutation.isPending || selectAiAccountMutation.isPending} onClick={() => open ? closeSetup() : setOpen(true)}>
            <Plug className="h-4 w-4" />{open ? "Close setup" : "Fix connection"}
          </Button> : <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button type="button">
                {authorizing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plug className="h-4 w-4" />
                )}
                {authorizing
                  ? "Continue setup"
                  : needsRetry
                    ? "Try again"
                    : setupQuery.data?.existingConnections.length ? "Connect / Use existing" : "Connect"}
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
                  Connect {interaction.payload.serviceName}
                </DialogTitle>
                <DialogDescription>
                  Complete connection setup without leaving this task.
                </DialogDescription>
              </DialogHeader>
              {setupContent}
            </DialogContent>
          </Dialog>}
        </div>}
        {isAi && open ? <div className="mt-4 border-t border-border pt-4" data-testid="ai-connection-inline-repair">{inlineContent}</div> : null}

        {(!isEmail && completeMutation.isError) ||
        (selectAiAccountMutation.isError && selectAiAccountMutation.variables?.generation === generation) ||
        adoptMutation.isError ||
        declineMutation.isError ||
        phaseMutation.isError ? (
          <p className="mt-3 text-sm text-destructive" role="alert">
            {(completeMutation.error ??
              selectAiAccountMutation.error ??
              adoptMutation.error ??
              declineMutation.error ??
              phaseMutation.error) instanceof Error
              ? (
                  completeMutation.error ??
                  selectAiAccountMutation.error ??
                  adoptMutation.error ??
                  declineMutation.error ??
                  phaseMutation.error
                )?.message
              : "Couldn’t update this connection request."}
          </p>
        ) : null}
        {selectAiAccountMutation.isError && selectAiAccountMutation.variables?.generation === generation && (
          <Button className="mt-3" onClick={() => selectAiAccountMutation.mutate(selectAiAccountMutation.variables!)}>
            Retry using this connection
          </Button>
        )}
      </div>
    </div>
  );
}
