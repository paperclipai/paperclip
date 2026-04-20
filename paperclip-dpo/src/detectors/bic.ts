import type { Finding } from "../types.js";

const BIC_RE = /\b[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b/g;

export function detectBics(text: string): Finding[] {
  const findings: Finding[] = [];
  for (const m of text.matchAll(BIC_RE)) {
    findings.push({
      type: "BIC",
      value: m[0],
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
      confidence: "high",
      source: "regex",
    });
  }
  return findings;
}
