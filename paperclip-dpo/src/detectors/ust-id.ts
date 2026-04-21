import type { Finding } from "../types.js";

const UST_RE = /\b(?:DE\d{9}|ATU\d{8}|FR[A-Z0-9]{2}\d{9}|IT\d{11}|ES[A-Z0-9]\d{7}[A-Z0-9]|NL\d{9}B\d{2}|BE0?\d{9,10}|LU\d{8}|PL\d{10})\b/g;

export function detectUstIds(text: string): Finding[] {
  const findings: Finding[] = [];
  for (const m of text.matchAll(UST_RE)) {
    findings.push({
      type: "UST_ID",
      value: m[0],
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
      confidence: "high",
      source: "regex",
    });
  }
  return findings;
}
