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

// Blockquote and list container markers that may precede a fence.
const CONTAINER_PREFIX = String.raw`(?: {0,3}(?:>|[-+*]|\d{1,9}[.)]) ?)*`;
const FENCE_OPEN_RE = new RegExp(String.raw`^${CONTAINER_PREFIX} {0,3}(\`{3,}|~{3,})`);
const FENCE_CLOSE_RE = new RegExp(String.raw`^${CONTAINER_PREFIX} {0,3}(\`{3,}|~{3,})[ \t]*$`);
const INTRAWORD_ESCAPED_RUN_RE = /(?<=[\p{L}\p{N}])((?:\\_)+)(?=[\p{L}\p{N}])/gu;

function unescapeProse(text: string): string {
  return text.replace(INTRAWORD_ESCAPED_RUN_RE, (run, _group, offset: number, whole: string) => {
    // `a\\_b` is an escaped backslash followed by a literal underscore: keep it.
    if (offset >= 2 && whole[offset - 1] === "\\" && whole[offset - 2] !== "\\") return run;
    return "_".repeat(run.length / 2);
  });
}

/** Unescape prose outside matched, unescaped inline code spans. */
function unescapeOutsideCodeSpans(line: string): string {
  let result = "";
  let index = 0;
  while (index < line.length) {
    const open = /(?<!\\)`+/g;
    open.lastIndex = index;
    const start = open.exec(line);
    if (!start) break;
    const close = new RegExp(String.raw`(?<!\`)${start[0]}(?!\`)`, "g");
    close.lastIndex = start.index + start[0].length;
    const end = close.exec(line);
    if (!end) {
      // An unmatched run is literal text; keep scanning after it.
      result += unescapeProse(line.slice(index, start.index + start[0].length));
      index = start.index + start[0].length;
      continue;
    }
    result += unescapeProse(line.slice(index, start.index)) + line.slice(start.index, end.index + end[0].length);
    index = end.index + end[0].length;
  }
  return result + unescapeProse(line.slice(index));
}

export function unescapeIntrawordUnderscores(markdown: string): string {
  if (!markdown.includes("\\_")) return markdown;
  let fence: string | null = null;
  return markdown.split("\n").map((line) => {
    if (fence !== null) {
      const close = FENCE_CLOSE_RE.exec(line)?.[1];
      if (close && close[0] === fence[0] && close.length >= fence.length) fence = null;
      return line;
    }
    const open = FENCE_OPEN_RE.exec(line)?.[1];
    if (open) {
      fence = open;
      return line;
    }
    return unescapeOutsideCodeSpans(line);
  }).join("\n");
}
