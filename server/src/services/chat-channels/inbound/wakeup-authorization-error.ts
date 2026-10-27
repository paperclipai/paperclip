import { forbidden, HttpError } from "../../../errors.js";

// Stable categories only. Never surface stored provider payloads, identifiers,
// credential fingerprints, or arbitrary downstream error text to the board.
const reasons = ["source_shape", "task_assignment", "delivery_binding", "runtime_fence",
  "conversation_binding", "destination_binding", "automatic_policy", "task_privacy",
  "principal_access", "source_comment", "retry_intent", "source_receipt", "app_binding",
  "connection_access", "runtime_generation", "batch_scope", "batch_source_link"] as const;
export type ChatWakeAuthorityReason = typeof reasons[number];
export function chatWakeAuthorityDenied(authorityReason: ChatWakeAuthorityReason) {
  return forbidden("This accepted chat message is no longer authorized to start work",
    { code: "chat_action_authorization_changed", authorityReason });
}
export function safeChatWakeAuthorityReason(error: unknown): ChatWakeAuthorityReason | undefined {
  if (!(error instanceof HttpError) || !error.details || typeof error.details !== "object") return undefined;
  const details = error.details as Record<string, unknown>;
  return details.code === "chat_action_authorization_changed" && reasons.includes(details.authorityReason as ChatWakeAuthorityReason)
    ? details.authorityReason as ChatWakeAuthorityReason : undefined;
}
