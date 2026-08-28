// Aider writes a human transcript to stdout, not structured events. Everything
// below is best-effort scraping of that transcript: treat adapter output as
// untrusted and never let a missing marker fail the run.

import { stripAnsi } from "../ui/parse-stdout.js";

export { stripAnsi };

export interface ParsedAiderOutput {
  summary: string;
  errorMessage: string | null;
  inputTokens: number;
  outputTokens: number;
  messageCostUsd: number | null;
  sessionCostUsd: number | null;
  editedFiles: string[];
  commits: string[];
}

const TOKENS_RE = /Tokens:\s*([\d.,]+\s*[kKmM]?)\s*sent,\s*([\d.,]+\s*[kKmM]?)\s*received/;
const COST_RE = /Cost:\s*\$([\d.]+)\s*message,\s*\$([\d.]+)\s*session/;
const APPLIED_EDIT_RE = /^Applied edit to\s+(.+?)\s*$/;
const COMMIT_RE = /^Commit\s+([0-9a-f]{7,40})\s+(.*)$/i;

/**
 * Status/banner lines Aider prints around the model's own reply. They stay in
 * the raw transcript but are excluded from `summary`, which feeds the run
 * digest.
 */
const NOISE_PREFIXES = [
  "aider v",
  "added ",
  "applied edit to ",
  "cost:",
  "creating empty file",
  "editor model:",
  "git repo:",
  "main model:",
  "model:",
  "models:",
  "no files matched",
  "repo-map:",
  "scanning repo",
  "tokens:",
  "use /help",
  "weak model:",
];

const ERROR_PATTERNS: RegExp[] = [
  /^Traceback \(most recent call last\)/,
  /litellm\.[A-Za-z]*(?:Error|Exception)/,
  /\b(?:Authentication|Permission|BadRequest|NotFound|APIConnection)Error\b/,
  /^(?:Error|Fatal error|Usage error):\s*\S/i,
  /\bno such option\b/i,
  /\bunrecognized arguments\b/i,
  /\bcommand not found\b/i,
];

const QUOTA_PATTERNS: RegExp[] = [
  /\brate.?limit/i,
  /\bquota\b/i,
  /\binsufficient_quota\b/i,
  /\b429\b/,
  /RateLimitError/,
];

export function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

/** "3.4k" -> 3400, "1.2M" -> 1200000, "156" -> 156. */
export function parseTokenCount(raw: string): number {
  const cleaned = raw.replace(/[,\s]/g, "");
  const match = /^([\d.]+)([kKmM]?)$/.exec(cleaned);
  if (!match?.[1]) return 0;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) return 0;
  const unit = match[2]?.toLowerCase() ?? "";
  const multiplier = unit === "k" ? 1_000 : unit === "m" ? 1_000_000 : 1;
  return Math.round(value * multiplier);
}

function isNoiseLine(line: string): boolean {
  const lower = line.toLowerCase();
  if (NOISE_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true;
  if (/^[-=_]{3,}$/.test(line)) return true;
  if (COMMIT_RE.test(line)) return true;
  return false;
}

export function parseAiderOutput(stdout: string, stderr = ""): ParsedAiderOutput {
  const clean = stripAnsi(stdout);
  const lines = clean.split(/\r?\n/);

  let inputTokens = 0;
  let outputTokens = 0;
  let messageCostUsd: number | null = null;
  let sessionCostUsd: number | null = null;
  const editedFiles: string[] = [];
  const commits: string[] = [];
  const summaryParts: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    const tokensMatch = TOKENS_RE.exec(trimmed);
    if (tokensMatch?.[1] && tokensMatch[2]) {
      inputTokens = parseTokenCount(tokensMatch[1]);
      outputTokens = parseTokenCount(tokensMatch[2]);
    }

    const costMatch = COST_RE.exec(trimmed);
    if (costMatch?.[1] && costMatch[2]) {
      const message = Number.parseFloat(costMatch[1]);
      const session = Number.parseFloat(costMatch[2]);
      if (Number.isFinite(message)) messageCostUsd = message;
      if (Number.isFinite(session)) sessionCostUsd = session;
    }

    const editMatch = APPLIED_EDIT_RE.exec(trimmed);
    if (editMatch?.[1]) editedFiles.push(editMatch[1]);

    const commitMatch = COMMIT_RE.exec(trimmed);
    if (commitMatch?.[1]) {
      commits.push(`${commitMatch[1]} ${commitMatch[2] ?? ""}`.trim());
    }

    if (!isNoiseLine(trimmed)) summaryParts.push(line);
  }

  const haystack = `${clean}\n${stripAnsi(stderr)}`;

  return {
    summary: summaryParts.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
    errorMessage: findErrorMessage(haystack),
    inputTokens,
    outputTokens,
    messageCostUsd,
    sessionCostUsd,
    editedFiles: Array.from(new Set(editedFiles)),
    commits,
  };
}

function findErrorMessage(haystack: string): string | null {
  for (const line of haystack.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (ERROR_PATTERNS.some((pattern) => pattern.test(trimmed))) {
      return trimmed.length > 400 ? `${trimmed.slice(0, 397)}...` : trimmed;
    }
  }
  return null;
}

export function isAiderQuotaError(stdout: string, stderr: string): boolean {
  const haystack = `${stripAnsi(stdout)}\n${stripAnsi(stderr)}`;
  return QUOTA_PATTERNS.some((pattern) => pattern.test(haystack));
}
