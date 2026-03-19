const LEGACY_ISSUE_DRAFT_STORAGE_KEY = "paperclip:issue-draft";
const ISSUE_DRAFT_STORAGE_PREFIX = `${LEGACY_ISSUE_DRAFT_STORAGE_KEY}:company`;

export const ISSUE_DRAFT_DEBOUNCE_MS = 800;

export interface StoredIssueDraft {
  title: string;
  description: string;
  status: string;
  priority: string;
  assigneeValue: string;
  assigneeId?: string;
  projectId: string;
  assigneeModelOverride: string;
  assigneeThinkingEffort: string;
  assigneeChrome: boolean;
  useIsolatedExecutionWorkspace: boolean;
}

function parseIssueDraft(raw: string | null): StoredIssueDraft | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredIssueDraft;
  } catch {
    return null;
  }
}

export function buildIssueDraftStorageKey(companyId: string | null | undefined): string {
  return companyId ? `${ISSUE_DRAFT_STORAGE_PREFIX}:${companyId}` : LEGACY_ISSUE_DRAFT_STORAGE_KEY;
}

export function loadIssueDraft(companyId: string | null | undefined): StoredIssueDraft | null {
  const scopedDraft = parseIssueDraft(localStorage.getItem(buildIssueDraftStorageKey(companyId)));
  if (scopedDraft) return scopedDraft;
  if (!companyId) return null;
  return parseIssueDraft(localStorage.getItem(LEGACY_ISSUE_DRAFT_STORAGE_KEY));
}

export function saveIssueDraft(companyId: string | null | undefined, draft: StoredIssueDraft): void {
  localStorage.setItem(buildIssueDraftStorageKey(companyId), JSON.stringify(draft));
  if (companyId) {
    localStorage.removeItem(LEGACY_ISSUE_DRAFT_STORAGE_KEY);
  }
}

export function clearIssueDraft(companyId: string | null | undefined): void {
  localStorage.removeItem(buildIssueDraftStorageKey(companyId));
  if (companyId) {
    localStorage.removeItem(LEGACY_ISSUE_DRAFT_STORAGE_KEY);
  }
}
