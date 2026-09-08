import { useCallback, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  Clock,
  Loader2,
  Plug,
  RotateCcw,
  XCircle,
} from "lucide-react";
import type { ConnectionIntentInteraction } from "@paperclipai/shared";
import { connectionIntentsApi } from "@/api/connection-intents";
import { AppLogo } from "@/pages/apps/AppLogo";
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
} from "./ConnectionSetupFlow";

export interface ConnectionIntentInteractionBodyProps {
  interaction: ConnectionIntentInteraction;
  currentUserId?: string | null;
  addresseeLabel: string;
}

export function ConnectionIntentInteractionBody({
  interaction,
  currentUserId,
  addresseeLabel,
}: ConnectionIntentInteractionBodyProps) {
  const [open, setOpen] = useState(false);
  const focusTargetRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const isAddressee = Boolean(
    currentUserId && interaction.addresseeUserId === currentUserId,
  );
  const isPending = interaction.status === "pending";
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
    enabled: open && isAddressee && isPending,
    refetchInterval: open && isPending ? 2_000 : false,
  });

  const completeMutation = useMutation({
    mutationFn: (connectionId: string) =>
      connectionIntentsApi.complete(interaction.id, connectionId),
    onSuccess: async (updatedInteraction) => {
      await invalidateTask(updatedInteraction);
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
    if (completion.resolvedByCallback) {
      await invalidateTask();
      setOpen(false);
      returnFocusToCard();
      return;
    }
    completeMutation.mutate(completion.connectionId);
  };

  const resultOutcome = interaction.result?.outcome;
  const status =
    interaction.status === "accepted"
      ? {
          icon: CheckCircle2,
          title: `${interaction.payload.serviceName} connected`,
          body: `${interaction.payload.requestingAgentName} can use this connection on the continuation run.`,
        }
      : interaction.status === "rejected"
        ? {
            icon: XCircle,
            title: "Connection declined",
            body: `${interaction.payload.requestingAgentName} was notified and can continue without it.`,
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
                  ? "A newer run requested this connection. Use the latest card instead."
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
            <p className="mt-1 text-sm text-muted-foreground">{status.body}</p>
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
            <p className="mt-1 text-sm text-muted-foreground">
              Only the addressed person can choose an identity or authorize this
              connection.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const needsRetry = interaction.payload.phase === "needs_retry";
  const authorizing = interaction.payload.phase === "authorizing";

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
              {interaction.payload.requestingAgentName} needs{" "}
              {interaction.payload.serviceName}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Connect your identity or reuse an eligible connection. Access is
              added only for this agent.
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

        <div className="mt-4 flex flex-wrap gap-2">
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button type="button" disabled={authorizing}>
                {authorizing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plug className="h-4 w-4" />
                )}
                {authorizing
                  ? "Authorizing…"
                  : needsRetry
                    ? "Try again"
                    : "Connect / Use existing"}
              </Button>
            </DialogTrigger>
            <DialogContent
              className="!max-w-(--pct-90) max-h-(--sz-85vh) w-full overflow-y-auto sm:max-w-5xl"
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
              {setupQuery.isLoading ? (
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
              ) : setupQuery.data ? (
                <ConnectionSetupFlow
                  host="dialog"
                  serviceSlug={interaction.payload.serviceSlug}
                  requestedAgentId={setupQuery.data.requestedAgentId}
                  interactionId={interaction.id}
                  existingConnections={setupQuery.data.existingConnections}
                  onUseExisting={async (connectionId) => {
                    await completeMutation.mutateAsync(connectionId);
                  }}
                  onComplete={(completion) => {
                    void finishNewConnection(completion);
                  }}
                  onOAuthDeclined={() => declineMutation.mutate()}
                  onPhaseChange={handlePhaseChange}
                  onCancel={() => setOpen(false)}
                />
              ) : null}
            </DialogContent>
          </Dialog>
          <Button
            type="button"
            variant="ghost"
            disabled={declineMutation.isPending || authorizing}
            onClick={() => declineMutation.mutate()}
          >
            Not now
          </Button>
        </div>

        {completeMutation.isError ||
        declineMutation.isError ||
        phaseMutation.isError ? (
          <p className="mt-3 text-sm text-destructive" role="alert">
            {(completeMutation.error ??
              declineMutation.error ??
              phaseMutation.error) instanceof Error
              ? (
                  completeMutation.error ??
                  declineMutation.error ??
                  phaseMutation.error
                )?.message
              : "Couldn’t update this connection request."}
          </p>
        ) : null}
      </div>
    </div>
  );
}
