import { z } from "zod";

const BACKSLASH = "\\";

/**
 * Rewrites the literal two-character sequences `\n`, `\r` and `\r\n` into real
 * line breaks, so prose that was assembled by string concatenation somewhere
 * upstream still renders as the author meant it.
 *
 * Only a *dangling* escape backslash is interpreted. `\\n` is an escaped
 * backslash followed by the letter n, not a line break, and is left alone — a
 * blind substring replace corrupts Windows paths, regexes and JSON bodies that
 * were correctly escaped in the first place.
 *
 * Implemented as a single left-to-right scan rather than a parity-aware regex:
 * a regex has to backtrack over each run of backslashes, which is quadratic on
 * the pathological input a 512 KiB document body can carry.
 */
export function normalizeEscapedLineBreaks(value: string): string {
  if (!value.includes(BACKSLASH)) return value;

  let result = "";
  let index = 0;

  while (index < value.length) {
    if (value[index] !== BACKSLASH) {
      result += value[index];
      index += 1;
      continue;
    }

    // Consume the whole run of backslashes at once. Each pair is an escaped
    // backslash and passes through untouched; a leftover one may be an escape.
    let run = 0;
    while (value[index + run] === BACKSLASH) run += 1;
    const paired = run - (run % 2);
    result += BACKSLASH.repeat(paired);
    index += paired;
    if (run === paired) continue;

    if (value[index + 1] === "n") {
      result += "\n";
      index += 2;
      continue;
    }

    if (value[index + 1] === "r") {
      index += 2;
      // Collapse an escaped CRLF to a single line break.
      if (value[index] === BACKSLASH && value[index + 1] === "n") index += 2;
      result += "\n";
      continue;
    }

    // Escapes we have no opinion about (\t, \", …) stay as they are.
    result += BACKSLASH;
    index += 1;
  }

  return result;
}

export const multilineTextSchema = z.string().transform(normalizeEscapedLineBreaks);
