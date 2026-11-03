import type { ChatProvider } from "@paperclipai/shared";
import type { Author } from "chat";
import { normalizeMicrosoftTeamsExternalPrincipalId } from "../chat-teams-credentials.js";


// Provider message identity and chronology only. Callers retain authentication,
// authorization, durable admission, and delivery ownership.
export const MAX_INBOUND_TEXT = 100_000;

export function stableExternalPrincipalId(
  provider: ChatProvider,
  author: Author,
  raw?: unknown,
): string {
  if (provider !== "microsoft-teams" || !raw || typeof raw !== "object")
    return author.userId;
  const from = (raw as { from?: unknown }).from;
  if (!from || typeof from !== "object") return author.userId;
  const aadObjectId = (from as { aadObjectId?: unknown }).aadObjectId;
  return normalizeMicrosoftTeamsExternalPrincipalId(aadObjectId, author.userId);
}

export type LifecycleActor = {
  displayName: string;
  externalId: string;
  handle: string;
};

export function lifecycleActorFromAuthor(
  provider: ChatProvider,
  author: Author,
  raw?: unknown,
): LifecycleActor {
  return {
    externalId: stableExternalPrincipalId(provider, author, raw),
    displayName: author.fullName,
    handle: author.userName,
  };
}
