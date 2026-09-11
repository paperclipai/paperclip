import { loadStructuredDraft, saveStructuredDraft } from "./composer-draft";

type PendingMessage = { body: string; id: string };
const pending = new Map<string, PendingMessage[]>();
const storageKey = (scope: string) => `paperclip:agent-chat-pending:${scope}`;
function read(scope: string): PendingMessage[] {
  const stored = loadStructuredDraft<unknown>(
    storageKey(scope),
    pending.get(scope) ?? [],
  );
  return Array.isArray(stored)
    ? stored.filter(
        (item): item is PendingMessage =>
          typeof item?.body === "string" && typeof item?.id === "string",
      )
    : [];
}
function write(scope: string, messages: PendingMessage[]) {
  pending.set(scope, messages);
  saveStructuredDraft(storageKey(scope), messages);
}
/** Preserve retry identity alongside the draft across agent switches and reloads. */
export function chatMessageRequestId(scope: string, body: string): string {
  const messages = read(scope);
  const existing = messages.find((message) => message.body === body);
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  write(scope, [...messages.slice(-9), { body, id }]);
  return id;
}
export function acknowledgeChatMessage(scope: string, id: string) {
  write(
    scope,
    read(scope).filter((message) => message.id !== id),
  );
}
