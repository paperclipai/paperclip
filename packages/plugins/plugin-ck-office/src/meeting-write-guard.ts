const PLACEHOLDER_MEETING = /\b(?:test|testing|placeholder|dummy|probe|smoke|diagnostic|experiment)\b/i;

export function validateMeetingWrite(input: {
  name?: string;
  accountId?: string;
  evidenceEmailId?: string;
}): { ok: true } | { ok: false; error: string } {
  const name = String(input.name ?? "").trim();
  if (!name) return { ok: false, error: "meeting name is required" };
  if (PLACEHOLDER_MEETING.test(name)) {
    return { ok: false, error: "REFUSED: test, placeholder, and diagnostic meetings cannot be created in live CRM" };
  }
  if (!String(input.accountId ?? "").trim()) {
    return { ok: false, error: "account_id is required for a production CRM meeting" };
  }
  if (!String(input.evidenceEmailId ?? "").trim()) {
    return { ok: false, error: "evidence_email_id is required; meetings must be grounded in a real CRM communication" };
  }
  return { ok: true };
}
