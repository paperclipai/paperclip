export const APPROVAL_DRAFT_DEBOUNCE_MS = 800;

export type ApprovalDraftKind = "comment" | "decision";

export function buildApprovalDraftStorageKey(
  kind: ApprovalDraftKind,
  companyId: string,
  approvalId: string,
): string {
  return `paperclip:approval:${kind}-draft:${companyId}:${approvalId}`;
}

export function normalizeDraftValue(value: string): string {
  return value.trim() ? value : "";
}

export function normalizeDecisionNote(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed || undefined;
}
