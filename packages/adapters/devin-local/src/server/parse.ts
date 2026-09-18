// Output parsing for the Devin CLI print lane (`devin -p`).
//
// Devin's print mode streams the agent's final response to stdout as plain
// markdown text (there is no stdout JSON event stream), so parsing here is
// intentionally lightweight: we (1) detect stale/unknown-session errors so the
// executor can retry with a fresh session, (2) detect a small set of terminal
// failure phrases for a useful errorMessage, and (3) expose helpers the UI
// parser reuses to classify adapter/system noise vs. the agent's answer.
//
// Treat all output as untrusted (it comes from an LLM-driven process): only
// pattern-match, never act on paths/commands found in the text.

import { stripAnsi } from '../ansi.js';

/** Lines the adapter itself emits via onLog — not agent output. */
const ADAPTER_LINE_RE = /^\s*\[(adapter|paperclip)\]/i;

const UNKNOWN_SESSION_RE =
  /(unknown|invalid|stale)\s+session|session\s+(?:id\s+)?(?:not\s+found|does\s+not\s+exist|is\s+invalid|expired)|no\s+(?:such\s+)?session|could\s+not\s+(?:find|resume)\s+session|resume\s+failed/i;

const FAILURE_RE =
  /(?:^|\b)(error|fatal|panic|unauthorized|not\s+authenticated|authentication\s+failed|permission\s+denied|rate[-\s]?limit(?:ed)?|quota\s+exceeded|usage\s+limit)\b/i;

function joinStreams(stdout: string, stderr: string): string {
  return `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => stripAnsi(line).trim())
    .filter(Boolean)
    .join('\n');
}

/**
 * True when a `-r <sessionId>` resume failed because the session is unknown or
 * stale. The executor retries once with a fresh session and returns
 * `clearSession: true` so Paperclip drops the dead session params.
 */
export function isDevinUnknownSessionError(
  stdout: string,
  stderr = '',
): boolean {
  // Match stderr only: stdout on this adapter IS the agent's answer, and the
  // answer text must never trigger a full re-run (double cost, duplicated side
  // effects). Verified: the CLI writes "No session found matching '<id>'" to
  // stderr (live probe, 2026-09-03).
  void stdout;
  return UNKNOWN_SESSION_RE.test(stderr);
}

/**
 * Best-effort one-line failure description pulled from stderr first, then any
 * non-adapter stdout line matching a known failure phrase. Returns null when no
 * failure signal is present.
 */
export function describeDevinFailure(
  stdout: string,
  stderr = '',
): string | null {
  const stderrLine = stderr
    .split(/\r?\n/)
    .map((l) => stripAnsi(l).trim())
    .find(Boolean);
  if (stderrLine && FAILURE_RE.test(stderrLine)) return truncate(stderrLine);
  const stdoutLine = stdout
    .split(/\r?\n/)
    .map((l) => stripAnsi(l).trim())
    .filter((l) => l && !ADAPTER_LINE_RE.test(l))
    .find((l) => FAILURE_RE.test(l));
  return stdoutLine ? truncate(stdoutLine) : null;
}

/**
 * The agent's answer with adapter/system noise stripped. This is what we post
 * as the issue comment and surface as the run `summary`.
 */
export function extractDevinAnswer(stdout: string): string {
  return stdout
    .split(/\r?\n/)
    .map((line) => stripAnsi(line))
    .filter((line) => !ADAPTER_LINE_RE.test(line.trim()))
    .join('\n')
    .trim();
}

function truncate(value: string, max = 240): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
