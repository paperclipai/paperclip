import { createContext } from "react";

/** Opt-in for synthetic streaming previews; settled/ordinary Markdown stays
 * unchanged. New word elements animate once; existing DOM words are retained. */
export const MarkdownWordStreaming = createContext(false);

type WordNode = {
  type: string; value?: string; tagName?: string;
  properties?: Record<string, unknown>; children?: WordNode[];
};
export function rehypeStreamingWords() {
  return (tree: WordNode) => {
    const visit = (node: WordNode) => {
      // Code renderers consume text directly and own their own syntax markup.
      if (!node.children || node.tagName === "pre" || node.tagName === "code") return;
      node.children = node.children.flatMap(child => {
        if (child.type !== "text" || !child.value) { visit(child); return [child]; }
        return (child.value.match(/\s+|\S+/gu) ?? []).map(value => /\S/u.test(value) ? {
          type: "element", tagName: "span", properties: { className: ["conversation-stream-word"] },
          children: [{ type: "text", value }],
        } : { type: "text", value });
      });
    };
    visit(tree);
  };
}
