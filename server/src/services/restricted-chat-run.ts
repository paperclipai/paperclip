import { isPaperclipExternalChatContractTurn } from "@paperclipai/adapter-utils/server-utils";

/** External chat participants steer these runs, so connector egress is denied. */
export function isRestrictedChatRunSnapshot(snapshot: Record<string, unknown>): boolean {
  return isPaperclipExternalChatContractTurn(snapshot.paperclipWake)
    || String(snapshot.source ?? "").startsWith("chat:")
    || Boolean(snapshot.paperclipExternalChatQuestionResponse);
}
