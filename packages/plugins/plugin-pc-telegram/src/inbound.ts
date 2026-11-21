import type { Issue, PluginContext } from "@paperclipai/plugin-sdk";
import {
  COMPANY_LIFETIME_ATTACHMENTS,
  COMPANY_LIFETIME_BYTES,
  COMPANY_LIFETIME_MESSAGES,
  COMPANY_WINDOW_ATTACHMENTS,
  COMPANY_WINDOW_BYTES,
  COMPANY_WINDOW_MESSAGES,
  CONNECTION_LIFETIME_ATTACHMENTS,
  CONNECTION_LIFETIME_BYTES,
  CONNECTION_LIFETIME_MESSAGES,
  CONNECTION_WINDOW_ATTACHMENTS,
  CONNECTION_WINDOW_BYTES,
  CONNECTION_WINDOW_MESSAGES,
  DIALOG_ORIGIN_KIND,
  DEFAULT_INCOMING_MODE,
  FILE_NAMESPACE,
  INBOUND_MEDIA_WINDOW_MS,
  INBOUND_MESSAGE_WINDOW_MS,
  INBOUND_NEW_PEER_WINDOW_MS,
  INBOUND_QUOTA_DAY_MS,
  INBOUND_QUOTA_NAMESPACE,
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

const USER_PEER_ID = /^[1-9]\d{0,15}$/;

export function senderAllowed(connection: TelegramConnection, message: InboundDirectMessage): boolean {
  if (!USER_PEER_ID.test(message.peerId)) return false;
  if (connection.acceptUnlistedSenders) return true;
  return connection.allowedPeerIds.includes(message.peerId);
}

export function inboundShapeAllowed(connection: TelegramConnection, message: InboundDirectMessage): boolean {
  if (connection.paused) return false;
  if (connection.incomingMode !== DEFAULT_INCOMING_MODE) return false;
  if (connection.telegramUserId !== message.accountId) return false;
  if (connection.companyId !== message.companyId) return false;
  if (!message.isPrivate || message.isGroup || message.isOutgoing) return false;
  return senderAllowed(connection, message);
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
const QUOTA_MAP_CAP = 4096;

function sweepStamps(map: Map<string, number[]>, windowMs: number, now: number): void {
  for (const [key, stamps] of map) {
    const live = stamps.filter((at) => now - at < windowMs);
    if (live.length === 0) map.delete(key);
    else if (live.length !== stamps.length) map.set(key, live);
  }
  while (map.size > QUOTA_MAP_CAP) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function sweepQuotaMaps(now: number): void {
  sweepStamps(peerMediaHits, INBOUND_MEDIA_WINDOW_MS, now);
  sweepStamps(peerMediaDays, INBOUND_QUOTA_DAY_MS, now);
  sweepStamps(peerMessageHits, INBOUND_MESSAGE_WINDOW_MS, now);
  sweepStamps(peerMessageDays, INBOUND_QUOTA_DAY_MS, now);
  sweepStamps(newPeerHits, INBOUND_NEW_PEER_WINDOW_MS, now);
}

export function inboundQuotaKeyCount(): number {
  return peerMediaHits.size
    + peerMediaDays.size
    + peerMessageHits.size
    + peerMessageDays.size
    + newPeerHits.size;
}

function rememberStamps(map: Map<string, number[]>, key: string, stamps: number[]): void {
  if (stamps.length === 0) map.delete(key);
  else map.set(key, stamps);
}

function readWindow(
  hits: Map<string, number[]>,
  days: Map<string, number[]>,
  key: string,
  now: number,
  windowMs: number,
): { recent: number[]; day: number[] } {
  sweepQuotaMaps(now);
  return {
    recent: (hits.get(key) ?? []).filter((at) => now - at < windowMs),
    day: (days.get(key) ?? []).filter((at) => now - at < INBOUND_QUOTA_DAY_MS),
  };
}

function peekWindowSlot(
  hits: Map<string, number[]>,
  days: Map<string, number[]>,
  key: string,
  now: number,
  windowMs: number,
  windowCap: number,
  dayCap: number,
): boolean {
  const { recent, day } = readWindow(hits, days, key, now, windowMs);
  return day.length < dayCap && recent.length < windowCap;
}

function takeWindowSlot(
  hits: Map<string, number[]>,
  days: Map<string, number[]>,
  key: string,
  now: number,
  windowMs: number,
  windowCap: number,
  dayCap: number,
): boolean {
  const { recent, day } = readWindow(hits, days, key, now, windowMs);
  if (day.length >= dayCap || recent.length >= windowCap) {
    rememberStamps(days, key, day);
    rememberStamps(hits, key, recent);
    return false;
  }
  recent.push(now);
  day.push(now);
  rememberStamps(hits, key, recent);
  rememberStamps(days, key, day);
  return true;
}

export function peekPeerMediaSlot(peerKey: string, now = Date.now()): boolean {
  return peekWindowSlot(
    peerMediaHits,
    peerMediaDays,
    peerKey,
    now,
    INBOUND_MEDIA_WINDOW_MS,
    MAX_INBOUND_MEDIA_PER_PEER,
    MAX_INBOUND_MEDIA_PER_PEER_DAY,
  );
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
  sweepQuotaMaps(now);
  const recent = (newPeerHits.get(companyId) ?? []).filter((at) => now - at < INBOUND_NEW_PEER_WINDOW_MS);
  if (recent.length >= MAX_NEW_INBOUND_PEERS_PER_HOUR) {
    rememberStamps(newPeerHits, companyId, recent);
    return false;
  }
  recent.push(now);
  rememberStamps(newPeerHits, companyId, recent);
  return true;
}

export type InboundUsage = {
  messages: number;
  attachments: number;
  bytes: number;
};

type UsageSlice = { hour: number; messages: number; attachments: number; bytes: number };
type UsageBucket = {
  slices: UsageSlice[];
  lifetimeMessages: number;
  lifetimeAttachments: number;
  lifetimeBytes: number;
  touchedAt: number;
};
type UsageCaps = {
  windowMessages: number;
  windowAttachments: number;
  windowBytes: number;
  lifetimeMessages: number;
  lifetimeAttachments: number;
  lifetimeBytes: number;
};
type QuotaLedger = {
  company: UsageBucket;
  connections: Record<string, UsageBucket>;
};

const COMPANY_CAPS: UsageCaps = {
  windowMessages: COMPANY_WINDOW_MESSAGES,
  windowAttachments: COMPANY_WINDOW_ATTACHMENTS,
  windowBytes: COMPANY_WINDOW_BYTES,
  lifetimeMessages: COMPANY_LIFETIME_MESSAGES,
  lifetimeAttachments: COMPANY_LIFETIME_ATTACHMENTS,
  lifetimeBytes: COMPANY_LIFETIME_BYTES,
};
const CONNECTION_CAPS: UsageCaps = {
  windowMessages: CONNECTION_WINDOW_MESSAGES,
  windowAttachments: CONNECTION_WINDOW_ATTACHMENTS,
  windowBytes: CONNECTION_WINDOW_BYTES,
  lifetimeMessages: CONNECTION_LIFETIME_MESSAGES,
  lifetimeAttachments: CONNECTION_LIFETIME_ATTACHMENTS,
  lifetimeBytes: CONNECTION_LIFETIME_BYTES,
};
const quotaLocks = new Map<string, Promise<void>>();
const dialogIssueIds = new Map<string, string>();
const MAX_DIALOG_CACHE = 1024;
const MAX_LEDGER_CONNECTIONS = 200;

function emptyBucket(): UsageBucket {
  return {
    slices: [],
    lifetimeMessages: 0,
    lifetimeAttachments: 0,
    lifetimeBytes: 0,
    touchedAt: 0,
  };
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function parseBucket(value: unknown): UsageBucket | null {
  if (value == null) return emptyBucket();
  if (typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const slices: UsageSlice[] = [];
  if (Array.isArray(record.slices)) {
    for (const item of record.slices) {
      if (!item || typeof item !== "object") continue;
      const slice = item as Record<string, unknown>;
      slices.push({
        hour: asCount(slice.hour),
        messages: asCount(slice.messages),
        attachments: asCount(slice.attachments),
        bytes: asCount(slice.bytes),
      });
    }
  }
  return {
    slices,
    lifetimeMessages: asCount(record.lifetimeMessages),
    lifetimeAttachments: asCount(record.lifetimeAttachments),
    lifetimeBytes: asCount(record.lifetimeBytes),
    touchedAt: asCount(record.touchedAt),
  };
}

function parseLedger(value: unknown): QuotaLedger | null {
  if (value == null) return { company: emptyBucket(), connections: {} };
  if (typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const company = parseBucket(record.company);
  if (!company) return null;
  const connections: Record<string, UsageBucket> = {};
  if (record.connections && typeof record.connections === "object") {
    for (const [key, bucket] of Object.entries(record.connections as Record<string, unknown>)) {
      const parsed = parseBucket(bucket);
      if (!parsed) return null;
      connections[key] = parsed;
    }
  }
  return { company, connections };
}

function rolling(bucket: UsageBucket, now: number): { messages: number; attachments: number; bytes: number } {
  const hour = Math.floor(now / 3_600_000);
  let messages = 0;
  let attachments = 0;
  let bytes = 0;
  bucket.slices = bucket.slices.filter((slice) => slice.hour >= hour - 23 && slice.hour <= hour);
  for (const slice of bucket.slices) {
    messages += slice.messages;
    attachments += slice.attachments;
    bytes += slice.bytes;
  }
  return { messages, attachments, bytes };
}

function usageFits(bucket: UsageBucket, caps: UsageCaps, usage: InboundUsage, now: number): boolean {
  const recent = rolling(bucket, now);
  return bucket.lifetimeMessages + usage.messages <= caps.lifetimeMessages
    && bucket.lifetimeAttachments + usage.attachments <= caps.lifetimeAttachments
    && bucket.lifetimeBytes + usage.bytes <= caps.lifetimeBytes
    && recent.messages + usage.messages <= caps.windowMessages
    && recent.attachments + usage.attachments <= caps.windowAttachments
    && recent.bytes + usage.bytes <= caps.windowBytes;
}

function applyUsage(bucket: UsageBucket, usage: InboundUsage, now: number): void {
  const hour = Math.floor(now / 3_600_000);
  rolling(bucket, now);
  let slice = bucket.slices.find((item) => item.hour === hour);
  if (!slice) {
    slice = { hour, messages: 0, attachments: 0, bytes: 0 };
    bucket.slices.push(slice);
  }
  slice.messages += usage.messages;
  slice.attachments += usage.attachments;
  slice.bytes += usage.bytes;
  bucket.lifetimeMessages += usage.messages;
  bucket.lifetimeAttachments += usage.attachments;
  bucket.lifetimeBytes += usage.bytes;
  bucket.touchedAt = now;
}

function pruneConnections(ledger: QuotaLedger, keepId: string, now: number): void {
  for (const [id, bucket] of Object.entries(ledger.connections)) {
    if (id !== keepId) rolling(bucket, now);
  }
  // A day of silence used to delete the account bucket and zero its lifetime
  // cap. Keep the totals. Past the connection cap, shed hourly slices only.
  const overflow = Object.keys(ledger.connections).length - MAX_LEDGER_CONNECTIONS;
  if (overflow <= 0) return;
  const oldest = Object.entries(ledger.connections)
    .filter(([id]) => id !== keepId)
    .sort((left, right) => left[1].touchedAt - right[1].touchedAt);
  for (const [, bucket] of oldest.slice(0, overflow)) bucket.slices = [];
}

function withQuotaLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = quotaLocks.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate, () => gate);
  quotaLocks.set(key, tail);
  return previous.then(fn, fn).finally(() => {
    release();
    if (quotaLocks.get(key) === tail) quotaLocks.delete(key);
  });
}

async function readLedger(ctx: PluginContext, companyId: string): Promise<QuotaLedger | null> {
  const stored = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    namespace: INBOUND_QUOTA_NAMESPACE,
    stateKey: "ledger",
  });
  return parseLedger(stored);
}

async function writeLedger(ctx: PluginContext, companyId: string, ledger: QuotaLedger): Promise<void> {
  await ctx.state.set({
    scopeKind: "company",
    scopeId: companyId,
    namespace: INBOUND_QUOTA_NAMESPACE,
    stateKey: "ledger",
  }, ledger);
}

async function withLedger(
  ctx: PluginContext,
  connection: TelegramConnection,
  usage: InboundUsage,
  now: number,
  commit: boolean,
): Promise<boolean> {
  if (usage.messages < 0 || usage.attachments < 0 || usage.bytes < 0) return false;
  if (usage.messages === 0 && usage.attachments === 0 && usage.bytes === 0) return true;
  try {
    return await withQuotaLock(connection.companyId, async () => {
      const ledger = await readLedger(ctx, connection.companyId);
      if (!ledger) return false;
      const account = ledger.connections[connection.telegramUserId] ?? emptyBucket();
      if (!usageFits(ledger.company, COMPANY_CAPS, usage, now) || !usageFits(account, CONNECTION_CAPS, usage, now)) {
        return false;
      }
      if (!commit) return true;
      applyUsage(ledger.company, usage, now);
      applyUsage(account, usage, now);
      ledger.connections[connection.telegramUserId] = account;
      pruneConnections(ledger, connection.telegramUserId, now);
      await writeLedger(ctx, connection.companyId, ledger);
      return true;
    });
  } catch {
    return false;
  }
}

export function hasInboundBudget(
  ctx: PluginContext,
  connection: TelegramConnection,
  usage: InboundUsage,
  now = Date.now(),
): Promise<boolean> {
  return withLedger(ctx, connection, usage, now, false);
}

export function commitInboundUsage(
  ctx: PluginContext,
  connection: TelegramConnection,
  usage: InboundUsage,
  now = Date.now(),
): Promise<boolean> {
  return withLedger(ctx, connection, usage, now, true);
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

function rememberDialog(key: string, issueId: string): void {
  if (dialogIssueIds.has(key)) dialogIssueIds.delete(key);
  dialogIssueIds.set(key, issueId);
  while (dialogIssueIds.size > MAX_DIALOG_CACHE) {
    const oldest = dialogIssueIds.keys().next().value;
    if (oldest === undefined) break;
    dialogIssueIds.delete(oldest);
  }
}

async function findDialog(
  ctx: PluginContext,
  connection: TelegramConnection,
  originId: string,
): Promise<Issue | null> {
  const cacheKey = `${connection.companyId}:${originId}`;
  const cachedId = dialogIssueIds.get(cacheKey);
  if (cachedId) {
    const cached = await ctx.issues.get(cachedId, connection.companyId);
    if (cached) return cached;
    dialogIssueIds.delete(cacheKey);
  }
  const existing = await ctx.issues.list({
    companyId: connection.companyId,
    originKind: DIALOG_ORIGIN_KIND,
    originId,
    limit: 5,
  });
  const current = existing.find((item) => item.originId === originId) ?? existing[0] ?? null;
  if (current) rememberDialog(cacheKey, current.id);
  return current;
}

async function writeDialog(
  ctx: PluginContext,
  connection: TelegramConnection,
  message: InboundDirectMessage,
  originId: string,
): Promise<Issue | null> {
  const cacheKey = `${connection.companyId}:${originId}`;
  let current = await findDialog(ctx, connection, originId);
  const usage = {
    messages: 1,
    attachments: message.attachments.length,
    bytes: message.attachments.reduce((sum, file) => sum + file.byteLength, 0),
  };
  if (!(await hasInboundBudget(ctx, connection, usage))) return null;
  if (!current && !takeNewPeerSlot(connection.companyId)) return null;
  if (!(await commitInboundUsage(ctx, connection, usage))) return null;
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
    rememberDialog(cacheKey, issue.id);
    const raced = await ctx.issues.list({
      companyId: connection.companyId,
      originKind: DIALOG_ORIGIN_KIND,
      originId,
      limit: 5,
    });
    const earlier = raced.find((item) => item.originId === originId && item.id !== issue.id);
    if (earlier) {
      rememberDialog(cacheKey, earlier.id);
      current = earlier;
      issue = earlier;
    }
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
