import { isPaperclipExternalChatContractTurn } from "@paperclipai/adapter-utils/server-utils";

export function isRestrictedChatRunSnapshot(snapshot: Record<string, unknown>): boolean {
  return isPaperclipExternalChatContractTurn(snapshot.paperclipWake)
    || String(snapshot.source ?? "").startsWith("chat:")
    || Boolean(snapshot.paperclipExternalChatQuestionResponse);
}
