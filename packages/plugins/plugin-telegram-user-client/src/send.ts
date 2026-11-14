import { parseDialogOriginId } from "./inbound.js";
import type { TelegramConnection } from "./types.js";

export type SendTextRequest = {
  companyId: string;
  agentId: string;
  accountId?: string;
  peerId?: string;
  issueOriginId?: string | null;
  text: string;
};

export type SendAuthorization =
  | { ok: true; accountId: string; peerId: string; connection: TelegramConnection }
  | { ok: false; error: string };

export function authorizeSendText(
  connections: TelegramConnection[],
  request: SendTextRequest,
): SendAuthorization {
  const text = request.text.trim();
  if (!text) return { ok: false, error: "Message text is required." };

  const fromIssue = parseDialogOriginId(request.issueOriginId);
  const accountId = request.accountId ?? fromIssue?.accountId;
  const peerId = request.peerId ?? fromIssue?.peerId;
  if (!accountId || !peerId) {
    return { ok: false, error: "A Telegram account and chat are required." };
  }
  if (fromIssue && (fromIssue.accountId !== accountId || fromIssue.peerId !== peerId)) {
    return { ok: false, error: "This issue is bound to a different Telegram chat." };
  }

  const connection = connections.find((entry) => (
    entry.companyId === request.companyId && entry.telegramUserId === accountId
  ));
  if (!connection) {
    return { ok: false, error: "This agent cannot send from that Telegram account." };
  }
  if (!connection.assignedAgentId) {
    return { ok: false, error: "No answering agent is assigned on this Telegram connection." };
  }
  if (connection.assignedAgentId !== request.agentId) {
    return { ok: false, error: "This agent cannot send from that Telegram account." };
  }
  return { ok: true, accountId, peerId, connection };
}
