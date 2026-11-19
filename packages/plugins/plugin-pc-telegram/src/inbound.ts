import type { Issue, PluginContext } from "@paperclipai/plugin-sdk";
import {
  DIALOG_ORIGIN_KIND,
  DEFAULT_INCOMING_MODE,
  FILE_NAMESPACE,
  INBOUND_MEDIA_WINDOW_MS,
  INBOUND_MESSAGE_WINDOW_MS,
  INBOUND_NEW_PEER_WINDOW_MS,
  INBOUND_QUOTA_DAY_MS,
  MAX_INBOUND_MEDIA_BYTES,
  MAX_INBOUND_MEDIA_PER_PEER,
  MAX_INBOUND_MEDIA_PER_PEER_DAY,
  MAX_INBOUND_MESSAGES_PER_PEER,
  MAX_INBOUND_MESSAGES_PER_PEER_DAY,
  MAX_NEW_INBOUND_PEERS_PER_HOUR,
} from "./constants.js";
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

export function inboundShapeAllowed(connection: TelegramConnection, message: InboundDirectMessage): boolean {
  if (connection.paused) return false;
  if (connection.incomingMode !== DEFAULT_INCOMING_MODE) return false;
  if (connection.telegramUserId !== message.accountId) return false;
  if (connection.companyId !== message.companyId) return false;
  return message.isPrivate && !message.isGroup && !message.isOutgoing;
}

export function shouldAcceptInbound(connection: TelegramConnection, message: InboundDirectMessage): boolean {
  if (!inboundShapeAllowed(connection, message)) return false;
  return message.text.trim().length > 0 || message.attachments.length > 0;
}

const peerMediaHits = new Map<string, number[]>();
const peerMediaDays = new Map<string, number[]>();
const peerMessageHits = new Map<string, number[]>();
const peerMessageDays = new Map<string, number[]>();
const newPeerHits = new Map<string, number[]>();

function takeWindowSlot(
  hits: Map<string, number[]>,
  days: Map<string, number[]>,
  key: string,
  now: number,
  windowMs: number,
  windowCap: number,
  dayCap: number,
): boolean {
  const day = (days.get(key) ?? []).filter((at) => now - at < INBOUND_QUOTA_DAY_MS);
  if (day.length >= dayCap) {
    days.set(key, day);
    return false;
  }
  const recent = (hits.get(key) ?? []).filter((at) => now - at < windowMs);
  if (recent.length >= windowCap) {
    hits.set(key, recent);
    days.set(key, day);
    return false;
  }
  recent.push(now);
  day.push(now);
  hits.set(key, recent);
  days.set(key, day);
  return true;
}

export function takePeerMediaSlot(peerKey: string, now = Date.now()): boolean {
  return takeWindowSlot(
    peerMediaHits,
    peerMediaDays,
    peerKey,
    now,
    INBOUND_MEDIA_WINDOW_MS,
    MAX_INBOUND_MEDIA_PER_PEER,
    MAX_INBOUND_MEDIA_PER_PEER_DAY,
  );
}

export function takeInboundMessageSlot(peerKey: string, now = Date.now()): boolean {
  return takeWindowSlot(
    peerMessageHits,
    peerMessageDays,
    peerKey,
    now,
    INBOUND_MESSAGE_WINDOW_MS,
    MAX_INBOUND_MESSAGES_PER_PEER,
    MAX_INBOUND_MESSAGES_PER_PEER_DAY,
  );
}

export function takeNewPeerSlot(companyId: string, now = Date.now()): boolean {
  const recent = (newPeerHits.get(companyId) ?? []).filter((at) => now - at < INBOUND_NEW_PEER_WINDOW_MS);
  if (recent.length >= MAX_NEW_INBOUND_PEERS_PER_HOUR) {
    newPeerHits.set(companyId, recent);
    return false;
  }
  recent.push(now);
  newPeerHits.set(companyId, recent);
  return true;
}

function withinMediaCap(attachment: InboundAttachment): boolean {
  return attachment.byteLength <= MAX_INBOUND_MEDIA_BYTES
    && attachment.bytes.byteLength <= MAX_INBOUND_MEDIA_BYTES;
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

function attachmentLabel(kind: InboundAttachment["kind"], filename: string): string {
  const name = kind === "voice" ? "Voice message" : kind === "photo" ? "Photo" : kind === "video" ? "Video" : "Attachment";
  return `${name}: ${filename.replace(/[\[\]]/g, "")}`;
}

export function formatInboundComment(
  message: InboundDirectMessage,
  storedFiles: Array<Pick<InboundAttachment, "filename" | "mimeType" | "byteLength" | "kind">>,
  attachments: Array<{ filename: string; kind: InboundAttachment["kind"]; contentPath: string }> = [],
  failed: Array<{ filename: string; kind: InboundAttachment["kind"]; message: string }> = [],
): string {
  const lines: string[] = [];
  const speaker = message.peerName || message.peerId;
  lines.push(`**${speaker}**`);
  if (message.text.trim()) lines.push(message.text.trim());
  for (const file of storedFiles) {
    lines.push(`${attachmentLabel(file.kind, file.filename)} (${file.mimeType}, ${file.byteLength} bytes)`);
  }
  for (const attachment of attachments) {
    if (!attachment.contentPath.startsWith("/api/attachments/") || /[\s)]/.test(attachment.contentPath)) continue;
    lines.push(`[${attachmentLabel(attachment.kind, attachment.filename)}](${attachment.contentPath})`);
  }
  for (const failure of failed) {
    lines.push(`Could not attach ${attachmentLabel(failure.kind, failure.filename)}: ${failure.message}`);
  }
  return lines.join("\n\n");
}

export function formatNewIssueTitle(message: InboundDirectMessage): string {
  const name = message.peerName || message.peerId;
  return `Telegram · ${name}`;
}

export function storeInboundFiles(
  attachments: InboundAttachment[],
): Array<Pick<InboundAttachment, "id" | "filename" | "mimeType" | "byteLength" | "kind">> {
  return attachments.map((attachment) => ({
    id: attachment.id,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    byteLength: attachment.byteLength,
    kind: attachment.kind,
  }));
}

async function discardInboundFiles(
  ctx: PluginContext,
  companyId: string,
  attachments: InboundAttachment[],
): Promise<void> {
  for (const attachment of attachments) {
    await ctx.state.delete({
      scopeKind: "company",
      scopeId: companyId,
      namespace: FILE_NAMESPACE,
      stateKey: attachment.id,
    });
  }
}

const CLOSED_DIALOG_STATUSES = new Set(["backlog", "done", "cancelled"]);

async function attachInboundFiles(
  ctx: PluginContext,
  companyId: string,
  issueId: string,
  attachments: InboundAttachment[],
): Promise<{
  linked: Array<{ filename: string; kind: InboundAttachment["kind"]; contentPath: string }>;
  failed: Array<{ filename: string; kind: InboundAttachment["kind"]; message: string }>;
}> {
  const linked = [];
  const failed = [];
  for (const attachment of attachments) {
    try {
      const created = await ctx.issues.createAttachment({
        issueId,
        companyId,
        filename: attachment.filename,
        contentType: attachment.mimeType,
        contentBase64: Buffer.from(attachment.bytes).toString("base64"),
      });
      const contentPath = created.contentPath.startsWith("/api/attachments/")
        ? created.contentPath
        : `/api/attachments/${created.id}/content`;
      linked.push({ filename: attachment.filename, kind: attachment.kind, contentPath });
    } catch (error) {
      failed.push({
        filename: attachment.filename,
        kind: attachment.kind,
        message: error instanceof Error ? error.message : "Attachment failed.",
      });
    }
  }
  return { linked, failed };
}

export async function ingestInboundMessage(
  ctx: PluginContext,
  connection: TelegramConnection,
  input: InboundDirectMessage,
): Promise<Issue | null> {
  const message: InboundDirectMessage = {
    ...input,
    attachments: input.attachments.filter(withinMediaCap),
  };
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
  try {
    return await writeDialog(ctx, connection, message, originId);
  } finally {
    await discardInboundFiles(ctx, connection.companyId, message.attachments);
  }
}

async function writeDialog(
  ctx: PluginContext,
  connection: TelegramConnection,
  message: InboundDirectMessage,
  originId: string,
): Promise<Issue | null> {
  const existing = await ctx.issues.list({
    companyId: connection.companyId,
    originKind: DIALOG_ORIGIN_KIND,
    originId,
    limit: 1,
  });
  const current = existing[0];
  if (!current && !takeNewPeerSlot(connection.companyId)) return null;
  const storedFiles = storeInboundFiles(message.attachments);
  let issue: Issue;
  if (current) {
    const patch: { assigneeAgentId?: string; status?: Issue["status"] } = {};
    if (connection.assignedAgentId && current.assigneeAgentId !== connection.assignedAgentId) {
      patch.assigneeAgentId = connection.assignedAgentId;
    }
    if (CLOSED_DIALOG_STATUSES.has(current.status)) patch.status = "todo";
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
  const body = formatInboundComment(message, storedFiles, attached.linked, attached.failed);
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
