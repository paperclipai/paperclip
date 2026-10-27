import {
  CHAT_FILE_TRANSFER_PHASES,
  type ChatFileTransferPhase,
  type ChatFileTransferSummary,
  type ChatPublicationBatchStatus,
  type ChatPublicationState,
  type ChatPublicationSummary,
} from "@paperclipai/shared";

/** Explicit safe columns only. Never pass a transfer's encrypted private state. */
export interface ChatFileTransferProjection {
  publicationId: string;
  phase: string;
  version: number;
  filename: string;
  expiresAt: Date;
  consentMessageId: string | null;
  responseActivityId: string | null;
  fileInfoMessageId: string | null;
  operatorConfirmed: boolean;
}

const phases = new Set<string>(CHAT_FILE_TRANSFER_PHASES);
const stateByPhase: Record<ChatFileTransferPhase, ChatPublicationState> = {
  consent_pending: "pending",
  consent_sending: "streaming",
  consent_unknown: "delivery_unknown",
  awaiting_consent: "awaiting_consent",
  upload_pending: "pending",
  uploading: "streaming",
  upload_unknown: "delivery_unknown",
  file_info_pending: "pending",
  file_info_sending: "streaming",
  file_info_unknown: "delivery_unknown",
  delivered: "published",
  declined: "cancelled",
  expired: "cancelled",
  cancelled: "cancelled",
  conflict: "delivery_unknown",
};

export function projectChatFileTransfer(
  publication: ChatPublicationSummary,
  transfer: ChatFileTransferProjection | undefined,
): ChatPublicationSummary {
  if (!transfer) return publication;
  const valid =
    transfer.publicationId === publication.id &&
    phases.has(transfer.phase) &&
    Number.isSafeInteger(transfer.version) &&
    transfer.version > 0 &&
    typeof transfer.filename === "string" &&
    transfer.filename.length > 0 &&
    transfer.filename.length <= 255 &&
    Number.isFinite(transfer.expiresAt.getTime());
  if (!valid) {
    return {
      ...publication,
      state: "delivery_unknown",
      redactedError: "File delivery state needs operator review.",
    };
  }
  const phase = transfer.phase as ChatFileTransferPhase;
  const fileTransfer: ChatFileTransferSummary = {
    provider: "microsoft-teams",
    phase,
    version: transfer.version,
    filename: transfer.filename,
    expiresAt: transfer.expiresAt.toISOString(),
  };
  const hasConsentReceipt = Boolean(
    transfer.consentMessageId || transfer.responseActivityId,
  );
  // A card receipt is not a file receipt. Explicit operator confirmation is
  // separate from a native message ID; never fabricate one for the projection.
  const missingReceipt =
    (phase === "delivered" &&
      !transfer.fileInfoMessageId &&
      transfer.operatorConfirmed !== true) ||
    (phase === "awaiting_consent" && !hasConsentReceipt) ||
    (phase === "declined" && !transfer.responseActivityId);
  return {
    ...publication,
    state: missingReceipt ? "delivery_unknown" : stateByPhase[phase],
    fileTransfer,
    ...(missingReceipt
      ? { redactedError: "File delivery receipt needs operator review." }
      : {}),
  };
}

/** Input is the complete immutable-order batch, not an Activity history page. */
export function projectChatPublicationBatch(
  parts: ChatPublicationSummary[],
): ChatPublicationBatchStatus {
  if (!parts.length) throw new Error("A publication batch cannot be empty");
  const consistent =
    new Set(parts.map((part) => part.id)).size === parts.length &&
    parts.every(
      (part) =>
        !part.fileTransfer ||
        (phases.has(part.fileTransfer.phase) &&
          stateByPhase[part.fileTransfer.phase] === part.state),
    );
  const published = parts.filter((part) => part.state === "published").length;
  const declined = parts.filter(
    (part) =>
      part.state === "cancelled" && part.fileTransfer?.phase === "declined",
  ).length;
  const expired = parts.filter(
    (part) =>
      part.state === "cancelled" && part.fileTransfer?.phase === "expired",
  ).length;
  const cancelled = parts.filter(
    (part) =>
      part.state === "cancelled" &&
      part.fileTransfer?.phase !== "declined" &&
      part.fileTransfer?.phase !== "expired",
  ).length;
  const settled = published + declined + expired + cancelled;
  const publication =
    parts.find(
      (part) => part.state !== "published" && part.state !== "cancelled",
    ) ??
    parts.find((part) => part.state === "cancelled") ??
    parts.at(-1)!;
  return {
    publication,
    parts,
    total: parts.length,
    published,
    awaitingConsent: parts.filter((part) => part.state === "awaiting_consent")
      .length,
    declined,
    expired,
    cancelled,
    settled,
    canDismiss: consistent && settled === parts.length,
  };
}

export function chatFileTransferResolutionActions(
  part: ChatPublicationSummary,
  verifiedConflict?: { publicationId: string; version: number },
): Array<"mark_delivered" | "retry_anyway" | "cancel"> {
  if (part.state !== "delivery_unknown" || !part.fileTransfer) return [];
  switch (part.fileTransfer.phase) {
    case "file_info_unknown":
      return ["mark_delivered", "retry_anyway", "cancel"];
    case "consent_unknown":
    case "upload_unknown":
      return ["cancel"];
    case "conflict":
      return verifiedConflict?.publicationId === part.id &&
        verifiedConflict.version === part.fileTransfer.version
        ? ["cancel"]
        : [];
    default:
      return [];
  }
}
