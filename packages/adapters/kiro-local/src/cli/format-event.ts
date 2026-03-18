import pc from "picocolors";
import { stripAnsi } from "../server/parse.js";

const CREDIT_RE = /(\d+(?:\.\d+)?)\s*credits?\s*used/i;

/**
 * Kiro CLI outputs plain text. Print each line, highlighting credit usage.
 */
export function printKiroStreamEvent(raw: string, _debug: boolean): void {
  const line = stripAnsi(raw).trim();
  if (!line) return;

  if (CREDIT_RE.test(line)) {
    console.log(pc.blue(line));
    return;
  }

  console.log(line);
}
