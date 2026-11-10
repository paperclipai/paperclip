import { fromMarkdown } from "mdast-util-from-markdown";

/**
 * MDXEditor (via `mdast-util-to-markdown`) exports every literal `_` as `\_`,
 * including underscores inside a word such as `snake_case` or `E2E_ASK_12`.
 * CommonMark never treats an intraword underscore as emphasis, so that escape
 * is pure transport noise. Stored task text feeds agent prompts, and agents then
 * see (and repeat) backslashes the person never typed.
 *
 * This helper removes the escape only from a run of escaped underscores that
 * sits between two letters or digits (`snake\_case`, `foo\_\_bar`), which cannot
 * change how the markdown renders. It parses the markdown so that code spans and
 * fenced or indented code blocks at any container depth, and raw HTML, stay
 * byte-identical. Run it on the editor's exact export, before any other
 * transport-escape removal changes how that text parses.
 * Word-boundary escapes (`\_emphasis\_`, `\_\_init\_\_`, which would otherwise
 * render as emphasis) and escaped backslashes (`\\_`) are left unchanged.
 */

const INTRAWORD_ESCAPED_RUN_RE = /(?<=[\p{L}\p{N}])((?:\\_)+)(?=[\p{L}\p{N}])/gu;

interface PositionedNode {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: PositionedNode[];
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

/** Source ranges of code spans and code blocks, in document order. */
function codeRanges(node: PositionedNode, ranges: Array<[number, number]>): Array<[number, number]> {
  // Raw HTML does not process backslash escapes, so a `\_` there is literal too.
  if (node.type === "code" || node.type === "inlineCode" || node.type === "html") {
    const start = node.position?.start.offset, end = node.position?.end.offset;
    if (typeof start === "number" && typeof end === "number") ranges.push([start, end]);
    return ranges;
  }
  for (const child of node.children ?? []) codeRanges(child, ranges);
  return ranges;
}

export function unescapeIntrawordUnderscores(markdown: string): string {
  if (!markdown.includes("\\_")) return markdown;
  let ranges: Array<[number, number]>;
  try {
    ranges = codeRanges(fromMarkdown(markdown) as PositionedNode, []);
  } catch {
    // Never rewrite text the parser could not place.
    return markdown;
  }
  let result = "";
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start < cursor) continue;
    result += unescapeProse(markdown.slice(cursor, start)) + markdown.slice(start, end);
    cursor = end;
  }
  return result + unescapeProse(markdown.slice(cursor));
}
