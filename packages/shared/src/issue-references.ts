import { stripMarkdownCode } from "./markdown-code.js";

export const ISSUE_REFERENCE_IDENTIFIER_RE = /^[A-Z][A-Z0-9]*-\d+$/;

export interface IssueReferenceMatch {
  index: number;
  length: number;
  identifier: string;
  matchedText: string;
}

const ISSUE_REFERENCE_TOKEN_RE = /https?:\/\/[^\s<>()]+|\/[^\s<>()]+|[A-Z][A-Z0-9]*-\d+/gi;

function trimTrailingPunctuation(token: string): string {
  let trimmed = token;
  while (trimmed.length > 0) {
    const last = trimmed[trimmed.length - 1]!;
    if (!".,!?;:".includes(last) && last !== ")" && last !== "]") break;

    if (
      (last === ")" && (trimmed.match(/\(/g)?.length ?? 0) >= (trimmed.match(/\)/g)?.length ?? 0))
      || (last === "]" && (trimmed.match(/\[/g)?.length ?? 0) >= (trimmed.match(/\]/g)?.length ?? 0))
    ) {
      break;
    }
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

export function normalizeIssueIdentifier(value: string): string | null {
  const trimmed = value.trim().toUpperCase();
  return ISSUE_REFERENCE_IDENTIFIER_RE.test(trimmed) ? trimmed : null;
}

export function buildIssueReferenceHref(identifier: string): string {
  const normalized = normalizeIssueIdentifier(identifier);
  return `/issues/${normalized ?? identifier.trim()}`;
}

export function parseIssueReferenceHref(href: string): { identifier: string } | null {
  const raw = href.trim();
  if (!raw) return null;

  let url: URL;
  try {
    url = raw.startsWith("/")
      ? new URL(raw, "https://paperclip.invalid")
      : new URL(raw);
  } catch {
    return null;
  }

  const segments = url.pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);

  for (let index = 0; index < segments.length - 1; index += 1) {
    if (segments[index]?.toLowerCase() !== "issues") continue;
    const identifier = normalizeIssueIdentifier(segments[index + 1] ?? "");
    if (identifier) {
      return { identifier };
    }
  }

  return null;
}

export function findIssueReferenceMatches(text: string): IssueReferenceMatch[] {
  if (!text) return [];

  const matches: IssueReferenceMatch[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(ISSUE_REFERENCE_TOKEN_RE);

  while ((match = re.exec(text)) !== null) {
    const rawToken = match[0];
    const cleanedToken = trimTrailingPunctuation(rawToken);
    if (!cleanedToken) continue;

    const identifier =
      normalizeIssueIdentifier(cleanedToken)
      ?? parseIssueReferenceHref(cleanedToken)?.identifier
      ?? null;

    if (!identifier) continue;

    const cleanedIndex = match.index;
    matches.push({
      index: cleanedIndex,
      length: cleanedToken.length,
      identifier,
      matchedText: cleanedToken,
    });
  }

  return matches;
}

export function extractIssueReferenceIdentifiers(markdown: string): string[] {
  const scrubbed = stripMarkdownCode(markdown);
  const seen = new Set<string>();
  const ordered: string[] = [];

  for (const match of findIssueReferenceMatches(scrubbed)) {
    if (seen.has(match.identifier)) continue;
    seen.add(match.identifier);
    ordered.push(match.identifier);
  }

  return ordered;
}

export function extractIssueReferenceMatches(markdown: string): IssueReferenceMatch[] {
  const scrubbed = stripMarkdownCode(markdown);
  const seen = new Set<string>();
  const ordered: IssueReferenceMatch[] = [];

  for (const match of findIssueReferenceMatches(scrubbed)) {
    if (seen.has(match.identifier)) continue;
    seen.add(match.identifier);
    ordered.push(match);
  }

  return ordered;
}
