type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
};

const BARE_ISSUE_IDENTIFIER_RE = /^[A-Z][A-Z0-9]*-\d+$/i;
const COMPACT_ISSUE_REFERENCE_RE = /^([A-Z][A-Z0-9]*)-(\d+)((?:\/\d+)*)$/i;
const ISSUE_SCHEME_RE = /^issue:\/\/:?([^?#\s]+)(?:[?#].*)?$/i;
const ISSUE_REFERENCE_TOKEN_RE = /issue:\/\/:?[^\s<>()]+|https?:\/\/[^\s<>()]+|\/(?:[^\s<>()/]+\/)*issues\/[A-Z][A-Z0-9]*-\d+(?=$|[\s<>)\],.;!?:])|\b[A-Z][A-Z0-9]*-\d+(?:\/\d+)*\b/gi;

export function parseIssuePathIdFromPath(pathOrUrl: string | null | undefined): string | null {
  if (!pathOrUrl) return null;
  const pathname = pathOrUrl.trim();
  if (!pathname) return null;
  if (/^https?:\/\//i.test(pathname)) return null;

  const segments = pathname.split("/").filter(Boolean);
  const issueIndex = segments.findIndex((segment) => segment === "issues");
  if (issueIndex === -1 || issueIndex === segments.length - 1) return null;
  const issuePathId = decodeURIComponent(segments[issueIndex + 1] ?? "");
  if (!issuePathId || issuePathId.startsWith(":")) return null;
  return BARE_ISSUE_IDENTIFIER_RE.test(issuePathId) ? issuePathId.toUpperCase() : issuePathId;
}

export function parseIssueReferenceFromHref(
  href: string | null | undefined,
  knownPrefixes?: Set<string>,
) {
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
  // Only auto-link a bare IDENT-123 token when its prefix belongs to a known
  // company. An empty or omitted set means "prefixes unknown" -> stay permissive
  // (preserves behavior during initial load and in provider-less render
  // surfaces). The issue:// scheme and /issues/ path forms handled above are
  // never gated -- they are deliberate references, not accidental foreign keys.
  if (knownPrefixes && knownPrefixes.size > 0) {
    const prefix = normalized.split("-")[0];
    if (!prefix || !knownPrefixes.has(prefix)) return null;
  }
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

function compactIssueReferenceSpans(value: string, knownPrefixes?: Set<string>) {
  const match = value.match(COMPACT_ISSUE_REFERENCE_RE);
  if (!match) return null;

  const prefixText = match[1]!;
  const prefix = prefixText.toUpperCase();
  if (knownPrefixes && knownPrefixes.size > 0 && !knownPrefixes.has(prefix)) {
    return null;
  }
  const firstNumber = match[2]!;
  const tailNumbers = (match[3] ?? "").split("/").filter(Boolean);
  const spans: Array<{ start: number; end: number; value: string; href: string }> = [];

  const firstValue = `${prefixText}-${firstNumber}`;
  spans.push({
    start: 0,
    end: firstValue.length,
    value: firstValue,
    href: `/issues/${encodeURIComponent(`${prefix}-${firstNumber}`)}`,
  });

  let cursor = firstValue.length;
  for (const number of tailNumbers) {
    cursor += 1; // slash separator
    spans.push({
      start: cursor,
      end: cursor + number.length,
      value: number,
      href: `/issues/${encodeURIComponent(`${prefix}-${number}`)}`,
    });
    cursor += number.length;
  }

  return spans;
}

function linkifyIssueReferencesInText(value: string, knownPrefixes?: Set<string>): MarkdownNode[] | null {
  const nodes: MarkdownNode[] = [];
  let cursor = 0;
  let matched = false;

  for (const match of value.matchAll(ISSUE_REFERENCE_TOKEN_RE)) {
    const raw = match[0];
    if (!raw) continue;

    const start = match.index ?? 0;
    const end = start + raw.length;
    const { core, trailing } = splitTrailingPunctuation(raw);
    const compactSpans = compactIssueReferenceSpans(core, knownPrefixes);
    if (compactSpans) {
      matched = true;
      if (start > cursor) {
        nodes.push({ type: "text", value: value.slice(cursor, start) });
      }

      let compactCursor = 0;
      for (const span of compactSpans) {
        if (span.start > compactCursor) {
          nodes.push({ type: "text", value: core.slice(compactCursor, span.start) });
        }
        nodes.push(createIssueLinkNode(span.value, span.href));
        compactCursor = span.end;
      }
      if (compactCursor < core.length) {
        nodes.push({ type: "text", value: core.slice(compactCursor) });
      }
      if (trailing) {
        nodes.push({ type: "text", value: trailing });
      }
      cursor = end;
      continue;
    }

    const issueRef = parseIssueReferenceFromHref(core, knownPrefixes);
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

function rewriteMarkdownTree(node: MarkdownNode, knownPrefixes?: Set<string>) {
  if (!Array.isArray(node.children) || node.children.length === 0) return;
  if (node.type === "link" || node.type === "linkReference" || node.type === "code" || node.type === "definition" || node.type === "html") {
    return;
  }

  const nextChildren: MarkdownNode[] = [];
  for (const child of node.children) {
    if (child.type === "inlineCode" && typeof child.value === "string") {
      const issueRef = parseIssueReferenceFromHref(child.value, knownPrefixes);
      if (issueRef) {
        nextChildren.push(createIssueLinkNode(child.value, issueRef.href, "inlineCode"));
        continue;
      }
    }

    if (child.type === "text" && typeof child.value === "string") {
      const linked = linkifyIssueReferencesInText(child.value, knownPrefixes);
      if (linked) {
        nextChildren.push(...linked);
        continue;
      }
    }

    rewriteMarkdownTree(child, knownPrefixes);
    nextChildren.push(child);
  }
  node.children = nextChildren;
}

export interface RemarkLinkIssueReferencesOptions {
  /**
   * Company issue prefixes that are eligible for auto-linking. When provided
   * and non-empty, a bare IDENT-123 token only becomes an issue link if its
   * prefix is in this set -- this keeps foreign tracker keys (e.g. a Jira
   * "TREE-604") from linking to non-existent Paperclip issues. Omit or pass an
   * empty list to keep the legacy permissive behavior (link any IDENT-123).
   */
  knownPrefixes?: string[];
}

export function remarkLinkIssueReferences(options?: RemarkLinkIssueReferencesOptions) {
  const knownPrefixes = options?.knownPrefixes && options.knownPrefixes.length > 0
    ? new Set(options.knownPrefixes.map((prefix) => prefix.toUpperCase()))
    : undefined;
  return (tree: MarkdownNode) => {
    rewriteMarkdownTree(tree, knownPrefixes);
  };
}
