import { fromMarkdown } from "mdast-util-from-markdown";

export type ReplyContentPart = { text: string } | { href: string; label?: string };
type MarkdownNode = { type: string; value?: string; url?: string; children?: MarkdownNode[] };

function normalized(parts: ReplyContentPart[], origin: string) {
  const result: ReplyContentPart[] = [];
  for (const part of parts) {
    if ("href" in part) {
      try { result.push({ href: new URL(part.href, origin).href }); } catch { return null; }
    } else {
      const text = part.text.replace(/\s+/g, " ");
      const previous = result.at(-1);
      if (previous && "text" in previous) previous.text = (previous.text + text).replace(/\s+/g, " ");
      else if (text) result.push({ text });
    }
  }
  const first = result[0], last = result.at(-1);
  if (first && "text" in first) first.text = first.text.trimStart();
  if (last && "text" in last) last.text = last.text.trimEnd();
  return result.filter(part => !("text" in part) || part.text);
}

/** Compare complete message content while allowing the UI to decorate a link
 * with an issue/document chip. Its exact destination still has to match.
 * Unsupported Markdown fails closed rather than stripping arbitrary syntax. */
export function taskReplyContentMatches(
  observation: { body: string; content?: ReplyContentPart[]; origin?: string },
  markdown: string,
) {
  if (observation.content) {
    // Bind the structured projection to the independently observed innerText.
    // A destination alone cannot attest to arbitrary visible wording.
    if (observation.content.some(part => "href" in part && (typeof part.label !== "string" || !part.label.trim()))) return false;
    const displayed = observation.content.map(part => "text" in part ? part.text : part.label!).join("").replace(/\s+/g, " ").trim();
    if (displayed !== observation.body.replace(/\s+/g, " ").trim()) return false;
  }
  const parts: ReplyContentPart[] = [];
  const inlineLabel = (node: MarkdownNode): boolean => ["text", "inlineCode", "strong", "emphasis"].includes(node.type)
    && (node.children ?? []).every(inlineLabel);
  function visit(node: MarkdownNode): boolean {
    if (node.type === "text" || node.type === "inlineCode") { parts.push({ text: node.value ?? "" }); return true; }
    if (node.type === "break") { parts.push({ text: " " }); return true; }
    if (node.type === "link" && node.url && (node.children ?? []).every(inlineLabel)) { parts.push({ href: node.url }); return true; }
    if (!["root", "paragraph", "heading", "blockquote", "list", "listItem", "strong", "emphasis"].includes(node.type)) return false;
    for (const child of node.children ?? []) if (!visit(child)) return false;
    if (!["strong", "emphasis"].includes(node.type)) parts.push({ text: " " });
    return true;
  }
  if (!visit(fromMarkdown(markdown) as MarkdownNode)) return false;
  const origin = observation.origin ?? "https://reply.invalid";
  const expected = normalized(parts, origin);
  const actual = normalized(observation.content ?? [{ text: observation.body }], origin);
  return expected !== null && actual !== null && JSON.stringify(expected) === JSON.stringify(actual);
}
