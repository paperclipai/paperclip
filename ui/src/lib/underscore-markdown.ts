/**
 * MDXEditor (via `mdast-util-to-markdown`) exports every literal `_` as `\_`,
 * including underscores inside a word such as `snake_case` or `E2E_ASK_12`.
 * CommonMark never treats an intraword underscore as emphasis, so that escape
 * is pure transport noise. Stored task text feeds agent prompts, and agents then
 * see (and repeat) backslashes the person never typed.
 *
 * This helper removes the escape only from a run of escaped underscores that
 * sits between two letters or digits (`snake\_case`, `foo\_\_bar`), which cannot
 * change how the markdown renders. It leaves word-boundary escapes unchanged
 * (`\_emphasis\_`, `\_\_init\_\_`, which would otherwise render as emphasis),
 * as well as escaped backslashes (`\\_`), inline code spans and fenced code
 * blocks, including fences nested in blockquotes or lists.
 */

const BLOCKQUOTE_MARKER_RE = /^ {0,3}> ?/;
const LIST_MARKER_RE = /^ {0,3}(?:[-+*]|\d{1,9}[.)]) +/;
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE_RE = /^ *(`{3,}|~{3,})[ \t]*$/;
const INTRAWORD_ESCAPED_RUN_RE = /(?<=[\p{L}\p{N}])((?:\\_)+)(?=[\p{L}\p{N}])/gu;

/** Strip blockquote markers; return their count and the remaining text. */
function stripBlockquotes(line: string): { depth: number; rest: string } {
  let depth = 0;
  let rest = line;
  for (let marker = BLOCKQUOTE_MARKER_RE.exec(rest); marker; marker = BLOCKQUOTE_MARKER_RE.exec(rest)) {
    depth += 1;
    rest = rest.slice(marker[0].length);
  }
  return { depth, rest };
}

/** True when the character at `index` is escaped by an odd number of backslashes. */
function isEscaped(text: string, index: number): boolean {
  let count = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) count += 1;
  return count % 2 === 1;
}

function unescapeProse(text: string): string {
  return text.replace(INTRAWORD_ESCAPED_RUN_RE, (run: string, _group: string, offset: number, whole: string) =>
    // `a\\_b` is an escaped backslash followed by a literal underscore: keep it.
    isEscaped(whole, offset) ? run : "_".repeat(run.length / 2));
}

/** Unescape prose outside matched, unescaped inline code spans. */
function unescapeOutsideCodeSpans(line: string): string {
  let result = "";
  let index = 0;
  let scan = 0;
  while (scan < line.length) {
    const opener = /`+/g;
    opener.lastIndex = scan;
    const start = opener.exec(line);
    if (!start) break;
    if (isEscaped(line, start.index)) {
      // `\`` is a literal backtick; one escaped backtick also shortens the run.
      scan = start.index + 1;
      continue;
    }
    const closer = new RegExp(String.raw`(?<!\`)${start[0]}(?!\`)`, "g");
    closer.lastIndex = start.index + start[0].length;
    const end = closer.exec(line);
    if (!end) {
      // An unmatched run is literal text; keep scanning after it.
      scan = start.index + start[0].length;
      continue;
    }
    result += unescapeProse(line.slice(index, start.index)) + line.slice(start.index, end.index + end[0].length);
    index = end.index + end[0].length;
    scan = index;
  }
  return result + unescapeProse(line.slice(index));
}

export function unescapeIntrawordUnderscores(markdown: string): string {
  if (!markdown.includes("\\_")) return markdown;
  let fence: { run: string; depth: number } | null = null;
  return markdown.split("\n").map((line) => {
    const { depth, rest } = stripBlockquotes(line);
    if (fence !== null) {
      // A fence ends at a matching closing fence in the same container, or when
      // its enclosing blockquote ends. Deeper quote markers are code content.
      if (depth === fence.depth) {
        const close = FENCE_CLOSE_RE.exec(rest)?.[1];
        if (close && close[0] === fence.run[0] && close.length >= fence.run.length) fence = null;
        return line;
      }
      if (depth > fence.depth) return line;
      fence = null;
    }
    const content = rest.replace(LIST_MARKER_RE, "");
    const open = FENCE_OPEN_RE.exec(content)?.[1];
    if (open) {
      fence = { run: open, depth };
      return line;
    }
    return unescapeOutsideCodeSpans(line);
  }).join("\n");
}
