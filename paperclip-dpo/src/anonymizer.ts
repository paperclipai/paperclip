import type { Finding, FindingType, MappingEntry } from "./types.js";

export interface AnonymizeOutput {
  text: string;
  mappings: MappingEntry[];
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function nextLabel(index: number): string {
  let n = index;
  let out = "";
  do {
    out = LETTERS[n % 26] + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

export function anonymizeText(text: string, findings: Finding[]): AnonymizeOutput {
  const counters = new Map<FindingType, number>();
  const valueToPseudonym = new Map<string, string>();
  const mappings: MappingEntry[] = [];

  for (const f of findings) {
    const key = `${f.type}::${f.value}`;
    if (!valueToPseudonym.has(key)) {
      const idx = counters.get(f.type) ?? 0;
      const pseudonym = `[${f.type}_${nextLabel(idx)}]`;
      counters.set(f.type, idx + 1);
      valueToPseudonym.set(key, pseudonym);
      mappings.push({ pseudonym, plaintext: f.value, type: f.type });
    }
  }

  const sorted = [...findings].sort((a, b) => b.start - a.start);
  let out = text;
  for (const f of sorted) {
    const key = `${f.type}::${f.value}`;
    const pseudo = valueToPseudonym.get(key)!;
    out = out.slice(0, f.start) + pseudo + out.slice(f.end);
  }

  return { text: out, mappings };
}
