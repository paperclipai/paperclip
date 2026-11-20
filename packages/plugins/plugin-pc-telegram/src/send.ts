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
  if (!request.issueOriginId) return { ok: false, error: "A Telegram task is required." };

  const fromIssue = parseDialogOriginId(request.issueOriginId);
  if (!fromIssue) return { ok: false, error: "This issue is not a Telegram dialog." };
  if (
    (request.accountId && request.accountId !== fromIssue.accountId)
    || (request.peerId && request.peerId !== fromIssue.peerId)
  ) {
    return { ok: false, error: "This issue is bound to a different Telegram chat." };
  }
  const accountId = fromIssue.accountId;
  const peerId = fromIssue.peerId;

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

export function authorizeAssignedAgent(
  connections: TelegramConnection[],
  request: { companyId: string; agentId: string; issueOriginId?: string | null },
): SendAuthorization {
  if (!request.agentId) {
    return { ok: false, error: "This agent cannot send from that Telegram account." };
  }
  const fromIssue = parseDialogOriginId(request.issueOriginId);
  if (!fromIssue) return { ok: false, error: "This issue is not a Telegram dialog." };
  const connection = connections.find((entry) => (
    entry.companyId === request.companyId && entry.telegramUserId === fromIssue.accountId
  ));
  if (!connection || connection.assignedAgentId !== request.agentId) {
    return { ok: false, error: "This agent cannot send from that Telegram account." };
  }
  return { ok: true, accountId: fromIssue.accountId, peerId: fromIssue.peerId, connection };
}

/** Source and target dialogs use the same actor check. */
export function authorizeDialogForActor(
  connections: TelegramConnection[],
  request: { companyId: string; board: boolean; agentId: string; issueOriginId?: string | null },
): SendAuthorization {
  if (request.board) {
    return authorizeOperatorDialog(connections, {
      companyId: request.companyId,
      issueOriginId: request.issueOriginId,
    });
  }
  return authorizeAssignedAgent(connections, {
    companyId: request.companyId,
    agentId: request.agentId,
    issueOriginId: request.issueOriginId,
  });
}

export function authorizeOperatorDialog(
  connections: TelegramConnection[],
  request: { companyId: string; issueOriginId?: string | null },
): SendAuthorization {
  const fromIssue = parseDialogOriginId(request.issueOriginId);
  if (!fromIssue) return { ok: false, error: "This issue is not a Telegram dialog." };
  const connection = connections.find((entry) => (
    entry.companyId === request.companyId && entry.telegramUserId === fromIssue.accountId
  ));
  if (!connection) return { ok: false, error: "That Telegram account is not connected." };
  return { ok: true, accountId: fromIssue.accountId, peerId: fromIssue.peerId, connection };
}

export function authorizeOperatorReply(
  connections: TelegramConnection[],
  request: { companyId: string; issueOriginId?: string | null; text: string },
): SendAuthorization {
  const text = request.text.trim();
  if (!text) return { ok: false, error: "Message text is required." };
  if (text.length > 4000) return { ok: false, error: "Message text is too long." };
  const fromIssue = parseDialogOriginId(request.issueOriginId);
  if (!fromIssue) return { ok: false, error: "This issue is not a Telegram dialog." };
  const connection = connections.find((entry) => (
    entry.companyId === request.companyId && entry.telegramUserId === fromIssue.accountId
  ));
  if (!connection) return { ok: false, error: "That Telegram account is not connected." };
  return { ok: true, accountId: fromIssue.accountId, peerId: fromIssue.peerId, connection };
}
