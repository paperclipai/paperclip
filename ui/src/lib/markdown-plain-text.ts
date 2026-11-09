// Private-use sentinels: protected spans are swapped out while markup is
// stripped, so code and autolinks are never edited by the emphasis rules.
const PROTECT_OPEN = "\uE000";
const PROTECT_CLOSE = "\uE001";

/**
 * Flatten agent-authored markdown into one line of readable text for
 * single-line previews (collapsed rows, truncated summaries). Keeps the words,
 * drops the syntax: code ticks, emphasis markers, list/heading/quote prefixes,
 * and link/image targets. Code and autolink text is kept verbatim. Not a
 * renderer: use MarkdownBody when the formatting itself should be shown.
 */
export function markdownToPlainText(markdown: string): string {
  const protectedSpans: string[] = [];
  const protect = (text: string) => `${PROTECT_OPEN}${protectedSpans.push(text) - 1}${PROTECT_CLOSE}`;

  return markdown
    .replace(new RegExp(`[${PROTECT_OPEN}${PROTECT_CLOSE}]`, "g"), "")
    // Fenced code blocks: keep the code, drop the fences.
    .replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)(?:\n[ \t]*\1[^\n]*|$)/gm, (_match, _fence, code: string) => protect(code))
    .replace(/^[ \t]*(`{3,}|~{3,})[^\n]*$/gm, "")
    // Inline code.
    .replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_match, _ticks, code: string) => protect(code.trim()))
    // Autolinks (<https://…>, <name@host>): keep the address.
    .replace(/<((?:[a-zA-Z][a-zA-Z\d+.-]{1,31}:[^\s<>]*)|(?:[^\s<>@]+@[^\s<>@]+))>/g, (_match, address: string) => protect(address))
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
    .replace(new RegExp(`${PROTECT_OPEN}(\\d+)${PROTECT_CLOSE}`, "g"), (_match, index: string) => protectedSpans[Number(index)] ?? "")
    .replace(/\s+/g, " ")
    .trim();
}
