import type { Finding } from "../types.js";

// BIC braucht einen vorangestellten Label-Marker, sonst sind ALL-CAPS-Acronyme
// (z.B. "WHITESTAGAI") ununterscheidbar von echten BICs.
// Label kann sein: BIC, SWIFT, SWIFT-BIC, optional gefolgt von ":" oder "-Code:".
const BIC_RE =
  /\b(?:BIC|SWIFT(?:-BIC)?|SWIFT-Code)\s*[:\-]?\s*([A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?)\b/g;

export function detectBics(text: string): Finding[] {
  const findings: Finding[] = [];
  for (const m of text.matchAll(BIC_RE)) {
    const value = m[1];
    const bicStart = (m.index ?? 0) + m[0].lastIndexOf(value);
    findings.push({
      type: "BIC",
      value,
      start: bicStart,
      end: bicStart + value.length,
      confidence: "high",
      source: "regex",
    });
  }
  return findings;
}
