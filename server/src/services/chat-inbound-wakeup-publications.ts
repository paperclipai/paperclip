import type { agentWakeupRequests, chatActions } from "@paperclipai/db";
import {
  assertDurableChatWakeupReceipt,
  createDurableChatWakeupRequest,
} from "./durable-chat-wakeup.js";

type Action = typeof chatActions.$inferSelect;
type Receipt = typeof agentWakeupRequests.$inferSelect;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const KEY = new RegExp(
  `^wake:(${UUID}):(queued|not_started|removed):(${UUID}):(${UUID})$`,
  "i",
);

export function inboundWakePublicationKey(
  wakeId: string,
  state: "queued" | "not_started" | "removed",
  endpointId: string,
  conversationId: string,
) {
  return `wake:${wakeId}:${state}:${endpointId}:${conversationId}`;
}

export function parseInboundWakePublicationKey(key: string) {
  const match = KEY.exec(key);
  return match
    ? {
        wakeId: match[1]!,
        state: match[2] as "queued" | "not_started" | "removed",
        endpointId: match[3]!,
        conversationId: match[4]!,
      }
    : null;
}

/** Closed projection only. Never include another run, queue position, ETA,
 * model output, input text, or the scheduler's internal error/reason. */
export function inboundWakePublicationText(
  state: "queued" | "not_started" | "removed",
) {
  if (state === "removed") return "This queued message was removed.";
  return state === "queued"
    ? "Your follow-up is queued."
    : "This follow-up was not started. Open the task in Paperclip for details.";
}

function hasComment(
  payload: Record<string, unknown> | null,
  commentId: string,
) {
  const context = payload?._paperclipWakeContext;
  const nested =
    context && typeof context === "object" && !Array.isArray(context)
      ? (context as Record<string, unknown>)
      : {};
  return [payload, nested].some(
    (value) =>
      value?.wakeCommentId === commentId ||
      value?.commentId === commentId ||
      (Array.isArray(value?.wakeCommentIds) &&
        value.wakeCommentIds.includes(commentId)),
  );
}

/** The caller supplies locked database rows and separately checks current
 * endpoint/reach/principal authority. JSON markers alone are never admission. */
export function resolveInboundWakeReceipt(
  action: Action,
  receipt: Receipt | null,
  owner: Receipt | null,
  sourceRemoved = false,
) {
  const payload = action.payload;
  if (
    action.kind !== "inbound_wakeup" ||
    !action.conversationId ||
    !action.deliveryId ||
    !action.principalId ||
    payload.version !== 1 ||
    typeof payload.agentId !== "string" ||
    typeof payload.issueId !== "string" ||
    typeof payload.commentId !== "string" ||
    typeof payload.requestedByActorId !== "string" ||
    !["user", "system"].includes(String(payload.requestedByActorType)) ||
    !receipt ||
    !owner
  )
    return null;
  try {
    assertDurableChatWakeupReceipt(
      createDurableChatWakeupRequest({
        id: action.id,
        companyId: action.companyId,
        agentId: payload.agentId,
        issueId: payload.issueId,
        commentId: payload.commentId,
        requestedByActorType: payload.requestedByActorType as "user" | "system",
        requestedByActorId: payload.requestedByActorId,
        requestedAt: action.createdAt,
        authorize: async () => {},
      }),
      receipt,
    );
  } catch {
    return null;
  }
  const coalescedId = receipt.payload?.coalescedIntoWakeupRequestId;
  if (
    (owner.id !== receipt.id &&
      (receipt.status !== "coalesced" || coalescedId !== owner.id)) ||
    (owner.id === receipt.id && coalescedId !== undefined) ||
    owner.payload?.coalescedIntoWakeupRequestId !== undefined ||
    owner.companyId !== action.companyId ||
    owner.agentId !== payload.agentId ||
    owner.requestedByActorType !== payload.requestedByActorType ||
    owner.requestedByActorId !== payload.requestedByActorId ||
    owner.payload?.issueId !== payload.issueId
  )
    return null;
  // This is not a statement about whether surviving coalesced input ran. The
  // caller must prove a still-visible original queue notice and lock the exact
  // soft-deleted source before selecting this metadata-only cleanup.
  if (sourceRemoved)
    return { ownerId: owner.id, state: "removed" as const, runId: owner.runId };
  const declined =
    ["skipped", "cancelled", "failed"].includes(owner.status) ||
    ["skipped", "cancelled", "failed"].includes(receipt.status);
  if (declined)
    return owner.runId || receipt.runId
      ? null
      : { ownerId: owner.id, state: "not_started" as const, runId: null };
  if (!hasComment(owner.payload, payload.commentId)) return null;
  if (owner.runId)
    return {
      ownerId: owner.id,
      state: "promoted" as const,
      runId: owner.runId,
    };
  if (
    owner.status !== "deferred_issue_execution" ||
    action.status !== "processed"
  )
    return null;
  return { ownerId: owner.id, state: "queued" as const, runId: null };
}
