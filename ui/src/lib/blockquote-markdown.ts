/**
 * When the WYSIWYG blockquote shortcut does not fire (e.g. the `> ` prefix is
 * assembled by an edit that Lexical's markdown-shortcut transform doesn't catch,
 * which happens on some browsers/IMEs), MDXEditor exports the paragraph as an
 * *escaped* blockquote — `\> text`. `mdast-util-to-markdown` escapes a leading
 * `>` so a literal paragraph round-trips as text rather than a blockquote.
 *
 * In this product `>` at the start of a line always means "blockquote" (there is
 * no separate literal-`>` affordance and the composer has no blockquote toolbar
 * button), so an escaped `\>` is never the user's intent — it is a silently
 * dropped blockquote. This helper rewrites a leading `\>` back to `>` so the
 * stored markdown renders as the blockquote the user typed.
 *
 * Only a marker at the block-level line start is rewritten. The exporter escapes
 * a `>` exactly where CommonMark would otherwise start a blockquote — the first
 * column of a block, allowing the 0–3 spaces of insignificant indent. Restricting
 * to `^ {0,3}\>` deliberately skips:
 *   - indented code blocks (4+ spaces of indent), whose `\>` is literal content;
 *   - content nested in a blockquote or list, whose lines carry a `>`/`-`/`digit.`
 *     container prefix rather than plain indent.
 *
 * Fenced code blocks are also skipped, including fences nested in blockquote or
 * list containers: their contents are never `\`-escaped by the exporter, and a
 * `\>` inside a code fence is meaningful literal text. Fence tracking follows
 * CommonMark: a closing fence must use the same character as the opening fence,
 * be at least as long, and carry no trailing content (an info string is only
 * allowed on the opening fence).
 */

// An opening fence may follow blockquote/list container markers. Capture the
// whole prefix so the closing scan can preserve that container context.
const FENCE_OPEN_RE =
  /^( {0,3}(?:(?:> ?|(?:[-+*]|\d{1,9}[.)]) +))*)(`{3,}|~{3,})(.*)$/;
const LIST_MARKER_RE = /(?:[-+*]|\d{1,9}[.)]) +/g;
const BLOCKQUOTE_MARKER_RE = />/g;
const FENCE_CLOSE_RE = /^( *)(`{3,}|~{3,})[ \t]*$/;
// A block-level escaped blockquote marker: `\>` at column 0, allowing only the
// 0–3 spaces of insignificant leading indent CommonMark permits before a block.
const ESCAPED_BLOCKQUOTE_RE = /^( {0,3})\\>/;

function stripBlockquotePrefix(line: string, depth: number): string | null {
  let rest = line;

  for (let i = 0; i < depth; i += 1) {
    const marker = /^ {0,3}> ?/.exec(rest);
    if (!marker) return null;
    rest = rest.slice(marker[0].length);
  }

  return rest;
}

export function unescapeBlockquoteMarkers(markdown: string): string {
  if (!markdown.includes("\\>")) return markdown;

  const lines = markdown.split("\n");
  let fenceChar = ""; // "" when not inside a fenced code block
  let fenceLen = 0;
  let fenceBlockquoteDepth = 0;
  let fenceCloseIndentMax = 3;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (fenceChar) {
      const closeCandidate = stripBlockquotePrefix(line, fenceBlockquoteDepth);
      const closeMatch = closeCandidate ? FENCE_CLOSE_RE.exec(closeCandidate) : null;

      if (closeMatch) {
        const indent = closeMatch[1].length;
        const run = closeMatch[2];
        if (indent <= fenceCloseIndentMax && run[0] === fenceChar && run.length >= fenceLen) {
          fenceChar = "";
          fenceLen = 0;
          fenceBlockquoteDepth = 0;
          fenceCloseIndentMax = 3;
        }
      }

      continue;
    }

    const fenceMatch = FENCE_OPEN_RE.exec(line);

    if (fenceMatch) {
      const prefix = fenceMatch[1];
      const run = fenceMatch[2];
      const char = run[0];
      const rest = fenceMatch[3];

      // A backtick info string may not itself contain a backtick (CommonMark);
      // such a line is not a valid opening fence.
      if (!(char === "`" && rest.includes("`"))) {
        const listMarkers = prefix.match(LIST_MARKER_RE) ?? [];
        fenceChar = char;
        fenceLen = run.length;
        fenceBlockquoteDepth = (prefix.match(BLOCKQUOTE_MARKER_RE) ?? []).length;
        // A list's continuation indent includes its marker and following spaces.
        // A closing fence may add CommonMark's normal 0–3 spaces after that.
        fenceCloseIndentMax =
          (listMarkers.length > 0 ? listMarkers.reduce((sum, marker) => sum + marker.length, 0) : 0) + 3;
        continue;
      }
    }

    if (ESCAPED_BLOCKQUOTE_RE.test(line)) {
      lines[i] = line.replace(ESCAPED_BLOCKQUOTE_RE, "$1>");
    }
  }

  return lines.join("\n");
}
