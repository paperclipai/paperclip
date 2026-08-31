import { z } from "zod";

export function normalizeEscapedLineBreaks(value: string): string {
  return value
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n");
}

const FENCE_LINE = /^(\s{0,3})(```+|~~~+)(.*)$/;
// A mid-line ATX heading marker: 1–6 `#`, a space, then heading text. The
// capture keeps the char immediately before the run so we can tell a real
// (collapsed) heading from an inline `#` token like `C#`/`F#`.
const MID_LINE_HEADING = /([^\n#])(#{1,6})([ \t])/g;

/**
 * Heal a single line that carries an ATX heading marker mid-line. A plan/doc
 * body whose paragraph and heading newlines were collapsed to a single line
 * (a producer bug) renders as one giant heading with `##` markers
 * showing inline (e.g. "…plan pack)## The goal, restatedYou picked…"). Insert a
 * hard paragraph break before each such marker so the body self-heals into
 * headings + paragraphs.
 *
 * A lone `#` fused to an alphanumeric on its left (`C#`, `F#`, `A#`) is left
 * alone — that is an inline token, not a heading. Markers with 2–6 hashes are
 * always healed: `word## ` never occurs as legitimate inline prose.
 */
function healMidLineHeadings(line: string): string {
  return line.replace(MID_LINE_HEADING, (match, before: string, hashes: string, space: string) => {
    if (hashes.length === 1 && /[A-Za-z0-9]/.test(before)) return match;
    return `${before}\n\n${hashes}${space}`;
  });
}

/**
 * Defense-in-depth for the Plan pane: insert a paragraph break before
 * ATX heading markers that appear mid-line, so a malformed single-line markdown
 * body still renders as headings/paragraphs. Fenced code blocks are skipped so
 * inline `## ` comments inside code (YAML, shell, diffs) are never rewritten.
 */
export function normalizeMidLineHeadings(value: string): string {
  if (!value.includes("#")) return value;
  const lines = value.split("\n");
  let inFence = false;
  let fenceChar = "";
  let fenceLength = 0;
  const out: string[] = [];
  for (const line of lines) {
    const fenceMatch = FENCE_LINE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[2]!;
      if (!inFence) {
        inFence = true;
        fenceChar = marker[0]!;
        fenceLength = marker.length;
      } else if (
        marker[0] === fenceChar
        && marker.length >= fenceLength
        && fenceMatch[3]!.trim().length === 0
      ) {
        inFence = false;
        fenceChar = "";
        fenceLength = 0;
      }
      out.push(line);
      continue;
    }
    out.push(inFence ? line : healMidLineHeadings(line));
  }
  return out.join("\n");
}

export function normalizeMarkdownBody(value: string): string {
  return normalizeMidLineHeadings(normalizeEscapedLineBreaks(value));
}

export const multilineTextSchema = z.string().transform(normalizeEscapedLineBreaks);
