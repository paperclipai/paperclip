import type {
  InteractionAwaitingHumanHandoffPhase,
  InteractionAwaitingHumanHandoffStatus,
  IssueInteractionHandoffStatusResponse,
  IssueThreadInteraction,
} from "@paperclipai/shared";

export function isExternallyHandoffInteraction(interaction: IssueThreadInteraction) {
  return interaction.kind === "ask_user_questions" || interaction.kind === "request_confirmation";
}

export function defaultInteractionHandoffStatus(
  interactionId: string,
): InteractionAwaitingHumanHandoffStatus {
  return {
    interactionId,
    provider: null,
    providerLabel: "external channel",
    phase: "none",
    label: "External handoff not started",
    detail: "This request has not been sent to your team's external channel yet.",
    isCheckingNow: false,
    lastCheckedAt: null,
    nextCheckAt: null,
    closeOutcome: null,
  };
}

export function resolveInteractionHandoffStatus(
  interactionId: string,
  response: IssueInteractionHandoffStatusResponse | undefined,
): InteractionAwaitingHumanHandoffStatus | undefined {
  return response?.byInteractionId[interactionId];
}

export function resolveDisplayHandoffStatus(
  interaction: IssueThreadInteraction,
  status: InteractionAwaitingHumanHandoffStatus | null | undefined,
): InteractionAwaitingHumanHandoffStatus | undefined {
  if (!isExternallyHandoffInteraction(interaction)) return undefined;
  if (status) return status;
  if (interaction.status === "pending") {
    return defaultInteractionHandoffStatus(interaction.id);
  }
  return undefined;
}

export function shouldPollInteractionHandoffStatus(
  interactions: IssueThreadInteraction[],
  response: IssueInteractionHandoffStatusResponse | undefined,
) {
  const hasPendingHandoffInteraction = interactions.some(
    (interaction) => isExternallyHandoffInteraction(interaction) && interaction.status === "pending",
  );
  if (!hasPendingHandoffInteraction) return false;

  if (!response) return true;

  return Object.values(response.byInteractionId).some((status) => (
    status.phase === "sending"
    || status.phase === "listening"
    || status.phase === "checking"
  ));
}

export function shouldShowInteractionHandoffStatus(
  interaction: IssueThreadInteraction,
  status: InteractionAwaitingHumanHandoffStatus | undefined,
) {
  if (!isExternallyHandoffInteraction(interaction)) return false;
  if (interaction.status !== "pending") {
    return status?.phase === "failed";
  }
  if (!status || status.phase === "none") return true;
  return status.phase !== "completed";
}

export function handoffStatusTone(phase: InteractionAwaitingHumanHandoffPhase) {
  switch (phase) {
    case "checking":
      return "border-sky-500/30 bg-sky-500/5 text-sky-900 dark:text-sky-100";
    case "listening":
      return "border-violet-500/30 bg-violet-500/5 text-violet-900 dark:text-violet-100";
    case "sending":
      return "border-amber-500/30 bg-amber-500/5 text-amber-900 dark:text-amber-100";
    case "completed":
      return "border-emerald-500/30 bg-emerald-500/5 text-emerald-900 dark:text-emerald-100";
    case "failed":
      return "border-red-500/30 bg-red-500/5 text-red-900 dark:text-red-100";
    default:
      return "border-border/70 bg-muted/20 text-foreground";
  }
}
