import type { PaperclipMcpConfig } from "./config.js";

const ISSUE_OR_PROJECT_HREF_RE =
  /^\/(?:(?<company>[A-Za-z][A-Za-z0-9]*)\/)?(?<kind>issues|projects)\/(?<ref>[^#?\s/]+)(?<suffix>[#?][^\s]*)?$/;
const MARKDOWN_LINK_RE = /(\[[^\]\n]*\]\()((?:\/[A-Za-z][A-Za-z0-9]*\/)?(?:\/?)(?:issues|projects)\/[^)\s]+)(\))/g;
const IDENTIFIER_PREFIX_RE = /^([A-Za-z][A-Za-z0-9]*)-\d+$/;

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function stripApiSuffix(value: string): string {
  return value.replace(/\/api\/?$/, "");
}

export function paperclipPublicBaseUrl(config: PaperclipMcpConfig): string {
  const configured = config.publicUrl?.trim();
  return stripTrailingSlash(stripApiSuffix(configured || config.apiUrl));
}

function prefixFromRef(ref: string): string | null {
  let decoded = ref;
  try {
    decoded = decodeURIComponent(ref);
  } catch {
    decoded = ref;
  }
  const match = IDENTIFIER_PREFIX_RE.exec(decoded);
  return match ? match[1].toUpperCase() : null;
}

export function absolutizePaperclipHref(href: string, publicBaseUrl: string): string {
  const trimmed = href.trim();
  if (!trimmed.startsWith("/")) return href;

  const match = ISSUE_OR_PROJECT_HREF_RE.exec(trimmed);
  if (!match?.groups) return href;

  const kind = match.groups.kind;
  const ref = match.groups.ref;
  const suffix = match.groups.suffix ?? "";
  const company = match.groups.company ?? (kind === "issues" ? prefixFromRef(ref) : null);
  const path = company
    ? `/${company}/${kind}/${ref}${suffix}`
    : `/${kind}/${ref}${suffix}`;
  return `${publicBaseUrl}${path}`;
}

export function absolutizePaperclipLinksInText(text: string, publicBaseUrl: string): string {
  let replaced = text.replace(MARKDOWN_LINK_RE, (_match, prefix: string, href: string, suffix: string) => {
    const normalizedHref = href.startsWith("/") ? href : `/${href}`;
    return `${prefix}${absolutizePaperclipHref(normalizedHref, publicBaseUrl)}${suffix}`;
  });

  if (replaced.startsWith("/")) {
    replaced = absolutizePaperclipHref(replaced, publicBaseUrl);
  }
  return replaced;
}

export function absolutizePaperclipLinksInJson<T>(value: T, publicBaseUrl: string): T {
  if (typeof value === "string") {
    return absolutizePaperclipLinksInText(value, publicBaseUrl) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => absolutizePaperclipLinksInJson(item, publicBaseUrl)) as T;
  }
  if (value && typeof value === "object") {
    const rewritten: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      rewritten[key] = absolutizePaperclipLinksInJson(nested, publicBaseUrl);
    }
    return rewritten as T;
  }
  return value;
}
