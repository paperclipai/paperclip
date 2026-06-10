/**
 * Markdown helpers used when ingesting Linear-side content into Paperclip.
 *
 * The UI's `remarkLinkIssueReferences` (ui/src/lib/issue-reference.ts) maps any
 * bare `BLO-1234`-style identifier in a markdown text node — and inline-code
 * nodes whose entire value is a bare ref — to Paperclip's own
 * `/issues/BLO-1234`. Paperclip and Linear can use the same identifier scheme
 * (e.g. both default to `BLO-N` for a "Blockcast" workspace+team) for entirely
 * different issues, so a Linear comment that mentions `BLO-1488` (in text or
 * as `` `BLO-1488` ``) silently mis-routes to Paperclip's own `BLO-1488`.
 *
 * Pre-wrapping bare refs as proper markdown links to `linear.app` short-circuits
 * the UI rewrite — `link` nodes are skipped by the AST walk — and points the
 * reader to the correct system.
 */

/**
 * Match either a bare `XXX-N` ref (plus compact `XXX-N/M` groups) or an
 * inline-code-wrapped one (`` `XXX-N` `` / `` `XXX-N/M` ``).
 * The inline-code alternative is listed first so the regex engine prefers the
 * longer match, keeping the backticks attached to the bare ref so the wrapped
 * link renders as `` [`XXX-N`](url) `` (preserving the code styling) rather
 * than splitting into `` `[XXX-N](url)` `` (which would render as code, not a
 * link). The `\b` boundaries guard against mid-word matches like `xBLO-1y`.
 */
const WRAP_ISSUE_RE = /`([A-Z][A-Z0-9]+-\d+(?:\/\d+)*)`|\b[A-Z][A-Z0-9]+-\d+(?:\/\d+)*\b/gi;
const COMPACT_ISSUE_REFERENCE_RE = /^([A-Z][A-Z0-9]+)-(\d+)((?:\/\d+)*)$/i;
const PAPERCLIP_MARKDOWN_LINK_RE = /(!?)\[([^\]\n]*(?:\\.[^\]\n]*)*)\]\(([^)\s]+)((?:\s+["'][^"']*["'])?)\)/g;
const PAPERCLIP_PROJECT_BACKLINK_RE = /\n{0,2}---\n_Paperclip sync:_ \[Open Paperclip project\]\([^)]+\)\s*$/;
const PAPERCLIP_ROUTE_SEGMENTS = new Set([
  "agents",
  "approvals",
  "company",
  "goals",
  "inbox",
  "issues",
  "projects",
  "routines",
]);

/**
 * Whether `s` is exactly a bare issue ref with no surrounding chars. Used to
 * decide whether an inline-code span should be left alone for the wrap pass
 * (so its bare-ref content gets rewritten) or stashed as opaque content.
 */
const ENTIRE_BARE_ISSUE_RE = /^[A-Z][A-Z0-9]+-\d+(?:\/\d+)*$/i;
const COMPANY_PREFIX_RE = /^[A-Z][A-Z0-9]*$/i;

export function normalizePaperclipBaseUrl(baseUrl: string | null | undefined): string | null {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function splitPathSuffix(href: string): { path: string; suffix: string } {
  const match = href.match(/^([^?#]*)([?#].*)?$/);
  return {
    path: match?.[1] ?? href,
    suffix: match?.[2] ?? "",
  };
}

function canonicalPaperclipPath(href: string, companyPrefix: string | null | undefined): string | null {
  if (!href.startsWith("/")) return null;
  if (href.startsWith("//")) return null;

  const { path, suffix } = splitPathSuffix(href);
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return null;

  const first = segments[0] ?? "";
  const second = segments[1] ?? "";
  if (PAPERCLIP_ROUTE_SEGMENTS.has(first)) {
    const prefix = companyPrefix?.trim();
    return prefix ? `/${encodeURIComponent(prefix)}${path}${suffix}` : `${path}${suffix}`;
  }

  if (COMPANY_PREFIX_RE.test(first) && PAPERCLIP_ROUTE_SEGMENTS.has(second)) {
    return `${path}${suffix}`;
  }

  return null;
}

export function absolutePaperclipHref(
  href: string,
  baseUrl: string | null | undefined,
  companyPrefix?: string | null,
): string {
  if (!href) return href;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#")) return href;

  const base = normalizePaperclipBaseUrl(baseUrl);
  if (!base) return href;

  const path = canonicalPaperclipPath(href, companyPrefix);
  return path ? `${base}${path}` : href;
}

export function absolutizePaperclipMarkdownLinks(
  body: string,
  baseUrl: string | null | undefined,
  companyPrefix?: string | null,
): string {
  if (!body) return body;
  const base = normalizePaperclipBaseUrl(baseUrl);
  if (!base) return body;

  return body.replace(PAPERCLIP_MARKDOWN_LINK_RE, (full, imagePrefix: string, text: string, href: string, title: string) => {
    const absolute = absolutePaperclipHref(href, base, companyPrefix);
    if (absolute === href) return full;
    return `${imagePrefix}[${text}](${absolute}${title ?? ""})`;
  });
}

export function stripPaperclipProjectBacklink(description: string | null | undefined): string | null {
  if (description == null) return null;
  const stripped = description.replace(PAPERCLIP_PROJECT_BACKLINK_RE, "").trimEnd();
  return stripped.length > 0 ? stripped : null;
}

export function appendPaperclipProjectBacklink(
  description: string | null | undefined,
  paperclipUrl: string,
): string {
  const stripped = stripPaperclipProjectBacklink(description);
  const backlink = `_Paperclip sync:_ [Open Paperclip project](${paperclipUrl})`;
  return stripped ? `${stripped}\n\n---\n${backlink}` : backlink;
}

/**
 * Pull the workspace url-key (e.g. `blockcast`) from a Linear issue url.
 * Returns null when the url is empty, malformed, or doesn't include the
 * workspace segment (the webhook path constructs slug-less urls when the
 * Linear payload omits `data.url`).
 */
export function extractLinearWorkspaceSlug(linearUrl: string | null | undefined): string | null {
  if (!linearUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(linearUrl);
  } catch {
    return null;
  }
  if (parsed.hostname !== "linear.app") return null;
  const segments = parsed.pathname.split("/").filter(Boolean);
  // Workspace urls: /<slug>/issue/<ident>/... or /<slug>/initiative/<id>/...
  // Slug-less fallback: /issue/<ident> → no workspace.
  const first = segments[0];
  if (!first) return null;
  if (first === "issue" || first === "initiatives") return null;
  return first;
}

/** Build the Linear issue url, preferring the workspace-prefixed form. */
function buildLinearIssueUrl(identifier: string, workspaceSlug: string | null): string {
  return workspaceSlug
    ? `https://linear.app/${workspaceSlug}/issue/${identifier}`
    : `https://linear.app/issue/${identifier}`;
}

function linkifyIssueReferenceText(
  value: string,
  workspaceSlug: string | null,
  wrapTextAsInlineCode: boolean,
): string {
  const match = value.match(COMPACT_ISSUE_REFERENCE_RE);
  if (!match) return value;

  const prefixText = match[1]!;
  const prefix = prefixText.toUpperCase();
  const firstNumber = match[2]!;
  const tailNumbers = (match[3] ?? "").split("/").filter(Boolean);
  const firstValue = `${prefixText}-${firstNumber}`;

  const link = (display: string, identifier: string) => {
    const linkText = wrapTextAsInlineCode ? `\`${display}\`` : display;
    return `[${linkText}](${buildLinearIssueUrl(identifier, workspaceSlug)})`;
  };

  const linked = [
    link(firstValue, `${prefix}-${firstNumber}`),
    ...tailNumbers.map((number) => link(number, `${prefix}-${number}`)),
  ];
  return linked.join("/");
}

/**
 * Wrap bare `XXX-N` identifiers in `body` with markdown links pointing back to
 * Linear. Compact slash forms like `BLO-1488/1489` are expanded to links for
 * each issue. Whole-ref inline-code spans (`` `BLO-1488` ``) are also wrapped
 * — as `` [`BLO-1488`](url) `` — because the UI rewriter rewrites those too.
 * Multi-token inline code (`` `someFunc(BLO-1)` ``), fenced code blocks,
 * URLs, autolinks, and existing markdown links are left untouched.
 *
 * The `workspaceSlug` is best-effort. When null, links degrade to
 * `https://linear.app/issue/XXX-N` — that form does NOT resolve to a real
 * Linear page (returns the marketing site), but it still removes the
 * mis-route to Paperclip's own `/issues/XXX-N`, which is the actual bug. The
 * webhook payload's url is the canonical source for the slug; persisting it
 * at OAuth-connect time would let the slug-less branch go away. (TODO.)
 */
export function linkifyBareLinearIssueRefs(
  body: string,
  workspaceSlug: string | null,
): string {
  if (!body) return body;

  type Mask = { token: string; original: string };
  const masks: Mask[] = [];
  const stash = (original: string): string => {
    const token = `__LINEAR_LINKIFY_MASK_${masks.length}__`;
    masks.push({ token, original });
    return token;
  };

  // Order matters: fenced code blocks first (they may contain anything,
  // including ``` text or links), then existing markdown links and autolinks
  // (whose link text or url could otherwise be corrupted). Inline code is
  // masked last AND only when its content is not itself a bare-ref-only
  // span — the bare-ref-only case has to flow through to the wrap pass so the
  // UI rewriter doesn't re-route it to Paperclip's own /issues/<id>.
  const masked = body
    .replace(/```[\s\S]*?```/g, (m) => stash(m))
    .replace(/\[(?:\\.|[^\]\\])*\]\((?:\\.|[^)\\])*\)/g, (m) => stash(m))
    .replace(/<https?:\/\/[^>\s]+>/g, (m) => stash(m))
    .replace(/https?:\/\/[^\s<>()]+/g, (m) => stash(m))
    .replace(/`([^`\n]+)`/g, (full, inner: string) =>
      ENTIRE_BARE_ISSUE_RE.test(inner) ? full : stash(full),
    );

  const linkified = masked.replace(WRAP_ISSUE_RE, (match, codeInner: string | undefined) => {
    if (codeInner) {
      // Inline-code form: wrap the backticks AS THE LINK TEXT so the rendered
      // markdown shows `BLO-1488` in code styling but routes to Linear.
      return linkifyIssueReferenceText(codeInner, workspaceSlug, true);
    }
    return linkifyIssueReferenceText(match, workspaceSlug, false);
  });

  // Unmask in reverse order so any nested placeholders (a link mask containing
  // an inline-code mask, etc.) restore correctly.
  let out = linkified;
  for (let i = masks.length - 1; i >= 0; i--) {
    out = out.replace(masks[i]!.token, () => masks[i]!.original);
  }
  return out;
}
