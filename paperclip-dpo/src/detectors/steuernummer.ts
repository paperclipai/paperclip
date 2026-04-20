import type { Finding } from "../types.js";

const STNR_RE = /\b\d{2,3}\/\d{3}\/\d{4,5}\b/g;
const TID_RE = /\b\d{11}\b/g;

export function detectSteuernummern(text: string): Finding[] {
  const findings: Finding[] = [];
  for (const m of text.matchAll(STNR_RE)) {
    findings.push({
      type: "STEUERNUMMER",
      value: m[0],
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
      confidence: "high",
      source: "regex",
    });
  }
  for (const m of text.matchAll(TID_RE)) {
    findings.push({
      type: "STEUERNUMMER",
      value: m[0],
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
      confidence: "medium",
      source: "regex",
    });
  }
  return findings;
}
