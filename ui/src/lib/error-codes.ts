/**
 * ValAdrien OS internal error taxonomy.
 *
 * Goal: every error the operator sees carries a code that instantly identifies the
 * issue (open a ticket / hand to the eng-overseer). App-specific failures that do NOT
 * already carry a universal code get a numbered **VOS-xxxx** code here. Errors that
 * ALREADY have a universal code (HTTP status, Postgres SQLSTATE) are passed through
 * as-is — those are self-identifying, so we don't remap them.
 *
 * VOS ranges:
 *   1xxx — infrastructure / connectivity (DB, adapters, runtime)
 *   2xxx — auth / access
 *   3xxx — bootstrap / configuration
 *   9xxx — uncategorized (assign a real code when it recurs)
 *
 * Add a row to APP_ERRORS the moment a new app error surfaces, so it stops being 9000.
 */

export interface ResolvedError {
  /** "VOS-1001" for app errors, or a universal code like "HTTP 503" / "SQLSTATE XX000". */
  code: string;
  /** Short human label. */
  title: string;
  /** Raw message / extra context (shown small under the title). */
  detail?: string;
  /** true = the code is a native/universal code passed through unchanged. */
  universal: boolean;
}

/** App-specific error keys (substring-matched against the error message) → VOS code. */
const APP_ERRORS: Array<{ match: RegExp; code: string; title: string }> = [
  { match: /database_unreachable/i, code: "VOS-1001", title: "Database unreachable" },
  { match: /adapter_failed/i, code: "VOS-1002", title: "Agent adapter failed to start" },
  { match: /process_lost/i, code: "VOS-1003", title: "Run process was lost" },
  { match: /EMAXCONN(SESSION)?/i, code: "VOS-1004", title: "Database connection pool exhausted" },
  { match: /no_board_access|no company access/i, code: "VOS-2001", title: "No company access" },
  { match: /bootstrap_pending|instance setup required/i, code: "VOS-3001", title: "Instance setup required" },
];

const UNKNOWN: Omit<ResolvedError, "detail"> = {
  code: "VOS-9000",
  title: "Unexpected error",
  universal: false,
};

function messageOf(err: unknown): string {
  if (err == null) return "";
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  if (typeof err === "object") {
    const o = err as Record<string, unknown>;
    const body = (o.body ?? o.data) as Record<string, unknown> | undefined;
    // Common API/error shapes: {message}, {error}, {body:{error|message}}.
    const cand = o.message ?? o.error ?? body?.error ?? body?.message;
    if (typeof cand === "string" && cand) return cand;
    // Never surface a bare "[object Object]" — fall back to the JSON shape.
    try {
      const j = JSON.stringify(err);
      if (j && j !== "{}") return j;
    } catch {
      /* unserializable — fall through */
    }
  }
  return String(err ?? "");
}

function httpTitle(status: string): string {
  const map: Record<string, string> = {
    "400": "Bad request",
    "401": "Not signed in",
    "403": "Forbidden",
    "404": "Not found",
    "408": "Request timeout",
    "429": "Rate limited",
    "500": "Server error",
    "502": "Bad gateway",
    "503": "Service unavailable",
    "504": "Gateway timeout",
  };
  return map[status] ?? `HTTP ${status}`;
}

export function resolveError(err: unknown): ResolvedError {
  const msg = messageOf(err).trim();

  // 1) Known app error → VOS code.
  for (const entry of APP_ERRORS) {
    if (entry.match.test(msg)) {
      const isExactKey = /^[a-z_]+$/i.test(msg) && entry.match.test(msg);
      return { code: entry.code, title: entry.title, detail: isExactKey ? undefined : msg || undefined, universal: false };
    }
  }

  // 2) Universal HTTP status (e.g. "Request failed with status 503", "HTTP 500", "status: 404").
  const http = msg.match(/\b(?:http\s*|status\s*(?:code)?\s*[:=]?\s*)?((?:4|5)\d\d)\b/i);
  if (http) {
    return { code: `HTTP ${http[1]}`, title: httpTitle(http[1]), detail: msg, universal: true };
  }

  // 3) Universal Postgres SQLSTATE (explicit), e.g. "SQLSTATE XX000".
  const pg = msg.match(/SQLSTATE[:\s]*([0-9A-Z]{5})/i);
  if (pg) {
    return { code: `SQLSTATE ${pg[1].toUpperCase()}`, title: "Database error", detail: msg, universal: true };
  }

  // 4) Uncategorized — surfaces as VOS-9000 with the raw message; promote to a real
  //    VOS code in APP_ERRORS once we see it recur.
  return { ...UNKNOWN, detail: msg || undefined };
}
