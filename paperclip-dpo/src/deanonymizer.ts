import type { MappingEntry } from "./types.js";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function deanonymizeText(text: string, mappings: MappingEntry[]): string {
  const sorted = [...mappings].sort((a, b) => b.pseudonym.length - a.pseudonym.length);
  let out = text;
  for (const m of sorted) {
    out = out.replace(new RegExp(escapeRegex(m.pseudonym), "g"), m.plaintext);
  }
  return out;
}
