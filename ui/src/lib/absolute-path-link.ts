type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
};

const ABSOLUTE_PATH_PREFIX_RE = /^(?:\/(?:Users|home|private|var|tmp|opt)\/|~\/)/;

export function isPlausibleAbsolutePath(value: string | null | undefined): boolean {
  if (!value) return false;
  if (/[\n\r\0]/.test(value)) return false;
  if (value.includes("://")) return false;
  return ABSOLUTE_PATH_PREFIX_RE.test(value);
}

export function buildVscodeFileHref(absPath: string): string {
  const segments = absPath.split("/");
  const encoded = segments
    .map((segment, index) => {
      if (index === 0 && segment === "~") return "~";
      return encodeURIComponent(segment);
    })
    .join("/");
  return encoded.startsWith("/")
    ? `vscode://file${encoded}`
    : `vscode://file/${encoded}`;
}

function buildAbsolutePathLinkNode(value: string): MarkdownNode {
  return {
    type: "link",
    url: buildVscodeFileHref(value),
    children: [{ type: "inlineCode", value }],
  };
}

function rewriteMarkdownTree(node: MarkdownNode) {
  if (!Array.isArray(node.children) || node.children.length === 0) return;
  if (
    node.type === "link" ||
    node.type === "linkReference" ||
    node.type === "code" ||
    node.type === "definition" ||
    node.type === "html"
  ) {
    return;
  }

  const nextChildren: MarkdownNode[] = [];
  for (const child of node.children) {
    if (
      child.type === "inlineCode" &&
      typeof child.value === "string" &&
      isPlausibleAbsolutePath(child.value)
    ) {
      nextChildren.push(buildAbsolutePathLinkNode(child.value));
      continue;
    }

    rewriteMarkdownTree(child);
    nextChildren.push(child);
  }
  node.children = nextChildren;
}

export function remarkLinkAbsolutePaths() {
  return (tree: MarkdownNode) => {
    rewriteMarkdownTree(tree);
  };
}
