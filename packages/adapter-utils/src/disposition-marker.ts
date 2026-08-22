// Shared tolerant PAPERCLIP_DISPOSITION extraction — single source of truth.
//
// 2026-08-22 (operator: end the disposition disease once and for all): SEVEN
// independent copies of a strict line-anchored single-line regex lived across
// the adapters, the acpx engine, and the process adapter. A one-week audit of
// "missing disposition" corrective runs found 233 real markers those regexes
// silently rejected — and fixing one copy (codex exec) left the other six
// paths, including the acpx engine that runs most ACP-mode lanes, discarding
// the same shapes. Every parse site now imports THIS extractor; new failure
// shapes get a fixture here and every path inherits the fix.

// 2026-08-22 tolerant rewrite (operator: end the disposition disease at source).
// The old line-anchored single-line regex silently rejected 233 real markers in
// one week — audited failure shapes from production final messages:
//   {"PAPERCLIP_DISPOSITION":{...}}          marker wrapped as a JSON key
//   prose**{"PAPERCLIP_DISPOSITION":{...}}   glued mid-line to preceding text
//   PAPERCLIP_DISPOSITION {"blocker":{...}}  nested objects / multi-line JSON
//   ..."blocker":{"owner":...}               blocker as an OBJECT, not a string
// Every rejected marker became a "missing disposition" corrective run. The
// extractor now finds the LAST marker anywhere in the text, scans a balanced
// JSON object (string/escape aware, capped), unwraps the wrapped form, and
// tolerates object blockers plus summary/reason fallbacks for blocked runs.
const PAPERCLIP_DISPOSITION_MARKER = "PAPERCLIP_DISPOSITION";
const MAX_DISPOSITION_JSON_CHARS = 4000;

export type ParsedDisposition = {
  status: string;
  hasBlocker: boolean;
  blocker?: string;
  reviewer?: string;
};

function scanBalancedJsonObject(text: string, openIndex: number): string | null {
  if (text[openIndex] !== "{") return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  const limit = Math.min(text.length, openIndex + MAX_DISPOSITION_JSON_CHARS);
  for (let i = openIndex; i < limit; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex, i + 1);
    }
  }
  return null;
}

function coerceBlockerText(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const parts = ["summary", "reason", "description", "owner", "action"]
      .map((key) => (typeof record[key] === "string" ? (record[key] as string).trim() : ""))
      .filter(Boolean);
    if (parts.length > 0) return parts.join(" — ");
    try {
      const serialized = JSON.stringify(value);
      return serialized && serialized !== "{}" ? serialized.slice(0, 500) : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function extractPaperclipDisposition(text: string): {
  disposition: ParsedDisposition | null;
  cleanedText: string;
} {
  let lastValid:
    | {
        disposition: ParsedDisposition;
        spanStart: number;
        spanEnd: number;
      }
    | null = null;

  let searchFrom = 0;
  while (true) {
    const markerIndex = text.indexOf(PAPERCLIP_DISPOSITION_MARKER, searchFrom);
    if (markerIndex === -1) break;
    searchFrom = markerIndex + PAPERCLIP_DISPOSITION_MARKER.length;

    // Find the JSON object that belongs to this marker: the next "{" within a
    // short window (tolerates `: `, ` `, `":` from the wrapped form, backticks).
    let braceIndex = -1;
    const windowEnd = Math.min(text.length, searchFrom + 12);
    for (let i = searchFrom; i < windowEnd; i += 1) {
      if (text[i] === "{") {
        braceIndex = i;
        break;
      }
    }
    if (braceIndex === -1) continue;

    const jsonText = scanBalancedJsonObject(text, braceIndex);
    if (!jsonText) continue;

    let parsed: Record<string, unknown> | null = null;
    try {
      const raw = JSON.parse(jsonText) as unknown;
      parsed = raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : null;
    } catch {
      continue;
    }
    if (!parsed) continue;

    // Wrapped form: the whole object may itself be {"PAPERCLIP_DISPOSITION": {...}}
    // — in that case the marker we matched was the KEY inside this object, and the
    // span starts at the outer opening brace (one char before the quoted key).
    let spanStart = markerIndex;
    const wrapped = parsed[PAPERCLIP_DISPOSITION_MARKER];
    if (wrapped && typeof wrapped === "object" && !Array.isArray(wrapped)) {
      parsed = wrapped as Record<string, unknown>;
    } else {
      const before = text.slice(Math.max(0, markerIndex - 2), markerIndex);
      if (before.endsWith('{"')) {
        // marker is the key of a wrapper object whose body failed to parse on its
        // own; re-scan from the wrapper's opening brace.
        const outer = scanBalancedJsonObject(text, markerIndex - 2);
        if (outer) {
          try {
            const outerParsed = JSON.parse(outer) as Record<string, unknown>;
            const inner = outerParsed[PAPERCLIP_DISPOSITION_MARKER];
            if (inner && typeof inner === "object" && !Array.isArray(inner)) {
              parsed = inner as Record<string, unknown>;
              spanStart = markerIndex - 2;
            }
          } catch {
            // keep the directly-parsed object
          }
        }
      }
    }

    const status = typeof parsed.status === "string" ? parsed.status.trim() : "";
    if (!status) continue;

    const blockerText = coerceBlockerText(parsed.blocker)
      ?? (status === "blocked"
        ? coerceBlockerText(parsed.summary) ?? coerceBlockerText(parsed.reason)
        : null);

    lastValid = {
      disposition: {
        status,
        // Named blocker text IS the affirmative identification (mirrors the
        // 2026-08-22 heartbeat-side fix); an explicit false still records false.
        hasBlocker: parsed.hasBlocker === true || Boolean(blockerText),
        ...(blockerText ? { blocker: blockerText } : {}),
        ...(typeof parsed.reviewer === "string" && parsed.reviewer.trim().length > 0
          ? { reviewer: parsed.reviewer.trim() }
          : {}),
      },
      spanStart,
      spanEnd: braceIndex + (scanBalancedJsonObject(text, braceIndex)?.length ?? 0),
    };
  }

  if (!lastValid) {
    // Bare-JSON fallback (inherited from the acpx engine, now shared): some
    // agents faithfully return a machine-readable final JSON object with an
    // explicit `disposition` field after an in-run Paperclip write fails, but
    // omit the marker. Only a WHOLE final JSON object qualifies — prose and
    // tool output cannot accidentally alter issue state.
    try {
      const parsed = JSON.parse(text.trim()) as Record<string, unknown> | null;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const rawDisposition = (parsed as Record<string, unknown>).disposition;
        const candidate = typeof rawDisposition === "string"
          ? { ...parsed, status: rawDisposition }
          : rawDisposition && typeof rawDisposition === "object" && !Array.isArray(rawDisposition)
            ? (rawDisposition as Record<string, unknown>)
            : null;
        const status = candidate && typeof candidate.status === "string" ? candidate.status.trim() : "";
        if (candidate && status) {
          const blockerText = coerceBlockerText(candidate.blocker)
            ?? (status === "blocked"
              ? coerceBlockerText(candidate.summary) ?? coerceBlockerText(candidate.reason)
                ?? coerceBlockerText((parsed as Record<string, unknown>).reason)
              : null);
          const summary = [`Reported disposition: ${status}.`, blockerText].filter(Boolean).join(" ");
          return {
            disposition: {
              status,
              hasBlocker: candidate.hasBlocker === true || Boolean(blockerText),
              ...(blockerText ? { blocker: blockerText } : {}),
              ...(typeof candidate.reviewer === "string" && candidate.reviewer.trim()
                ? { reviewer: candidate.reviewer.trim() }
                : {}),
            },
            cleanedText: summary,
          };
        }
      }
    } catch {
      // The marker path above remains the normal contract.
    }
    return { disposition: null, cleanedText: text.trim() };
  }

  const cleanedText = `${text.slice(0, lastValid.spanStart)}${text.slice(lastValid.spanEnd)}`
    .replace(/`+\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    disposition: lastValid.disposition,
    cleanedText,
  };
}
