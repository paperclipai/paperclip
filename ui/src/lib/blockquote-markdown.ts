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

import { createMarkdownFenceTracker } from "./markdown-fence";

// A block-level escaped blockquote marker: `\>` at column 0, allowing only the
// 0–3 spaces of insignificant leading indent CommonMark permits before a block.
const ESCAPED_BLOCKQUOTE_RE = /^( {0,3})\\>/;

export function unescapeBlockquoteMarkers(markdown: string): string {
  if (!markdown.includes("\\>")) return markdown;

  const lines = markdown.split("\n");
  const fenceTracker = createMarkdownFenceTracker();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (fenceTracker.step(line)) {
      continue;
    }

    if (ESCAPED_BLOCKQUOTE_RE.test(line)) {
      lines[i] = line.replace(ESCAPED_BLOCKQUOTE_RE, "$1>");
    }
  }

  return lines.join("\n");
}
