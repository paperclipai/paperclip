/**
 * MDXEditor (via `mdast-util-to-markdown`) exports every literal `_` as `\_`,
 * including underscores inside a word such as `snake_case` or `E2E_ASK_12`.
 * CommonMark never treats an intraword underscore as emphasis, so that escape
 * is pure transport noise. Stored task text feeds agent prompts, and agents then
 * see (and repeat) backslashes the person never typed.
 *
 * This helper removes the escape only where the underscore sits between two
 * letters or digits, which cannot change how the markdown renders. It leaves
 * word-boundary escapes (`\_emphasis\_`), escaped backslashes (`\\_`), inline
 * code spans and fenced code blocks unchanged.
 */

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const INTRAWORD_ESCAPED_UNDERSCORE_RE = /(?<=[\p{L}\p{N}])(?<!\\\\)\\_(?=[\p{L}\p{N}])/gu;

function unescapeOutsideCodeSpans(line: string): string {
  // Split on backtick runs; odd segments between matching runs are code spans.
  const parts = line.split(/(`+)/);
  let open: string | null = null;
  return parts.map((part) => {
    if (/^`+$/.test(part)) {
      if (open === null) open = part;
      else if (open === part) open = null;
      return part;
    }
    return open === null ? part.replace(INTRAWORD_ESCAPED_UNDERSCORE_RE, "_") : part;
  }).join("");
}

export function unescapeIntrawordUnderscores(markdown: string): string {
  if (!markdown.includes("\\_")) return markdown;
  let fence: string | null = null;
  return markdown.split("\n").map((line) => {
    const marker = FENCE_RE.exec(line)?.[1];
    if (fence !== null) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
      return line;
    }
    if (marker) {
      fence = marker;
      return line;
    }
    return unescapeOutsideCodeSpans(line);
  }).join("\n");
}
