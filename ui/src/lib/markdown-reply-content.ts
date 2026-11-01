import { Fragment, isValidElement, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkLinkIssueReferences } from "./issue-reference.js";

export type MarkdownReplyPart = { text: string } | { href: string; label: string } | { checked: boolean };
type AstNode = { type: string; children?: AstNode[] };

/** The reply observer consumes the UI's existing parser without adding a
 * parallel Markdown dependency graph. Unsupported structures fail closed. */
export function markdownReplyContent(markdown: string, knownPrefixes?: string[]): MarkdownReplyPart[] | null {
  let rawHtml = false;
  function rejectHtml() {
    return (tree: AstNode) => {
      const nodes = [tree];
      while (nodes.length) {
        const node = nodes.pop()!;
        if (node.type === "html") rawHtml = true;
        nodes.push(...node.children ?? []);
      }
    };
  }
  const rendered = Markdown({ children: markdown,
    remarkPlugins: [remarkGfm, [remarkLinkIssueReferences, { knownPrefixes }], rejectHtml] });
  if (rawHtml) return null;
  const parts: MarkdownReplyPart[] = [];
  function visit(node: ReactNode, label?: string[]): boolean {
    if (node == null || typeof node === "boolean") return true;
    if (typeof node === "string" || typeof node === "number") {
      if (label) label.push(String(node)); else parts.push({ text: String(node) });
      return true;
    }
    if (Array.isArray(node)) return node.every(child => visit(child, label));
    if (!isValidElement<{ children?: ReactNode; href?: string; type?: string; checked?: boolean; disabled?: boolean }>(node)) return false;
    if (node.type === Fragment) return visit(node.props.children, label);
    if (!label && node.type === "input" && node.props.type === "checkbox" && node.props.disabled === true) {
      parts.push({ checked: node.props.checked === true });
      return true;
    }
    if (node.type === "a" && !label && node.props.href) {
      const words: string[] = [];
      if (!visit(node.props.children, words)) return false;
      parts.push({ href: node.props.href, label: words.join("") });
      return true;
    }
    if (node.type === "br") { if (label) label.push(" "); else parts.push({ text: " " }); return true; }
    if (["strong", "em", "del", "code"].includes(String(node.type))) return visit(node.props.children, label);
    if (!label && ["p", "ul", "ol", "li", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6"].includes(String(node.type))) {
      if (!visit(node.props.children)) return false;
      parts.push({ text: " " });
      return true;
    }
    return false;
  }
  return visit(rendered) ? parts : null;
}
