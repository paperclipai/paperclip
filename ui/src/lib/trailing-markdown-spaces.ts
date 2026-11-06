import { fromMarkdown } from "mdast-util-from-markdown";

interface PositionedNode {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: PositionedNode[];
}

/**
 * The rich editor exports a final prose space as `&#x20;`. Restore that space
 * before storing the draft so message submission can trim it normally.
 * Only touch the final text node: code, HTML, and escaped literal entities
 * must keep their source. Run on the exact export, before other unescaping.
 */
export function restoreTrailingMarkdownSpaces(markdown: string): string {
  const suffix = /(?:&#x20;[ \t\r\n]*)+$/.exec(markdown);
  if (!suffix) return markdown;

  let node: PositionedNode = fromMarkdown(markdown);
  while (node.children?.length) node = node.children[node.children.length - 1];
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (node.type !== "text" || start === undefined || end === undefined || end <= suffix.index) {
    return markdown;
  }

  const text = markdown.slice(start, end).replace(/\\[\s\S]|&#x20;/g, (value, offset: number) =>
    value === "&#x20;" && start + offset >= suffix.index ? " " : value);
  return markdown.slice(0, start) + text + markdown.slice(end);
}
