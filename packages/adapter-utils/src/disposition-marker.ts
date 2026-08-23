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

// The statuses the platform's own contracts offer: the four terminal choices in
// the disposition contract, plus the "continuing" the acpx/hermes re-ask prompts
// invite. 2026-08-23: the 2026-08-22 shared-extractor rewrite dropped the
// per-adapter allowlists and accepted ANY non-empty status string, so free-text
// values ("in_progress", "todo") were recorded as dispositions the heartbeat
// then had no rule for — and the antigravity suite's "rejects malformed or
// unsupported disposition prose" case had been red on the live branch ever
// since. Anything outside this set is not a disposition.
const DISPOSITION_STATUSES = new Set([
  "done",
  "cancelled",
  "in_review",
  "blocked",
  "continuing",
]);

const BARE_STATUS_VALUES = new Set(["done", "cancelled", "in_review", "blocked"]);

// Reads `": "done"` / `: "done"` / ` "done"` immediately after the marker and
// returns the span to strip (including the enclosing `{"MARKER": "done"}`
// wrapper when there is one) so the human-facing summary stays clean.
function readBareStatusValue(
  text: string,
  searchFrom: number,
): { status: string; spanEnd: number; wrapperStart: number | null } | null {
  const window = text.slice(searchFrom, Math.min(text.length, searchFrom + 40));
  const match = /^["`]?\s*:\s*["`]?\s*"([a-z_]+)"/.exec(window)
    ?? /^["`]?\s*:\s*([a-z_]+)\b/.exec(window);
  if (!match) return null;
  const status = match[1].trim().toLowerCase();
  if (!BARE_STATUS_VALUES.has(status)) return null;
  let spanEnd = searchFrom + match[0].length;
  let wrapperStart: number | null = null;
  // `{"PAPERCLIP_DISPOSITION": "done"}` — swallow the wrapper braces too.
  const markerIndex = searchFrom - PAPERCLIP_DISPOSITION_MARKER.length;
  if (text.slice(Math.max(0, markerIndex - 2), markerIndex).endsWith('{"')) {
    const close = text.indexOf("}", spanEnd);
    if (close !== -1 && close - spanEnd <= 4) {
      wrapperStart = markerIndex - 2;
      spanEnd = close + 1;
    }
  }
  return { status, spanEnd, wrapperStart };
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
    if (braceIndex === -1) {
      // 2026-08-23: gemini/antigravity states the marker with a BARE STRING
      // value — `{"PAPERCLIP_DISPOSITION": "done"}` or `PAPERCLIP_DISPOSITION:
      // "done"` — so there is no object to scan and the marker was discarded.
      // Accept the string form, but ONLY for an exact known status, so prose
      // that merely names the marker can never move issue state.
      const bare = readBareStatusValue(text, searchFrom);
      if (!bare) continue;
      lastValid = {
        disposition: { status: bare.status, hasBlocker: false },
        spanStart: bare.wrapperStart ?? markerIndex,
        spanEnd: bare.spanEnd,
      };
      continue;
    }

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

    const status = typeof parsed.status === "string" ? parsed.status.trim().toLowerCase() : "";
    if (!DISPOSITION_STATUSES.has(status)) continue;

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
        const status = candidate && typeof candidate.status === "string"
          ? candidate.status.trim().toLowerCase()
          : "";
        if (candidate && DISPOSITION_STATUSES.has(status)) {
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

// --- PAPERCLIP_DELEGATION (2026-08-22) -------------------------------------
// Root cause of the recurring "C-level delegation goes nowhere" disease:
// confined ACP lanes (all codex C-levels) have NO control-plane write door —
// zero issues created by any codex lane in 7 days against ~1,500 C-level
// runs/day of routing narration. The Delegation Receipt Law demanded a child
// card they were physically unable to create. This marker is their door,
// mirrored on the PAPERCLIP_DISPOSITION contract: state the delegation in the
// final message; the platform creates the child, assigns it, wakes the
// assignee, and posts the receipt on the parent.
export type ParsedDelegation = {
  title: string;
  description?: string;
  assignee?: string;
  priority?: string;
};

export const MAX_DELEGATIONS_PER_RUN = 3;
const DELEGATION_MARKER = "PAPERCLIP_DELEGATION";

export function extractPaperclipDelegations(text: string): ParsedDelegation[] {
  const out: ParsedDelegation[] = [];
  let searchFrom = 0;
  while (out.length < MAX_DELEGATIONS_PER_RUN) {
    const markerIndex = text.indexOf(DELEGATION_MARKER, searchFrom);
    if (markerIndex === -1) break;
    searchFrom = markerIndex + DELEGATION_MARKER.length;

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
    const wrapped = parsed[DELEGATION_MARKER];
    if (wrapped && typeof wrapped === "object" && !Array.isArray(wrapped)) {
      parsed = wrapped as Record<string, unknown>;
    }
    const title = typeof parsed.title === "string" ? parsed.title.trim().slice(0, 200) : "";
    if (!title) continue;
    out.push({
      title,
      ...(typeof parsed.description === "string" && parsed.description.trim()
        ? { description: parsed.description.trim().slice(0, 4000) }
        : {}),
      ...(typeof parsed.assignee === "string" && parsed.assignee.trim()
        ? { assignee: parsed.assignee.trim() }
        : {}),
      ...(typeof parsed.priority === "string" && parsed.priority.trim()
        ? { priority: parsed.priority.trim().toLowerCase() }
        : {}),
    });
  }
  return out;
}
