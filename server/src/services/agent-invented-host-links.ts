/**
 * Agents sometimes write a Paperclip link with a hostname they made up, such
 * as https://paperclip.local/COM/agents/<id> or https://paperclip/api/...
 * Neither host exists, so the link does not open. When the path is a known
 * board or API route, the relative form opens on whatever origin the reader
 * already uses. Every other link, and anything inside code, is left alone.
 */
import { loadConfig } from "../config.js";

// Board route roots after the company prefix: every root in
// ui/src/lib/company-routes.ts (a test keeps them aligned), plus the case and
// status pages agents are told to link.
export const BOARD_ROUTE_ROOTS = new Set([
  "dashboard", "companies", "company", "skills", "teams-catalog", "org", "agents", "chats", "apps",
  "projects", "workspaces", "execution-workspaces", "issues", "tasks", "responsibilities", "routines", "goals", "artifacts",
  "tools", "approvals", "costs", "usage", "activity", "audit", "decisions", "inbox", "board-chat", "u",
  "design-guide", "search", "settings", "timeline", "cases", "status", "status-cards",
]);

const URL_PATTERN = /https?:\/\/(?:\[[0-9A-Fa-f:.]+\](?::\d+)?|[^\s/?#()<>[\]"'`]+)[^\s()<>[\]"'`]*/gi;
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

// A Markdown reference definition up to its destination: `[id]: <`.
const REFERENCE_DEFINITION = /(?:^|\n) {0,3}\[[^\]\n]+\]:[ \t]*<?$/;

/**
 * The text with every Markdown code region blanked, keeping offsets: fenced
 * blocks (also inside block quotes or list items), indented code blocks, and
 * inline code spans, which may cross lines within a paragraph.
 */
function maskCode(text: string): string {
  const lines = text.split("\n");
  let fence: { char: string; length: number } | null = null;
  let previousBlank = true;
  let inIndentedBlock = false;
  const masked = lines.map(line => {
    const body = line.replace(/^(?:[ \t]*>)+[ \t]?/, "");
    const marker = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(body);
    const blank = !body.trim();
    let code = false;
    if (fence) {
      code = true;
      if (marker && marker[1]![0] === fence.char && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = null;
    } else if (marker && !(marker[1]![0] === "`" && marker[2]!.includes("`"))) {
      fence = { char: marker[1]![0]!, length: marker[1]!.length };
      code = true;
    } else if (!blank && /^(?: {4}|\t)/.test(body) && (previousBlank || inIndentedBlock)) {
      code = true;
    }
    inIndentedBlock = code && !fence && !marker ? true : blank ? inIndentedBlock : false;
    previousBlank = blank;
    return code ? " ".repeat(line.length) : line;
  }).join("\n");
  // Inline spans: a backtick run closes at the next run of the same length in
  // its paragraph; an escaped backtick opens nothing.
  const chars = masked.split("");
  for (let index = 0; index < masked.length; index += 1) {
    if (masked[index] === "\\") {
      index += 1;
      continue;
    }
    if (masked[index] !== "`") continue;
    let length = 1;
    while (masked[index + length] === "`") length += 1;
    const paragraphEnd = masked.indexOf("\n\n", index);
    const limit = paragraphEnd < 0 ? masked.length : paragraphEnd;
    let close = -1;
    for (let at = index + length; at < limit; at += 1) {
      if (masked[at] !== "`") continue;
      let run = 1;
      while (masked[at + run] === "`") run += 1;
      if (run === length) {
        close = at;
        break;
      }
      at += run - 1;
    }
    if (close < 0) {
      index += length - 1;
      continue;
    }
    for (let at = index; at < close + length; at += 1) if (chars[at] !== "\n") chars[at] = " ";
    index = close + length - 1;
  }
  return chars.join("");
}

/** Rewrite made-up-host Paperclip links outside Markdown code. */
export function relativizeInventedHostLinks(text: string, context: InventedHostLinkContext): string {
  if (!mayContainInventedHostLink(text)) return text;
  const masked = maskCode(text);
  let result = "";
  let cursor = 0;
  for (const match of masked.matchAll(URL_PATTERN)) {
    const offset = match.index!;
    // Sentence punctuation after a bare link is not part of it.
    const raw = match[0].replace(/[.,;:!?]+$/, "");
    const route = relativeRoute(raw, context);
    if (!route) continue;
    const before = text.slice(Math.max(0, offset - 3), offset);
    const end = offset + raw.length;
    // A link destination (inline, angle-bracketed or a reference definition),
    // link text, or an attribute value keeps its place. An autolink or a bare
    // link becomes a Markdown link so it stays clickable.
    const autolink = before.endsWith("<") && text[end] === ">" && !before.endsWith("](<") && !REFERENCE_DEFINITION.test(text.slice(0, offset));
    const inPlace = !autolink && (before.endsWith("](") || before.endsWith("](<") || before.endsWith("[")
      || /["'=]$/.test(before) || REFERENCE_DEFINITION.test(text.slice(Math.max(0, offset - 300), offset)));
    if (autolink) {
      result += `${text.slice(cursor, offset - 1)}[${route}](${route})`;
      cursor = end + 1;
    } else {
      result += `${text.slice(cursor, offset)}${inPlace ? route : `[${route}](${route})`}`;
      cursor = end;
    }
  }
  return cursor === 0 ? text : result + text.slice(cursor);
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
