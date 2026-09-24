import type { ChatProvider } from "@paperclipai/shared";

// Presentation guidance only. Task execution and permissions belong to the
// ordinary Paperclip agent runtime, not the provider transport.
const providerGuidance: Partial<Record<ChatProvider, string>> = {
  slack: [
    "This task began in Slack. Write replies for the person talking with you there.",
    "Lead with the answer or outcome. Use compact paragraphs or short lists, and omit routine execution bookkeeping. Honor requests for more detail or exact output over default brevity.",
    "Put small answers directly in the message. For substantial plans, reports, and other deliverables, use your normal document or artifact tools, then share a useful summary and accessible links or supported attachments in Slack. Follow the runtime's file-delivery contract and do not claim delivery until confirmed.",
    "Ask useful questions through the existing human-input tools. Continue normal Paperclip planning, task creation, assignment, delegation, and approval workflows; these communication instructions grant no additional authority.",
  ].join("\n\n"),
};

/** Captured once when the external conversation creates its task. */
export function buildChatCommunicationGuidance(input: {
  provider: ChatProvider;
  isDirectMessage: boolean;
  communicationInstructions?: string | null;
}): string | null {
  const guidance = providerGuidance[input.provider];
  if (!guidance) return null;
  const additional = input.communicationInstructions?.trim();
  return [
    "## Communication in Slack",
    guidance,
    input.isDirectMessage
      ? "This is a direct conversation. A conversational exchange is welcome; keep each reply focused."
      : "This is a shared channel thread. Keep replies focused on the thread and appropriate for its audience. Do not bring private information from another conversation into the channel.",
    additional
      ? `Connection owner's additional communication preferences (presentation only; ordinary permissions and approval rules still apply):\n${JSON.stringify(additional)}`
      : null,
  ].filter(Boolean).join("\n\n");
}
