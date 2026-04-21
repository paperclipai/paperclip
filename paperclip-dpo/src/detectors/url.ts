import type { Finding } from "../types.js";

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/g;

export function detectUrls(text: string): Finding[] {
  const findings: Finding[] = [];
  for (const m of text.matchAll(URL_RE)) {
    findings.push({
      type: "URL",
      value: m[0],
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
      confidence: "high",
      source: "regex",
    });
  }
  return findings;
}
