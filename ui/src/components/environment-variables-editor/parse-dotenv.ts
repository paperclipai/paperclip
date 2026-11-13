/**
 * Minimal `.env`-style parser for bulk-pasting environment variables into the
 * editor (plan §6.9). Deliberately forgiving: it ignores comments and blank
 * lines, tolerates a leading `export `, strips one layer of matching quotes,
 * and returns key/value pairs in source order. It is NOT a full dotenv
 * implementation (no variable interpolation, no multi-line values).
 */
export interface ParsedEnvPair {
  key: string;
  value: string;
}

/** A KEY at the start of a line, optionally prefixed with `export `. */
const LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

function stripInlineComment(value: string): string {
  // Only strip a ` #comment` when the value is unquoted. Quoted values are
  // handled by the caller before this runs, so here we only see bare values.
  const hashIndex = value.indexOf(" #");
  if (hashIndex >= 0) return value.slice(0, hashIndex);
  return value;
}

function unquote(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return stripInlineComment(trimmed).trim();
}

/**
 * Returns the parsed pairs, or an empty array when nothing looks like an env
 * assignment. Callers can treat an empty result as "not a dotenv paste" and
 * fall through to the browser's default paste handling.
 */
export function parseDotenv(text: string): ParsedEnvPair[] {
  const pairs: ParsedEnvPair[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = LINE_RE.exec(line);
    if (!match) continue;
    const key = match[1];
    const value = unquote(match[2]);
    pairs.push({ key, value });
  }
  return pairs;
}

/**
 * Heuristic: does a paste look like a `.env` block worth importing? We require
 * either more than one parsed pair, or a single pair that spans a genuine
 * `KEY=VALUE` (so a lone `FOO=bar` typed into an empty name still imports, but
 * pasting a bare token like `ghp_xxx` does not hijack the field).
 */
export function looksLikeDotenv(text: string): boolean {
  if (!text.includes("=")) return false;
  return parseDotenv(text).length > 0;
}
