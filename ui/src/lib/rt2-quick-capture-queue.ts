import type { Rt2InboundDraftSource } from "../api/rt2-tasks";

export const RT2_QUICK_CAPTURE_QUEUE_PREFIX = "realtycoon2.rt2.quick-capture.queue";
export const RT2_QUICK_CAPTURE_MAX_ITEMS = 50;
export const RT2_QUICK_CAPTURE_MAX_TEXT_LENGTH = 5000;

export type Rt2QuickCaptureQueueStatus = "draft" | "queued" | "sending" | "failed" | "sent";

export interface Rt2QuickCaptureQueueItem {
  id: string;
  companyId: string | null;
  projectId: string | null;
  source: Extract<Rt2InboundDraftSource, "mobile" | "native">;
  channel: string;
  text: string;
  status: Rt2QuickCaptureQueueStatus;
  createdAt: string;
  updatedAt: string;
  lastAttemptedAt: string | null;
  lastError: string | null;
  sentDraftId: string | null;
  sentDraftStatus: string | null;
}

export interface Rt2QuickCaptureQueueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type CreateRt2QuickCaptureQueueItemInput = {
  companyId?: string | null;
  projectId?: string | null;
  source?: Extract<Rt2InboundDraftSource, "mobile" | "native">;
  channel?: string | null;
  text: string;
  now?: Date;
  id?: string;
};

const ALLOWED_STATUSES = new Set<Rt2QuickCaptureQueueStatus>(["draft", "queued", "sending", "failed", "sent"]);
const ALLOWED_SOURCES = new Set(["mobile", "native"]);

function normalizeNullableString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeDateString(value: unknown, fallback: string) {
  if (typeof value !== "string" || value.trim().length === 0) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function normalizeText(value: unknown) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, RT2_QUICK_CAPTURE_MAX_TEXT_LENGTH);
}

function normalizeQueueItem(value: unknown): Rt2QuickCaptureQueueItem | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = normalizeNullableString(record.id);
  const text = normalizeText(record.text);
  if (!id || !text) return null;

  const now = new Date().toISOString();
  const createdAt = normalizeDateString(record.createdAt, now);
  const status = typeof record.status === "string" && ALLOWED_STATUSES.has(record.status as Rt2QuickCaptureQueueStatus)
    ? record.status as Rt2QuickCaptureQueueStatus
    : "queued";
  const source = typeof record.source === "string" && ALLOWED_SOURCES.has(record.source)
    ? record.source as Extract<Rt2InboundDraftSource, "mobile" | "native">
    : "mobile";
  const projectId = normalizeNullableString(record.projectId);

  return {
    id,
    companyId: normalizeNullableString(record.companyId),
    projectId,
    source,
    channel: normalizeNullableString(record.channel) ?? (projectId ? `quick-capture:${projectId}` : "quick-capture"),
    text,
    status,
    createdAt,
    updatedAt: normalizeDateString(record.updatedAt, createdAt),
    lastAttemptedAt: normalizeDateString(record.lastAttemptedAt, "") || null,
    lastError: normalizeNullableString(record.lastError),
    sentDraftId: normalizeNullableString(record.sentDraftId),
    sentDraftStatus: normalizeNullableString(record.sentDraftStatus),
  };
}

function safeRandomId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `rt2-qc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function bounded(items: Rt2QuickCaptureQueueItem[]) {
  return items
    .slice()
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, RT2_QUICK_CAPTURE_MAX_ITEMS);
}

export function rt2QuickCaptureQueueStorageKey(companyId?: string | null) {
  return `${RT2_QUICK_CAPTURE_QUEUE_PREFIX}:${companyId?.trim() || "local"}`;
}

export function getBrowserRt2QuickCaptureStorage(): Rt2QuickCaptureQueueStorage | null {
  if (typeof window === "undefined" || !window.localStorage) return null;
  return window.localStorage;
}

export function createRt2QuickCaptureQueueItem(
  input: CreateRt2QuickCaptureQueueItemInput,
): Rt2QuickCaptureQueueItem {
  const now = (input.now ?? new Date()).toISOString();
  const companyId = input.companyId?.trim() || null;
  const projectId = input.projectId?.trim() || null;
  const text = normalizeText(input.text);
  if (!text) {
    throw new Error("업무 기록 내용이 필요합니다.");
  }

  return {
    id: input.id ?? safeRandomId(),
    companyId,
    projectId,
    source: input.source ?? "mobile",
    channel: input.channel?.trim() || (projectId ? `quick-capture:${projectId}` : "quick-capture"),
    text,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    lastAttemptedAt: null,
    lastError: null,
    sentDraftId: null,
    sentDraftStatus: null,
  };
}

export function listRt2QuickCaptureQueue(
  storage: Rt2QuickCaptureQueueStorage | null,
  companyId?: string | null,
) {
  if (!storage) return [];
  const key = rt2QuickCaptureQueueStorageKey(companyId);
  const raw = storage.getItem(key);
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      storage.removeItem(key);
      return [];
    }
    return bounded(parsed.map(normalizeQueueItem).filter((item): item is Rt2QuickCaptureQueueItem => Boolean(item)));
  } catch {
    storage.removeItem(key);
    return [];
  }
}

export function saveRt2QuickCaptureQueue(
  storage: Rt2QuickCaptureQueueStorage | null,
  companyId: string | null | undefined,
  items: Rt2QuickCaptureQueueItem[],
) {
  if (!storage) return [];
  const normalized = bounded(items.map(normalizeQueueItem).filter((item): item is Rt2QuickCaptureQueueItem => Boolean(item)));
  storage.setItem(rt2QuickCaptureQueueStorageKey(companyId), JSON.stringify(normalized));
  return normalized;
}

export function enqueueRt2QuickCaptureItem(
  storage: Rt2QuickCaptureQueueStorage | null,
  input: CreateRt2QuickCaptureQueueItemInput,
) {
  const item = createRt2QuickCaptureQueueItem(input);
  const existing = listRt2QuickCaptureQueue(storage, item.companyId);
  const queue = saveRt2QuickCaptureQueue(storage, item.companyId, [item, ...existing.filter((entry) => entry.id !== item.id)]);
  return { item, queue };
}

export function removeRt2QuickCaptureItem(
  storage: Rt2QuickCaptureQueueStorage | null,
  companyId: string | null | undefined,
  itemId: string,
) {
  const queue = listRt2QuickCaptureQueue(storage, companyId).filter((item) => item.id !== itemId);
  return saveRt2QuickCaptureQueue(storage, companyId, queue);
}

export function updateRt2QuickCaptureItem(
  storage: Rt2QuickCaptureQueueStorage | null,
  companyId: string | null | undefined,
  itemId: string,
  update: (item: Rt2QuickCaptureQueueItem) => Rt2QuickCaptureQueueItem,
) {
  const queue = listRt2QuickCaptureQueue(storage, companyId);
  const next = queue.map((item) => item.id === itemId ? normalizeQueueItem(update(item)) ?? item : item);
  return saveRt2QuickCaptureQueue(storage, companyId, next);
}

export function markRt2QuickCaptureSending(
  storage: Rt2QuickCaptureQueueStorage | null,
  companyId: string | null | undefined,
  itemId: string,
  now = new Date(),
) {
  const timestamp = now.toISOString();
  return updateRt2QuickCaptureItem(storage, companyId, itemId, (item) => ({
    ...item,
    status: "sending",
    updatedAt: timestamp,
    lastAttemptedAt: timestamp,
    lastError: null,
  }));
}

export function markRt2QuickCaptureFailed(
  storage: Rt2QuickCaptureQueueStorage | null,
  companyId: string | null | undefined,
  itemId: string,
  error: string,
  now = new Date(),
) {
  const timestamp = now.toISOString();
  return updateRt2QuickCaptureItem(storage, companyId, itemId, (item) => ({
    ...item,
    status: "failed",
    updatedAt: timestamp,
    lastAttemptedAt: item.lastAttemptedAt ?? timestamp,
    lastError: error.slice(0, 500),
  }));
}

export function markRt2QuickCaptureSent(
  storage: Rt2QuickCaptureQueueStorage | null,
  companyId: string | null | undefined,
  itemId: string,
  sent: { draftId: string | null; draftStatus: string | null },
  now = new Date(),
) {
  const timestamp = now.toISOString();
  return updateRt2QuickCaptureItem(storage, companyId, itemId, (item) => ({
    ...item,
    status: "sent",
    updatedAt: timestamp,
    lastAttemptedAt: item.lastAttemptedAt ?? timestamp,
    lastError: null,
    sentDraftId: sent.draftId,
    sentDraftStatus: sent.draftStatus,
  }));
}
