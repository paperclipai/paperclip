import type { Finding } from "../types.js";

const IBAN_RE = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g;

export function detectIbans(text: string): Finding[] {
  const findings: Finding[] = [];
  for (const m of text.matchAll(IBAN_RE)) {
    const compact = m[0].replace(/\s/g, "");
    if (compact.length < 15 || compact.length > 34) continue;
    findings.push({
      type: "IBAN",
      value: m[0],
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
      confidence: "high",
      source: "regex",
    });
  }
  return findings;
}
