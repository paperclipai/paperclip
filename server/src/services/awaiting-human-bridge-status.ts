import type {
  AwaitingHumanBridgeCloseOutcome,
  AwaitingHumanBridgeStatus,
  InteractionAwaitingHumanHandoffPhase,
  InteractionAwaitingHumanHandoffStatus,
  IssueInteractionHandoffStatusResponse,
} from "@paperclipai/shared";
import { awaitingHumanBridges, type Db } from "@paperclipai/db";
import { desc, eq } from "drizzle-orm";

type BridgeRow = typeof awaitingHumanBridges.$inferSelect;

function toIso(value: Date | null | undefined) {
  return value ? value.toISOString() : null;
}

function msDelta(from: Date | null | undefined, nowMs: number) {
  if (!from) return null;
  return nowMs - from.getTime();
}

export function formatAwaitingHumanProviderLabel(provider: string | null | undefined) {
  const normalized = provider?.trim().toLowerCase() ?? "";
  if (!normalized) return "external channel";
  if (normalized === "clickup") return "ClickUp";
  return provider!.trim();
}

function formatInDuration(ms: number | null) {
  if (ms === null) return null;
  if (ms <= 0) return "now";
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `in ${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  return `in ${minutes}m`;
}

function formatAgoDuration(ms: number | null) {
  if (ms === null) return null;
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

function closeOutcomeLabel(
  outcome: AwaitingHumanBridgeCloseOutcome,
  providerLabel: string,
) {
  switch (outcome) {
    case "approved":
      return `Approved in ${providerLabel}`;
    case "rejected":
      return `Declined in ${providerLabel}`;
    case "expired":
      return `Timed out in ${providerLabel}`;
    case "superseded":
      return `Resolved in ${providerLabel}`;
    case "cancelled":
      return `Cancelled in ${providerLabel}`;
    default:
      return `Closed in ${providerLabel}`;
  }
}

function closeOutcomeDetail(outcome: AwaitingHumanBridgeCloseOutcome, reason: string | null) {
  if (reason?.trim()) return reason.trim();
  switch (outcome) {
    case "approved":
      return "A human approved this request in the external channel.";
    case "rejected":
      return "A human declined this request in the external channel.";
    case "expired":
      return "No response was received before the handoff timed out.";
    case "superseded":
      return "This handoff was closed after the request was handled elsewhere.";
    case "cancelled":
      return "This handoff was cancelled.";
    default:
      return null;
  }
}

export function buildInteractionAwaitingHumanHandoffStatus(
  row: BridgeRow | null,
  now = new Date(),
): InteractionAwaitingHumanHandoffStatus {
  const interactionId = row?.interactionId ?? "";
  const nowMs = now.getTime();
  const provider = row?.provider ?? null;
  const providerLabel = formatAwaitingHumanProviderLabel(provider);

  if (!row) {
    return {
      interactionId,
      provider: null,
      providerLabel,
      phase: "none",
      label: "External handoff not started",
      detail: "This request has not been sent to your team's external channel yet.",
      isCheckingNow: false,
      lastCheckedAt: null,
      nextCheckAt: null,
      closeOutcome: null,
    };
  }

  const bridgeStatus = row.status as AwaitingHumanBridgeStatus;
  const closeOutcome = (row.closeOutcome ?? null) as AwaitingHumanBridgeCloseOutcome | null;
  const nextPollMs = row.nextPollAt?.getTime() ?? null;
  const isPollDue = bridgeStatus === "waiting_for_human"
    && (nextPollMs === null || nextPollMs <= nowMs);
  const msUntilNextPoll = bridgeStatus === "waiting_for_human" && nextPollMs !== null
    ? Math.max(0, nextPollMs - nowMs)
    : null;
  const msSinceLastPoll = msDelta(row.lastPolledAt, nowMs);
  const lastCheckedAt = toIso(row.lastPolledAt);
  const nextCheckAt = toIso(row.nextPollAt);

  if (bridgeStatus === "pending_delivery") {
    return {
      interactionId: row.interactionId,
      provider,
      providerLabel,
      phase: "sending",
      label: `Sending to ${providerLabel}`,
      detail: "Posting this request to your team's channel.",
      isCheckingNow: false,
      lastCheckedAt,
      nextCheckAt,
      closeOutcome,
    };
  }

  if (bridgeStatus === "waiting_for_human") {
    const pollError = row.lastError?.trim() || null;
    if (isPollDue) {
      const lastChecked = formatAgoDuration(msSinceLastPoll);
      if (pollError) {
        return {
          interactionId: row.interactionId,
          provider,
          providerLabel,
          phase: "checking",
          label: `${providerLabel} check failed`,
          detail: lastChecked
            ? `${pollError} Retrying now. Last checked ${lastChecked}.`
            : `${pollError} Retrying now.`,
          isCheckingNow: true,
          lastCheckedAt,
          nextCheckAt,
          closeOutcome,
        };
      }
      return {
        interactionId: row.interactionId,
        provider,
        providerLabel,
        phase: "checking",
        label: `Checking ${providerLabel} for your reply`,
        detail: lastChecked
          ? `Looking for a text reply now. Last checked ${lastChecked}.`
          : "Looking for a text reply now.",
        isCheckingNow: true,
        lastCheckedAt,
        nextCheckAt,
        closeOutcome,
      };
    }

    const nextCheck = formatInDuration(msUntilNextPoll);
    const lastChecked = formatAgoDuration(msSinceLastPoll);
    const detailParts = [
      pollError,
      nextCheck ? `Next check ${nextCheck}` : null,
      lastChecked ? `Last checked ${lastChecked}` : null,
    ].filter(Boolean);

    return {
      interactionId: row.interactionId,
      provider,
      providerLabel,
      phase: "listening",
      label: `Waiting in ${providerLabel}`,
      detail: detailParts.length > 0
        ? detailParts.join(" · ")
        : "We'll check the channel for your reply on a regular schedule.",
      isCheckingNow: false,
      lastCheckedAt,
      nextCheckAt,
      closeOutcome,
    };
  }

  if (bridgeStatus === "closed") {
    const outcome = closeOutcome ?? "superseded";
    return {
      interactionId: row.interactionId,
      provider,
      providerLabel,
      phase: "completed",
      label: closeOutcomeLabel(outcome, providerLabel),
      detail: closeOutcomeDetail(outcome, row.closeReason ?? null),
      isCheckingNow: false,
      lastCheckedAt,
      nextCheckAt,
      closeOutcome: outcome,
    };
  }

  if (bridgeStatus === "failed") {
    const errorDetail = row.lastError?.trim() || "The external channel could not be reached.";
    return {
      interactionId: row.interactionId,
      provider,
      providerLabel,
      phase: "failed",
      label: `Couldn't reach ${providerLabel}`,
      detail: errorDetail,
      isCheckingNow: false,
      lastCheckedAt,
      nextCheckAt,
      closeOutcome,
    };
  }

  return {
    interactionId: row.interactionId,
    provider,
    providerLabel,
    phase: "none",
    label: "External handoff unavailable",
    detail: null,
    isCheckingNow: false,
    lastCheckedAt,
    nextCheckAt,
    closeOutcome,
  };
}

function isExternallyHandoffInteractionKind(kind: string) {
  return kind === "ask_user_questions" || kind === "request_confirmation";
}

export async function listIssueInteractionHandoffStatus(
  db: Db,
  issueId: string,
  options?: {
    interactionIds?: string[];
    now?: Date;
  },
): Promise<IssueInteractionHandoffStatusResponse> {
  const now = options?.now ?? new Date();
  const rows = await db
    .select()
    .from(awaitingHumanBridges)
    .where(eq(awaitingHumanBridges.issueId, issueId))
    .orderBy(desc(awaitingHumanBridges.createdAt));

  const byInteractionId: Record<string, InteractionAwaitingHumanHandoffStatus> = {};
  for (const row of rows) {
    if (byInteractionId[row.interactionId]) continue;
    byInteractionId[row.interactionId] = buildInteractionAwaitingHumanHandoffStatus(row, now);
  }

  for (const interactionId of options?.interactionIds ?? []) {
    if (byInteractionId[interactionId]) continue;
    byInteractionId[interactionId] = {
      ...buildInteractionAwaitingHumanHandoffStatus(null, now),
      interactionId,
    };
  }

  return {
    issueId,
    serverNow: now.toISOString(),
    byInteractionId,
  };
}

export function mergeInteractionHandoffStatuses(
  response: IssueInteractionHandoffStatusResponse,
  interactions: Array<{ id: string; kind: string; status: string }>,
  now = new Date(),
): IssueInteractionHandoffStatusResponse {
  const byInteractionId = { ...response.byInteractionId };
  for (const interaction of interactions) {
    if (!isExternallyHandoffInteractionKind(interaction.kind)) continue;
    if (byInteractionId[interaction.id]) continue;
    if (interaction.status !== "pending") continue;
    byInteractionId[interaction.id] = {
      ...buildInteractionAwaitingHumanHandoffStatus(null, now),
      interactionId: interaction.id,
    };
  }
  return {
    ...response,
    byInteractionId,
  };
}
