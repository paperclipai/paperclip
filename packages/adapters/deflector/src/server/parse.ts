export function parseDeflectorStdout(stdout: string): {
  matched: boolean | null;
  patternId: string | null;
  summary: string;
} {
  const text = stdout ?? "";
  const resolved = /Deflector: resolved via ([a-z0-9_]+)/i.exec(text);
  if (resolved) {
    return { matched: true, patternId: resolved[1] ?? null, summary: resolved[0] };
  }
  if (/no high-confidence pattern matched/i.test(text) || /pass-through/i.test(text)) {
    return { matched: false, patternId: null, summary: "no match" };
  }
  return { matched: null, patternId: null, summary: text.trim().slice(0, 200) };
}
