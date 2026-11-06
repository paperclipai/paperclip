/**
 * Flatten agent-authored markdown into one line of readable text for
 * single-line previews (collapsed rows, truncated summaries). Keeps the words,
 * drops the syntax: code ticks, emphasis markers, list/heading/quote prefixes,
 * and link/image targets. Not a renderer: use MarkdownBody when the formatting
 * itself should be shown.
 */
export function markdownToPlainText(markdown: string): string {
  return markdown
    // Fenced code block markers (keep the code itself).
    .replace(/^\s*(`{3,}|~{3,}).*$/gm, "")
    // Images, then links: keep the visible text, drop the target.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    // Line prefixes: headings, block quotes, list bullets and numbers, task boxes.
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, "")
    // Horizontal rules.
    .replace(/^\s*(?:[-*_]\s*){3,}$/gm, "")
    // Inline code.
    .replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_match, _ticks, code: string) => code.trim())
    // Emphasis and strikethrough. Underscore forms must sit on word boundaries
    // so snake_case identifiers survive.
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, (match, marker: string, text: string, offset: number, source: string) =>
      marker === "__" && (/\w/.test(source[offset - 1] ?? "") || /\w/.test(source[offset + match.length] ?? ""))
        ? match
        : text)
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1$2")
    .replace(/(^|[^\w_])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1$2")
    // Inline HTML tags.
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
