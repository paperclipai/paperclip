type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
};

const BARE_ISSUE_IDENTIFIER_RE = /^[A-Z][A-Z0-9]+-\d+$/i;
const ISSUE_SCHEME_RE = /^issue:\/\/:?([^?#\s]+)(?:[?#].*)?$/i;
const ISSUE_REFERENCE_TOKEN_RE = /issue:\/\/:?[^\s<>()]+|https?:\/\/[^\s<>()]+|\/(?:[^\s<>()/]+\/)*issues\/[A-Z][A-Z0-9]+-\d+(?=$|[\s<>)\],.;!?:])|\b[A-Z][A-Z0-9]+-\d+\b/gi;

export function parseIssuePathIdFromPath(pathOrUrl: string | null | undefined): string | null {
  if (!pathOrUrl) return null;
  let pathname = pathOrUrl.trim();
  if (!pathname) return null;

  if (/^https?:\/\//i.test(pathname)) {
    try {
      const url = new URL(pathname);
      if (url.hostname === "github.com" || url.hostname === "www.github.com") return null;
      pathname = url.pathname;
    } catch {
      return null;
    }
  }

  const segments = pathname.split("/").filter(Boolean);
  const issueIndex = segments.findIndex((segment) => segment === "issues");
  if (issueIndex === -1 || issueIndex === segments.length - 1) return null;
  const issuePathId = decodeURIComponent(segments[issueIndex + 1] ?? "");
  if (!issuePathId || issuePathId.startsWith(":")) return null;
  return BARE_ISSUE_IDENTIFIER_RE.test(issuePathId) ? issuePathId.toUpperCase() : issuePathId;
}

export function parseIssueReferenceFromHref(href: string | null | undefined) {
  if (!href) return null;
  const trimmed = href.trim();
  const issueSchemeMatch = trimmed.match(ISSUE_SCHEME_RE);
  if (issueSchemeMatch?.[1]) {
    const issuePathId = decodeURIComponent(issueSchemeMatch[1]);
    return {
      issuePathId,
      href: `/issues/${encodeURIComponent(issuePathId)}`,
    };
  }

  const pathId = parseIssuePathIdFromPath(href);
  if (pathId) {
    return {
      issuePathId: pathId,
      href: `/issues/${encodeURIComponent(pathId)}`,
    };
  }

  if (!BARE_ISSUE_IDENTIFIER_RE.test(trimmed)) return null;
  const normalized = trimmed.toUpperCase();
  return {
    issuePathId: normalized,
    href: `/issues/${encodeURIComponent(normalized)}`,
  };
}

function splitTrailingPunctuation(token: string) {
  let core = token;
  let trailing = "";

  while (core.length > 0) {
    const lastChar = core.at(-1);
    if (!lastChar || !/[),.;!?:\]]/.test(lastChar)) break;
    if (lastChar === ")") {
      const openCount = (core.match(/\(/g) ?? []).length;
      const closeCount = (core.match(/\)/g) ?? []).length;
      if (closeCount <= openCount) break;
    }
    if (lastChar === "]") {
      const openCount = (core.match(/\[/g) ?? []).length;
      const closeCount = (core.match(/\]/g) ?? []).length;
      if (closeCount <= openCount) break;
    }
    trailing = `${lastChar}${trailing}`;
    core = core.slice(0, -1);
  }

  return { core, trailing };
}

function createIssueLinkNode(value: string, href: string, childType: "text" | "inlineCode" = "text"): MarkdownNode {
  return {
    type: "link",
    url: href,
    children: [{ type: childType, value }],
  };
}

function linkifyIssueReferencesInText(value: string): MarkdownNode[] | null {
  const nodes: MarkdownNode[] = [];
  let cursor = 0;
  let matched = false;

  for (const match of value.matchAll(ISSUE_REFERENCE_TOKEN_RE)) {
    const raw = match[0];
    if (!raw) continue;

    const start = match.index ?? 0;
    const end = start + raw.length;
    const { core, trailing } = splitTrailingPunctuation(raw);
    const issueRef = parseIssueReferenceFromHref(core);
    if (!issueRef) continue;

    matched = true;
    if (start > cursor) {
      nodes.push({ type: "text", value: value.slice(cursor, start) });
    }
    nodes.push(createIssueLinkNode(core, issueRef.href));
    if (trailing) {
      nodes.push({ type: "text", value: trailing });
    }
    cursor = end;
  }

  if (!matched) return null;
  if (cursor < value.length) {
    nodes.push({ type: "text", value: value.slice(cursor) });
  }
  return nodes;
}

function rewriteMarkdownTree(node: MarkdownNode) {
  if (!Array.isArray(node.children) || node.children.length === 0) return;
  if (node.type === "link" || node.type === "linkReference" || node.type === "code" || node.type === "definition" || node.type === "html") {
    return;
  }

  const nextChildren: MarkdownNode[] = [];
  for (const child of node.children) {
    if (child.type === "inlineCode" && typeof child.value === "string") {
      const issueRef = parseIssueReferenceFromHref(child.value);
      if (issueRef) {
        nextChildren.push(createIssueLinkNode(child.value, issueRef.href, "inlineCode"));
        continue;
      }
    }

    if (child.type === "text" && typeof child.value === "string") {
      const linked = linkifyIssueReferencesInText(child.value);
      if (linked) {
        nextChildren.push(...linked);
        continue;
      }
    }

    rewriteMarkdownTree(child);
    nextChildren.push(child);
  }
  node.children = nextChildren;
}

export function remarkLinkIssueReferences() {
  return (tree: MarkdownNode) => {
    rewriteMarkdownTree(tree);
  };
}
