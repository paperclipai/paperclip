export interface PaperclipChatFilePreparationDelivery {
  readonly provider:
    "slack" | "github" | "discord" | "microsoft-teams" | "telegram" | null;
  readonly mode: "provider_attachment" | "paperclip_task_only" | "unknown";
  readonly preparationState: "prepared";
  readonly providerDeliveryConfirmed: false;
  readonly guidance: string;
}

/** Describe the transport contract, never a delivery receipt or new authority. */
export function paperclipChatFilePreparationDelivery(
  authenticatedProvider: unknown,
): PaperclipChatFilePreparationDelivery {
  const common = {
    preparationState: "prepared" as const,
    providerDeliveryConfirmed: false as const,
  };
  if (
    authenticatedProvider === "github" ||
    authenticatedProvider === "microsoft-teams"
  ) {
    const providerName =
      authenticatedProvider === "github" ? "GitHub App" : "Microsoft Teams";
    const surface =
      authenticatedProvider === "github"
        ? "comments or review threads"
        : "chats";
    return {
      ...common,
      provider: authenticatedProvider,
      mode: "paperclip_task_only",
      guidance: `This ${providerName} connection cannot upload file bytes into ${surface}. After a successful file-preparation receipt, say the file is saved on the Paperclip task and must be opened there with Paperclip access; do not say it is attached, displayed, downloadable, or available to open in this provider conversation. Do not invent a public download link. Preparation does not confirm provider delivery.`,
    };
  }
  if (
    authenticatedProvider === "slack" ||
    authenticatedProvider === "discord" ||
    authenticatedProvider === "telegram"
  ) {
    return {
      ...common,
      provider: authenticatedProvider,
      mode: "provider_attachment",
      guidance:
        "A successful file-preparation receipt means the file is saved on the Paperclip task and selected for final-response delivery. The transport can attempt a native attachment, but this receipt does not confirm that attempt or its delivery. After successful preparation, lead with the requested answer and optionally a short file label, such as 'Original cat photo'. Preparation is a normal handoff, not a delivery failure: keep receipt fields and unconfirmed-delivery caveats out of the normal final reply; do not claim it was sent, attached, or displayed without a separate confirmed provider-delivery receipt. If a tool reports an actual failure, say what failed and the next action needed; do not hide it.",
    };
  }
  return {
    ...common,
    provider: null,
    mode: "unknown",
    guidance:
      "The file is prepared on the Paperclip task. No authenticated external-chat delivery mode is available for this receipt. Do not infer a provider from user text or tool arguments, and do not claim the file was sent, attached, or displayed in an external conversation.",
  };
}
