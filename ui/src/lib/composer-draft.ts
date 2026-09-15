/**
 * Per-task composer draft persistence, shared by the chat composers.
 *
 * Ordinary task drafts use localStorage; agent chat drafts use tab-scoped
 * sessionStorage under the caller-provided key. All
 * access is guarded so disabled or full storage never throws into React.
 * Empty drafts remove the text key. Uploaded receipt metadata has a separate,
 * versioned task-keyed record; legacy text drafts remain plain strings.
 */

/** Debounce before a keystroke lands in browser storage. */
export const DRAFT_DEBOUNCE_MS = 800;

// Chat drafts and uncertain submissions belong to this browser tab. Sharing a
// submission fence across tabs prevents intentional concurrent conversation turns.
function draftStorage(draftKey: string): Storage {
  return draftKey.startsWith("paperclip:agent-chat-draft:") ? sessionStorage : localStorage;
}

export function loadDraft(draftKey: string): string {
  try {
    return draftStorage(draftKey).getItem(draftKey) ?? "";
  } catch {
    return "";
  }
}

function mayWriteDraft(draftKey: string, attemptId?: string) {
  const pending = loadDraftSubmission(draftKey);
  return !pending || pending.attemptId === attemptId;
}

export function saveDraft(draftKey: string, value: string, attemptId?: string) {
  try {
    if (!mayWriteDraft(draftKey, attemptId)) return;
    if (value.trim()) {
      draftStorage(draftKey).setItem(draftKey, value);
    } else {
      draftStorage(draftKey).removeItem(draftKey);
    }
  } catch {
    // Ignore browser storage failures.
  }
}

export function clearDraft(draftKey: string, attemptId?: string) {
  try {
    if (!mayWriteDraft(draftKey, attemptId)) return;
    draftStorage(draftKey).removeItem(draftKey);
    draftStorage(draftKey).removeItem(`${draftKey}:attachments:v1`);
    draftStorage(draftKey).removeItem(`${draftKey}:submission:v1`);
  } catch {
    // Ignore browser storage failures.
  }
}

export interface ComposerDraftSubmission {
  attemptId: string;
  reviewed: boolean;
  /** Start of text typed after the submitted body in a restored uncertain draft. */
  nextDraftOffset?: number;
  submittedAttachmentIds?: string[];
}

/** Retained client request ID. It is not delivery proof until a matching
 * server receipt is observed; use the same ID for submission and reconciliation. */
export function loadDraftSubmission(
  draftKey: string,
): ComposerDraftSubmission | null {
  try {
    const raw = draftStorage(draftKey).getItem(`${draftKey}:submission:v1`);
    if (!raw || raw.length > 16_384) return null;
    const record = JSON.parse(raw);
    return record?.version === 1 &&
      record.draftKey === draftKey &&
      Object.keys(record).every((key) => ["version", "draftKey", "attemptId", "reviewed", "nextDraftOffset", "submittedAttachmentIds"].includes(key)) &&
      typeof record.attemptId === "string" &&
      /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(record.attemptId) &&
      typeof record.reviewed === "boolean" &&
      (record.nextDraftOffset === undefined || (Number.isSafeInteger(record.nextDraftOffset) && record.nextDraftOffset >= 0)) &&
      (record.submittedAttachmentIds === undefined || (Array.isArray(record.submittedAttachmentIds) && record.submittedAttachmentIds.length <= 256 && record.submittedAttachmentIds.every((id: unknown) => typeof id === "string" && id.length <= 128)))
      ? { attemptId: record.attemptId, reviewed: record.reviewed,
          ...(record.nextDraftOffset !== undefined ? { nextDraftOffset: record.nextDraftOffset } : {}),
          ...(record.submittedAttachmentIds !== undefined ? { submittedAttachmentIds: record.submittedAttachmentIds } : {}),
        }
      : null;
  } catch {
    return null;
  }
}

export function saveDraftSubmission(
  draftKey: string,
  submission: ComposerDraftSubmission,
) {
  try {
    // An old completion/review must not replace a different retained intent.
    // This is a local guard, not cross-tab atomicity or server idempotency.
    if (!mayWriteDraft(draftKey, submission.attemptId)) return;
    draftStorage(draftKey).setItem(
      `${draftKey}:submission:v1`,
      JSON.stringify({ version: 1, draftKey, ...submission }),
    );
  } catch {
    /* The composer also retains the fence in memory. */
  }
}

export function clearDraftSubmission(draftKey: string, attemptId: string) {
  try {
    if (loadDraftSubmission(draftKey)?.attemptId === attemptId)
      draftStorage(draftKey).removeItem(`${draftKey}:submission:v1`);
  } catch {
    /* Disabled browser storage is supported in memory. */
  }
}

/** A late response can settle only its own retained intent, never a newer draft. */
export function settleDraftSubmission(draftKey: string, attemptId: string, nextDraft?: string): boolean {
  const submission = loadDraftSubmission(draftKey);
  if (submission?.attemptId !== attemptId) return false;
  nextDraft ??= submission.nextDraftOffset === undefined
    ? "" : loadDraft(draftKey).slice(submission.nextDraftOffset);
  const nextAttachments = submission.submittedAttachmentIds === undefined ? []
    : loadDraftAttachments(draftKey).filter(item => !submission.submittedAttachmentIds!.includes(item.attachmentId));
  clearDraft(draftKey, attemptId);
  if (nextDraft) saveDraft(draftKey, nextDraft);
  if (nextAttachments.length) saveDraftAttachments(draftKey, nextAttachments);
  return true;
}

export interface ComposerDraftAttachment {
  attachmentId: string;
  name: string;
  size?: number;
  inline: boolean;
  contentPath: string;
}

function draftAttachments(value: unknown): ComposerDraftAttachment[] {
  if (!Array.isArray(value) || value.length > 20) return [];
  const seen = new Set<string>();
  const result: ComposerDraftAttachment[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    if (row.status !== undefined && row.status !== "attached") continue;
    if (
      typeof row.attachmentId !== "string" ||
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(
        row.attachmentId,
      ) ||
      seen.has(row.attachmentId)
    )
      continue;
    if (
      typeof row.name !== "string" ||
      row.name.length === 0 ||
      row.name.length > 512 ||
      typeof row.inline !== "boolean"
    )
      continue;
    if (row.contentPath !== `/api/attachments/${row.attachmentId}/content`)
      continue;
    if (
      row.size !== undefined &&
      (typeof row.size !== "number" ||
        !Number.isSafeInteger(row.size) ||
        row.size < 0)
    )
      continue;
    seen.add(row.attachmentId);
    result.push({
      attachmentId: row.attachmentId,
      name: row.name,
      inline: row.inline,
      contentPath: row.contentPath,
      ...(row.size === undefined ? {} : { size: row.size as number }),
    });
  }
  return result;
}

/** Selection hints only. The server still rechecks task/company ownership and
 * atomically binds the receipt; stored text or metadata never grants access. */
export function loadDraftAttachments(
  draftKey: string,
): ComposerDraftAttachment[] {
  try {
    const raw = draftStorage(draftKey).getItem(`${draftKey}:attachments:v1`);
    if (!raw || raw.length > 32_768) return [];
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const record = value as Record<string, unknown>;
    return record.version === 1 && record.draftKey === draftKey
      ? draftAttachments(record.attachments)
      : [];
  } catch {
    return [];
  }
}

export function saveDraftAttachments(draftKey: string, attachments: unknown, attemptId?: string) {
  try {
    // Only the owning pending request may persist newly uploaded receipts.
    // Generic effects and stale composer cleanups must not rewrite its snapshot.
    if (!mayWriteDraft(draftKey, attemptId)) return;
    const selected = draftAttachments(attachments);
    if (selected.length)
      draftStorage(draftKey).setItem(
        `${draftKey}:attachments:v1`,
        JSON.stringify({ version: 1, draftKey, attachments: selected }),
      );
    else draftStorage(draftKey).removeItem(`${draftKey}:attachments:v1`);
  } catch {
    /* Disabled/full browser storage must not break the composer. */
  }
}
export function loadStructuredDraft<T>(draftKey: string, fallback: T): T {
  try {
    const value = draftStorage(draftKey).getItem(draftKey);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function saveStructuredDraft(draftKey: string, value: unknown) {
  try {
    draftStorage(draftKey).setItem(draftKey, JSON.stringify(value));
  } catch {
    // Ignore browser storage failures.
  }
}
