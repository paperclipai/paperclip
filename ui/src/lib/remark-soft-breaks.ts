type MarkdownNode = {
  type?: unknown;
  value?: unknown;
  children?: unknown;
};

type MarkdownTextNode = {
  type: "text";
  value: string;
};

type MarkdownBreakNode = {
  type: "break";
};

type MarkdownParentNode = {
  children: MarkdownTreeNode[];
};

type MarkdownTreeNode = MarkdownTextNode | MarkdownBreakNode | (MarkdownNode & { children?: MarkdownTreeNode[] });

function isParentNode(value: unknown): value is MarkdownParentNode {
  return typeof value === "object" && value !== null && Array.isArray((value as MarkdownNode).children);
}

function buildSoftBreakReplacement(value: string): Array<MarkdownTextNode | MarkdownBreakNode> {
  const parts = value.split("\n");
  const replacement: Array<MarkdownTextNode | MarkdownBreakNode> = [];

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part.length > 0) {
      replacement.push({ type: "text", value: part });
    }
    if (index < parts.length - 1) {
      replacement.push({ type: "break" });
    }
  }

  return replacement.length > 0 ? replacement : [{ type: "text", value: "" }];
}

function transformNode(node: MarkdownTreeNode) {
  if (!isParentNode(node)) return;

  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index];
    if (child?.type === "text" && typeof child.value === "string" && child.value.includes("\n")) {
      const replacement = buildSoftBreakReplacement(child.value);
      node.children.splice(index, 1, ...replacement);
      index += replacement.length - 1;
      continue;
    }

    transformNode(child);
  }
}

export function remarkSoftBreaks() {
  return (tree: MarkdownTreeNode) => {
    transformNode(tree);
  };
}
