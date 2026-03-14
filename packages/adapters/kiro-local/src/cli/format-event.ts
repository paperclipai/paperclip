import pc from "picocolors";

const CREDIT_RE = /(\d+(?:\.\d+)?)\s*credits?\s*used/i;
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(?:\x07|\x1b\\)|\x1b\[[\?]?\d*[a-zA-Z]/g;

/**
 * Kiro CLI outputs plain text. Print each line, highlighting credit usage.
 */
export function printKiroStreamEvent(raw: string, _debug: boolean): void {
  const line = raw.replace(ANSI_RE, "").trim();
  if (!line) return;

  if (CREDIT_RE.test(line)) {
    console.log(pc.blue(line));
    return;
  }

  console.log(line);
}
