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
 * Fenced code blocks are left untouched: their contents are never `\`-escaped by
 * the exporter, and a `\>` inside a code fence is meaningful literal text.
 */

const FENCE_RE = /^(\s{0,3})(`{3,}|~{3,})/;
// A line whose first non-space content is an escaped blockquote marker: `\>`.
// Optional leading whitespace mirrors how the exporter indents nested content.
const ESCAPED_BLOCKQUOTE_RE = /^(\s*)\\>/;

export function unescapeBlockquoteMarkers(markdown: string): string {
  if (!markdown.includes("\\>")) return markdown;

  const lines = markdown.split("\n");
  let inFence = false;
  let fenceMarker = "";

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[2][0]; // ` or ~
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
        fenceMarker = "";
      }
      continue;
    }

    if (inFence) continue;

    if (ESCAPED_BLOCKQUOTE_RE.test(line)) {
      lines[i] = line.replace(ESCAPED_BLOCKQUOTE_RE, "$1>");
    }
  }

  return lines.join("\n");
}
