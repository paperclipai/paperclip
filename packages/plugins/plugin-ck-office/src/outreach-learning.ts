import { looksLikeTestOrExperiment } from "./send-guard.js";

export function rejectionFeedbackLesson(reason: unknown): string | null {
  const text = String(reason ?? "").trim();
  if (!text) return null;
  if (/^Cancelled in Outreach outbox; no email was sent\.?$/i.test(text)) return null;
  return `Alan held an outreach draft and gave this writing feedback: ${text}. Apply the underlying preference to future drafts, not only the exact sentence he flagged.`;
}

export function shouldLearnSentOutreachEdit(input: {
  edited: boolean;
  testLock?: boolean;
  subject: string;
  body: string;
}): boolean {
  if (!input.edited || input.testLock) return false;
  return !looksLikeTestOrExperiment(input.subject, input.body);
}
