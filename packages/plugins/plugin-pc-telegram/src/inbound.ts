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

const dialogLocks = new Map<string, Promise<void>>();

function withDialogLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = dialogLocks.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate, () => gate);
  dialogLocks.set(key, tail);
  return previous.then(fn, fn).finally(() => {
    release();
    if (dialogLocks.get(key) === tail) dialogLocks.delete(key);
  });
}

const MAX_INBOUND_ATTACHMENT_BYTES = 4 * 1024 * 1024;

export function formatInboundComment(
  message: InboundDirectMessage,
  storedFiles: Array<Pick<InboundAttachment, "filename" | "mimeType" | "byteLength" | "kind">>,
  attachmentIds: string[] = [],
  notes: string[] = [],
): string {
  const lines: string[] = [];
  const speaker = message.peerName || message.peerId;
  lines.push(`**${speaker}**`);
  if (message.text.trim()) lines.push(message.text.trim());
  for (const file of storedFiles) {
    const kind = file.kind === "voice" ? "Voice message" : file.kind === "photo" ? "Photo" : file.kind === "video" ? "Video" : "Attachment";
    lines.push(`${kind}: ${file.filename} (${file.mimeType}, ${file.byteLength} bytes)`);
  }
  for (const attachmentId of attachmentIds) {
    lines.push(`attachment:${attachmentId}`);
  }
  for (const note of notes) {
    if (note.trim()) lines.push(note.trim());
  }
  return lines.join("\n\n");
}

export function formatNewIssueTitle(message: InboundDirectMessage): string {
  const name = message.peerName || message.peerId;
  return `Telegram · ${name}`;
}

export function chatListLabel(title: string): string {
  const name = title.replace(/^Telegram\s·\s/, "").trim();
  if (!name || /^\d{5,}$/.test(name)) return "Telegram";
  return name;
}

const UNWAKEABLE_DIALOG_STATUSES = new Set(["backlog", "done", "cancelled"]);

export function reopenDialogForInbound(status: string): "todo" | null {
  return UNWAKEABLE_DIALOG_STATUSES.has(status) ? "todo" : null;
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

async function attachInboundFiles(
  ctx: PluginContext,
  companyId: string,
  issueId: string,
  attachments: InboundAttachment[],
): Promise<{ ids: string[]; notes: string[] }> {
  const ids: string[] = [];
  const notes: string[] = [];
  for (const attachment of attachments) {
    const label = attachment.filename || "attachment";
    if (attachment.byteLength > MAX_INBOUND_ATTACHMENT_BYTES || attachment.bytes.byteLength > MAX_INBOUND_ATTACHMENT_BYTES) {
      notes.push(`Could not attach ${label}: Attachment exceeds ${MAX_INBOUND_ATTACHMENT_BYTES} bytes`);
      continue;
    }
    try {
      const created = await ctx.issues.createAttachment({
        issueId,
        companyId,
        filename: attachment.filename,
        contentType: attachment.mimeType,
        contentBase64: Buffer.from(attachment.bytes).toString("base64"),
      });
      ids.push(created.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Attachment failed.";
      notes.push(`Could not attach ${label}: ${message}`);
    }
  }
  return { ids, notes };
}

export async function ingestInboundMessage(
  ctx: PluginContext,
  connection: TelegramConnection,
  message: InboundDirectMessage,
): Promise<Issue | null> {
  if (!shouldAcceptInbound(connection, message)) return null;
  const originId = dialogOriginId(message.accountId, message.peerId);
  return withDialogLock(`${connection.companyId}:${originId}`, () => ingestDialog(ctx, connection, message, originId));
}

async function ingestDialog(
  ctx: PluginContext,
  connection: TelegramConnection,
  message: InboundDirectMessage,
  originId: string,
): Promise<Issue | null> {
  const storedFiles = await storeInboundFiles(ctx, connection.companyId, message.attachments);
  const existing = await ctx.issues.list({
    companyId: connection.companyId,
    originKind: DIALOG_ORIGIN_KIND,
    originId,
    limit: 1,
  });
  const current = existing[0];
  let issue: Issue;
  if (current) {
    const patch: { assigneeAgentId?: string; status?: Issue["status"] } = {};
    if (connection.assignedAgentId && current.assigneeAgentId !== connection.assignedAgentId) {
      patch.assigneeAgentId = connection.assignedAgentId;
    }
    const reopened = reopenDialogForInbound(current.status);
    if (reopened) patch.status = reopened;
    issue = Object.keys(patch).length > 0
      ? await ctx.issues.update(current.id, patch, connection.companyId)
      : current;
  } else {
    issue = await ctx.issues.create({
      companyId: connection.companyId,
      title: formatNewIssueTitle(message),
      description: formatInboundComment(message, storedFiles),
      status: "todo",
      assigneeAgentId: connection.assignedAgentId ?? undefined,
      originKind: DIALOG_ORIGIN_KIND,
      originId,
    });
  }

  const attached = await attachInboundFiles(ctx, connection.companyId, issue.id, message.attachments);
  const body = formatInboundComment(message, storedFiles, attached.ids, attached.notes);
  if (current) {
    await ctx.issues.createComment(issue.id, body, connection.companyId);
  } else if (body !== issue.description) {
    issue = await ctx.issues.update(issue.id, { description: body }, connection.companyId);
  }
  if (connection.assignedAgentId) {
    await ctx.issues.requestWakeup(issue.id, connection.companyId, {
      reason: "telegram-inbound",
      contextSource: "plugin-pc-telegram",
    });
  }
  return await ctx.issues.get(issue.id, connection.companyId) ?? issue;
}
