const PLACEHOLDER_MEETING = /\b(?:test|testing|placeholder|dummy|probe|smoke|diagnostic|experiment)\b/i;

export function validateMeetingWrite(input: {
  name?: string;
  accountId?: string;
  evidenceEmailId?: string;
  confirmationQuote?: string;
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
  if (!String(input.confirmationQuote ?? "").trim()) {
    return { ok: false, error: "confirmation_quote is required; a request to propose dates is not a confirmed meeting" };
  }
  return { ok: true };
}

export function quoteMentionsMeetingDate(quote: string, dateStart: string): boolean {
  const match = String(dateStart).match(/^\d{4}-(\d{2})-(\d{2})/);
  if (!match) return false;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const names = [
    "january|januar|janvier", "february|februar|février|fevrier", "march|märz|maerz|mars",
    "april|avril", "may|mai", "june|juni|juin", "july|juli|juillet",
    "august|août|aout", "september|septembre", "october|oktober|octobre",
    "november|novembre", "december|dezember|décembre|decembre",
  ];
  const q = String(quote).toLowerCase();
  const numeric = new RegExp(`\\b0?${day}[./-]0?${month}(?:[./-]\\d{2,4})?\\b`).test(q);
  const named = new RegExp(`\\b0?${day}(?:st|nd|rd|th|\\.)?\\s+(?:${names[month - 1]})\\b`, "i").test(q);
  const englishNamed = new RegExp(`\\b(?:${names[month - 1]})\\s+0?${day}(?:st|nd|rd|th)?\\b`, "i").test(q);
  return numeric || named || englishNamed;
}
