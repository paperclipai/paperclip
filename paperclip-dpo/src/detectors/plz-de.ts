import type { Finding } from "../types.js";

const PLZ_RE = /\b(\d{5})\s+([A-ZÄÖÜ][a-zäöüß-]+(?:\s[A-ZÄÖÜ][a-zäöüß-]+)?)\b/g;

export function detectPlzDe(text: string): Finding[] {
  const findings: Finding[] = [];
  for (const m of text.matchAll(PLZ_RE)) {
    const plzStart = m.index ?? 0;
    findings.push({
      type: "PLZ",
      value: m[1],
      start: plzStart,
      end: plzStart + m[1].length,
      confidence: "high",
      source: "regex",
    });
  }
  return findings;
}
