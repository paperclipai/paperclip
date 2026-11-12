// Linkify bare case identifiers (e.g. `PAP-C7`) inside markdown so they render
// as clickable chips pointing at the case detail page. Mirrors the sibling
// issue-reference plugin, but the `-C<n>` infix keeps case tokens from ever
// colliding with plain issue identifiers (`PREFIX-<n>`), so the two plugins can
// run side by side on the same tree. (PAP-12969 — Cases P4 comment chips.)

type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
};

const BARE_CASE_IDENTIFIER_RE = /^[A-Z][A-Z0-9]*-C\d+$/i;
const CASE_REFERENCE_TOKEN_RE = /\b[A-Z][A-Z0-9]*-C\d+\b/gi;

export function parseCaseReferenceFromHref(
  value: string | null | undefined,
  knownPrefixes?: Set<string>,
): { identifier: string; href: string } | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!BARE_CASE_IDENTIFIER_RE.test(trimmed)) return null;
  const normalized = trimmed.toUpperCase();
  // Only auto-link when the prefix belongs to a known company (mirrors the
  // issue-reference gate). An empty/omitted set stays permissive so provider-less
  // render surfaces still linkify deliberate references.
  if (knownPrefixes && knownPrefixes.size > 0) {
    const prefix = normalized.split("-")[0];
    if (!prefix || !knownPrefixes.has(prefix)) return null;
  }
  return { identifier: normalized, href: `/cases/${encodeURIComponent(normalized)}` };
}

function createCaseLinkNode(
  value: string,
  href: string,
  childType: "text" | "inlineCode" = "text",
): MarkdownNode {
  return { type: "link", url: href, children: [{ type: childType, value }] };
}

function linkifyCaseReferencesInText(value: string, knownPrefixes?: Set<string>): MarkdownNode[] | null {
  const nodes: MarkdownNode[] = [];
  let cursor = 0;
  let matched = false;
  for (const match of value.matchAll(CASE_REFERENCE_TOKEN_RE)) {
    const raw = match[0];
    if (!raw) continue;
    const caseRef = parseCaseReferenceFromHref(raw, knownPrefixes);
    if (!caseRef) continue;
    const start = match.index ?? 0;
    matched = true;
    if (start > cursor) nodes.push({ type: "text", value: value.slice(cursor, start) });
    nodes.push(createCaseLinkNode(raw, caseRef.href));
    cursor = start + raw.length;
  }
  if (!matched) return null;
  if (cursor < value.length) nodes.push({ type: "text", value: value.slice(cursor) });
  return nodes;
}

function rewriteMarkdownTree(node: MarkdownNode, knownPrefixes?: Set<string>) {
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
    if (child.type === "inlineCode" && typeof child.value === "string") {
      const caseRef = parseCaseReferenceFromHref(child.value, knownPrefixes);
      if (caseRef) {
        nextChildren.push(createCaseLinkNode(child.value, caseRef.href, "inlineCode"));
        continue;
      }
    }
    if (child.type === "text" && typeof child.value === "string") {
      const linked = linkifyCaseReferencesInText(child.value, knownPrefixes);
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

export interface RemarkLinkCaseReferencesOptions {
  /** Company prefixes eligible for auto-linking (see parseCaseReferenceFromHref). */
  knownPrefixes?: string[];
}

export function remarkLinkCaseReferences(options?: RemarkLinkCaseReferencesOptions) {
  const knownPrefixes =
    options?.knownPrefixes && options.knownPrefixes.length > 0
      ? new Set(options.knownPrefixes.map((prefix) => prefix.toUpperCase()))
      : undefined;
  return (tree: MarkdownNode) => {
    rewriteMarkdownTree(tree, knownPrefixes);
  };
}
