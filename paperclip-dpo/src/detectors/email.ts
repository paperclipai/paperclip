import type { Finding } from "../types.js";

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

export function detectEmails(text: string): Finding[] {
  const findings: Finding[] = [];
  for (const m of text.matchAll(EMAIL_RE)) {
    findings.push({
      type: "EMAIL",
      value: m[0],
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
      confidence: "high",
      source: "regex",
    });
  }
  return findings;
}
