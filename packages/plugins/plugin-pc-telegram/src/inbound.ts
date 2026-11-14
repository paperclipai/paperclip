import type { Issue, PluginContext } from "@paperclipai/plugin-sdk";
import { DIALOG_ORIGIN_KIND, DEFAULT_INCOMING_MODE, FILE_NAMESPACE } from "./constants.js";
import type { InboundAttachment, InboundDirectMessage, TelegramConnection } from "./types.js";

export function dialogOriginId(accountId: string, peerId: string): string {
  return `${accountId}:${peerId}`;
}

export function parseDialogOriginId(originId: string | null | undefined): { accountId: string; peerId: string } | null {
  if (!originId) return null;
  const separator = originId.indexOf(":");
  if (separator <= 0 || separator === originId.length - 1) return null;
  return {
    accountId: originId.slice(0, separator),
    peerId: originId.slice(separator + 1),
  };
}

export function shouldAcceptInbound(connection: TelegramConnection, message: InboundDirectMessage): boolean {
  if (connection.paused) return false;
  if (connection.incomingMode !== DEFAULT_INCOMING_MODE) return false;
  if (connection.telegramUserId !== message.accountId) return false;
  if (connection.companyId !== message.companyId) return false;
  if (!message.isPrivate || message.isGroup || message.isOutgoing) return false;
  return message.text.trim().length > 0 || message.attachments.length > 0;
}

export function formatInboundComment(message: InboundDirectMessage, storedFiles: Array<Pick<InboundAttachment, "filename" | "mimeType" | "byteLength" | "kind">>): string {
  const lines: string[] = [];
  const speaker = message.peerName || message.peerId;
  lines.push(`**${speaker}**`);
  if (message.text.trim()) lines.push(message.text.trim());
  for (const file of storedFiles) {
    const kind = file.kind === "voice" ? "Voice message" : file.kind === "photo" ? "Photo" : file.kind === "video" ? "Video" : "Attachment";
    lines.push(`${kind}: ${file.filename} (${file.mimeType}, ${file.byteLength} bytes)`);
  }
  return lines.join("\n\n");
}

export function formatNewIssueTitle(message: InboundDirectMessage): string {
  const name = message.peerName || message.peerId;
  return `Telegram · ${name}`;
}

export async function storeInboundFiles(
  ctx: PluginContext,
  companyId: string,
  attachments: InboundAttachment[],
): Promise<Array<Pick<InboundAttachment, "id" | "filename" | "mimeType" | "byteLength" | "kind">>> {
  const stored = [];
  for (const attachment of attachments) {
    await ctx.state.set({
      scopeKind: "company",
      scopeId: companyId,
      namespace: FILE_NAMESPACE,
      stateKey: attachment.id,
    }, {
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      byteLength: attachment.byteLength,
      kind: attachment.kind,
      contentBase64: Buffer.from(attachment.bytes).toString("base64"),
    });
    stored.push({
      id: attachment.id,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      byteLength: attachment.byteLength,
      kind: attachment.kind,
    });
  }
  return stored;
}

export async function ingestInboundMessage(
  ctx: PluginContext,
  connection: TelegramConnection,
  message: InboundDirectMessage,
): Promise<Issue | null> {
  if (!shouldAcceptInbound(connection, message)) return null;

  const storedFiles = await storeInboundFiles(ctx, connection.companyId, message.attachments);
  const body = formatInboundComment(message, storedFiles);
  const originId = dialogOriginId(message.accountId, message.peerId);
  const existing = await ctx.issues.list({
    companyId: connection.companyId,
    originKind: DIALOG_ORIGIN_KIND,
    originId,
    limit: 1,
  });
  const current = existing[0];
  if (current) {
    if (connection.assignedAgentId && current.assigneeAgentId !== connection.assignedAgentId) {
      await ctx.issues.update(current.id, { assigneeAgentId: connection.assignedAgentId }, connection.companyId);
    }
    await ctx.issues.createComment(current.id, body, connection.companyId);
    if (connection.assignedAgentId) {
      await ctx.issues.requestWakeup(current.id, connection.companyId, {
        reason: "telegram-inbound",
        contextSource: "plugin-pc-telegram",
      });
    }
    return await ctx.issues.get(current.id, connection.companyId) ?? current;
  }

  const created = await ctx.issues.create({
    companyId: connection.companyId,
    title: formatNewIssueTitle(message),
    description: body,
    status: "todo",
    assigneeAgentId: connection.assignedAgentId ?? undefined,
    originKind: DIALOG_ORIGIN_KIND,
    originId,
  });
  if (connection.assignedAgentId) {
    await ctx.issues.requestWakeup(created.id, connection.companyId, {
      reason: "telegram-inbound",
      contextSource: "plugin-pc-telegram",
    });
  }
  return created;
}
