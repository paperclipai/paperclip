/**
 * Agents sometimes write a Paperclip link with a hostname they made up, such
 * as https://paperclip.local/COM/agents/<id> or https://paperclip/api/...
 * Neither host exists, so the link does not open. When the path is a known
 * board or API route, the relative form opens on whatever origin the reader
 * already uses. Every other link, and anything inside code, is left alone.
 */
import { loadConfig } from "../config.js";

// Board route roots after the company prefix (ui/src/lib/company-routes.ts),
// plus the case and status pages agents are told to link.
const BOARD_ROUTE_ROOTS = new Set([
  "dashboard", "company", "skills", "teams-catalog", "org", "agents", "chats", "apps", "projects",
  "workspaces", "execution-workspaces", "issues", "tasks", "routines", "goals", "artifacts", "tools",
  "approvals", "costs", "usage", "activity", "audit", "decisions", "inbox", "board-chat", "search",
  "settings", "timeline", "cases", "status",
]);

const URL_PATTERN = /https?:\/\/[^\s/?#()<>[\]"'`]+[^\s()<>[\]"'`]*/gi;
// A cheap test before any parsing: the text links one of the hosts below.
const CANDIDATE_PATTERN = /https?:\/\/(?:[^\s/@]*@)?(?:[a-z0-9-]+\.)*(?:paperclip(?:[.:/]|\s|$)|localhost|127\.|0\.0\.0\.0|\[::1\])/i;
const RESERVED_TLDS = new Set(["local", "localhost", "internal", "test", "example", "invalid", "lan"]);

export type InventedHostLinkContext = {
  /** This company's issue prefix, such as COM. */
  companyPrefix: string | null;
  /** This instance's own public origin; its links are never rewritten. */
  ownOrigin: string | null;
};

/** A host that only ever names Paperclip and resolves nowhere public. */
function isInventedPaperclipHost(hostname: string): boolean {
  if (hostname === "paperclip") return true;
  const labels = hostname.split(".");
  return labels.length >= 2 && labels.at(-2) === "paperclip" && RESERVED_TLDS.has(labels.at(-1)!);
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "[::1]"
    || hostname === "0.0.0.0" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

export function mayContainInventedHostLink(text: string): boolean {
  return text.includes("://") && CANDIDATE_PATTERN.test(text);
}

/**
 * The relative app route for an absolute link on a made-up Paperclip host, or
 * null to leave the link alone. A loopback host can be a real local app the
 * agent built, so it qualifies only for a board route under this company's
 * own prefix, never for an /api path.
 */
function relativeRoute(raw: string, context: InventedHostLinkContext): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const hostname = url.hostname.toLowerCase();
  const invented = isInventedPaperclipHost(hostname);
  if (!invented && !isLoopbackHost(hostname)) return null;
  if (context.ownOrigin && url.origin === context.ownOrigin) return null;
  const [, prefix = "", rootSegment = ""] = url.pathname.split("/");
  const route = `${url.pathname}${url.search}${url.hash}`;
  if (prefix === "api") return invented && rootSegment ? route : null;
  if (!/^[A-Za-z][A-Za-z0-9]{0,15}$/.test(prefix) || !BOARD_ROUTE_ROOTS.has(rootSegment.toLowerCase())) return null;
  if (invented) return route;
  return context.companyPrefix && prefix.toUpperCase() === context.companyPrefix.toUpperCase() ? route : null;
}

function rewriteProse(text: string, context: InventedHostLinkContext): string {
  return text.replace(URL_PATTERN, (match: string, offset: number) => {
    // Sentence punctuation after a bare link is not part of it.
    const raw = match.replace(/[.,;:!?]+$/, "");
    const route = relativeRoute(raw, context);
    if (!route) return match;
    const before = text.slice(Math.max(0, offset - 2), offset);
    const after = text.slice(offset + raw.length, offset + raw.length + 1);
    const trailing = match.slice(raw.length);
    // A Markdown link target or link text, or an attribute value, keeps its
    // place; an autolink or bare link becomes a Markdown link so it stays
    // clickable.
    if (before.endsWith("<") && after === ">") return `[${route}](${route})${trailing}`;
    const inPlace = before.endsWith("](") || before.endsWith("[") || /["'=]$/.test(before);
    return `${inPlace ? route : `[${route}](${route})`}${trailing}`;
  }).replace(/<(\[[^\]\s]+\]\([^)\s]+\))>/g, "$1");
}

/** Rewrite made-up-host Paperclip links outside fenced and inline code. */
export function relativizeInventedHostLinks(text: string, context: InventedHostLinkContext): string {
  if (!mayContainInventedHostLink(text)) return text;
  let fence: { char: string; length: number } | null = null;
  return text.split("\n").map(line => {
    const marker = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1]![0] === fence.char && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = null;
      return line;
    }
    if (marker) {
      fence = { char: marker[1]![0]!, length: marker[1]!.length };
      return line;
    }
    // Odd-indexed pieces are inline code spans.
    return line.split(/(`+[^`]*`+)/).map((piece, index) => index % 2 ? piece : rewriteProse(piece, context)).join("");
  }).join("\n");
}

let cachedOwnOrigin: string | null | undefined;

/**
 * This instance's configured public origin. Read once per process, and only
 * when a candidate link appears, because loading the config reads its file.
 */
export function instancePublicOrigin(): string | null {
  if (cachedOwnOrigin !== undefined) return cachedOwnOrigin;
  try {
    const base = loadConfig().authPublicBaseUrl;
    cachedOwnOrigin = base ? new URL(base).origin : null;
  } catch {
    cachedOwnOrigin = null;
  }
  return cachedOwnOrigin;
}
