/**
 * Best-effort parsing of Kiro CLI plain-text stdout.
 * Kiro CLI outputs plain text in --no-interactive mode.
 * We attempt to extract credit usage from inline output.
 */

const CREDIT_USAGE_RE = /(\d+(?:\.\d+)?)\s*credits?\s*used/i;
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(?:\x07|\x1b\\)|\x1b\[[\?]?\d*[a-zA-Z]/g;

export interface ParsedKiroOutput {
  summary: string;
  creditsUsed: number;
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

export function parseKiroOutput(stdout: string): ParsedKiroOutput {
  const clean = stripAnsi(stdout);
  const lines = clean.split(/\r?\n/);
  let creditsUsed = 0;

  for (const line of lines) {
    const match = CREDIT_USAGE_RE.exec(line);
    if (match) {
      creditsUsed += Number.parseFloat(match[1]) || 0;
    }
  }

  const summary = clean.trim();

  return { summary, creditsUsed };
}
