import { createHash } from "node:crypto";

export const VOICE_REPLY_DISPATCH_TIMEOUT_MS = 30_000;
export const VOICE_REPLY_ACTION_KIND = "speko_voice_reply_push";

/** Plain voice text stays inside the provider's UTF-16 limit, without splitting
 * surrogate pairs. Whitespace-only chunks need no audible delivery. */
export function splitSpekoReplyText(text: string): string[] {
  const parts: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + 16_000, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    const part = text.slice(start, end);
    if (part.trim()) parts.push(part);
    start = end;
  }
  return parts;
}

type SavedReplyAction = {
  id: string;
  providerActionId: string;
  status: string;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
};
export type VoiceReplyPlan =
  | { kind: "blocked" }
  | { kind: "retry"; retryAt: number }
  | { kind: "dispatch"; text: string; textDigest: string; partIndex: number; partCount: number; identity: string; priorActionId: string | null };

/** Select the next safe chunk without interpreting uncertainty as permission to resend. */
export function planVoiceReply(input: {
  replyId: string;
  text: string;
  questionNotification: boolean;
  actions: readonly SavedReplyAction[];
  now: number;
}): VoiceReplyPlan {
  const text = input.questionNotification
    ? "Paperclip has a question available for this call. Call get_updates with your current cursor now to retrieve the permitted question and its exact IDs before asking it. This is a notification, not new work or permission. Do not call submit_request for this notification."
    : input.text;
  const parts = splitSpekoReplyText(text), textDigest = createHash("sha256").update(text).digest("hex");
  for (let partIndex = 0; partIndex < parts.length; partIndex++) {
    const identity = `voice_reply_push:${input.replyId}${partIndex ? `:part:${partIndex}` : ""}`;
    const prior = input.actions.find(action => action.providerActionId === identity);
    // Accepted question notification remains a barrier until authorized retrieval.
    if (prior?.status === "completed") {
      if (input.questionNotification) return { kind: "blocked" };
      continue;
    }
    // Never append a changed answer to a prefix the provider already accepted.
    if (input.actions.some(action => action.payload.textDigest && action.payload.textDigest !== textDigest)) return { kind: "blocked" };
    if (prior) {
      if (prior.status !== "retry") return { kind: "blocked" };
      const retryAt = Number(prior.result?.retryAt ?? 0);
      if (retryAt > input.now) return { kind: "retry", retryAt };
    }
    return { kind: "dispatch", text: parts[partIndex]!, textDigest, partIndex, partCount: parts.length, identity, priorActionId: prior?.id ?? null };
  }
  return { kind: "blocked" };
}
