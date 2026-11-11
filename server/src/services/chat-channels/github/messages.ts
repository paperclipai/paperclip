import { createHash } from "node:crypto";
import { MAX_INBOUND_TEXT, type LifecycleActor } from "../message-lifecycle.js";


export type GitHubLifecycleEvent = {
  actor?: LifecycleActor;
  isBotMessage?: true;
  eventKind: "message_updated" | "message_deleted";
  messageId: string;
  providerEventId?: string;
  providerMessageSequence: number | null;
  providerSentAt: string | null;
  revision: string;
  text: string;
  threadId: string;
};

export async function githubLifecycleEventFromRequest(
  request: Request,
): Promise<GitHubLifecycleEvent | null> {
  const eventType = request.headers.get("x-github-event");
  const deliveryId = request.headers.get("x-github-delivery")?.trim() || null;
  if (
    eventType !== "issue_comment" &&
    eventType !== "pull_request_review_comment"
  )
    return null;
  const payload = (await request.json()) as {
    action?: unknown;
    comment?: {
      id?: unknown;
      in_reply_to_id?: unknown;
      body?: unknown;
      updated_at?: unknown;
      user?: { type?: unknown };
    };
    issue?: { number?: unknown; pull_request?: unknown };
    pull_request?: { number?: unknown };
    repository?: { name?: unknown; owner?: { login?: unknown } };
    sender?: { id?: unknown; login?: unknown; type?: unknown };
  };
  if (payload.action !== "edited" && payload.action !== "deleted") return null;
  const owner = payload.repository?.owner?.login;
  const repo = payload.repository?.name;
  const messageId = payload.comment?.id;
  if (
    typeof owner !== "string" ||
    typeof repo !== "string" ||
    (typeof messageId !== "string" && typeof messageId !== "number")
  )
    return null;
  let threadId: string;
  if (eventType === "issue_comment") {
    const number = payload.issue?.number;
    if (typeof number !== "number") return null;
    threadId = payload.issue?.pull_request
      ? `github:${owner}/${repo}:${number}`
      : `github:${owner}/${repo}:issue:${number}`;
  } else {
    const number = payload.pull_request?.number;
    const rootCommentId =
      payload.comment?.in_reply_to_id ?? payload.comment?.id;
    if (
      typeof number !== "number" ||
      (typeof rootCommentId !== "string" && typeof rootCommentId !== "number")
    )
      return null;
    threadId = `github:${owner}/${repo}:${number}:rc:${rootCommentId}`;
  }
  const eventKind =
    payload.action === "edited" ? "message_updated" : "message_deleted";
  const body =
    typeof payload.comment?.body === "string"
      ? payload.comment.body.slice(0, MAX_INBOUND_TEXT)
      : "";
  const providerRevision =
    typeof payload.comment?.updated_at === "string"
      ? payload.comment.updated_at
      : payload.action;
  const parsedProviderSentAt = new Date(providerRevision);
  const providerSentAt = Number.isFinite(parsedProviderSentAt.getTime())
    ? parsedProviderSentAt.toISOString()
    : null;
  const numericMessageId =
    typeof messageId === "number"
      ? messageId
      : typeof messageId === "string" && /^\d+$/.test(messageId)
        ? Number(messageId)
        : null;
  const providerMessageSequence =
    numericMessageId !== null &&
    Number.isSafeInteger(numericMessageId) &&
    numericMessageId >= 0
      ? numericMessageId
      : null;
  const senderId = payload.sender?.id;
  const senderLogin = payload.sender?.login;
  const actor =
    (typeof senderId === "string" || typeof senderId === "number") &&
    typeof senderLogin === "string" &&
    senderLogin.length > 0
      ? {
          externalId: String(senderId),
          displayName: senderLogin,
          handle: senderLogin,
        }
      : undefined;
  return {
    ...(actor ? { actor } : {}),
    ...(payload.comment?.user?.type === "Bot" || payload.sender?.type === "Bot"
      ? { isBotMessage: true as const }
      : {}),
    eventKind,
    messageId: String(messageId),
    ...(deliveryId ? { providerEventId: `github:delivery:${deliveryId}` } : {}),
    providerMessageSequence,
    providerSentAt,
    // GitHub's updated_at value can have coarser resolution than a quick
    // sequence of edits. Include the normalized body so distinct edits at the
    // same timestamp remain durable while an exact webhook redelivery still
    // deduplicates.
    revision:
      eventKind === "message_updated"
        ? `${providerRevision}:${createHash("sha256").update(body).digest("hex")}`
        : providerRevision,
    text:
      eventKind === "message_updated"
        ? `An external message was edited:\n\n${body}`
        : "An external message in this conversation was deleted.",
    threadId,
  };
}

export async function githubSupplementalLifecycleFromRequest(githubInspection: Request): Promise<GitHubLifecycleEvent | null> {
  let lifecycle: GitHubLifecycleEvent | null = null;
      try {
        lifecycle = await githubLifecycleEventFromRequest(githubInspection);
      } catch {
        // Ignore only malformed or unsupported supplemental payloads. Once an
        // event is recognized, its durable persistence failure must escape.
      }
  return lifecycle;
}
