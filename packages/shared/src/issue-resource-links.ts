import type { IssueWorkProductReviewState, IssueWorkProductType } from "./types/work-product.js";

export type IssueResourceReferenceKind = "issue_document" | "work_product";

export interface IssueResourceReferenceBase {
  kind: IssueResourceReferenceKind;
  href: string;
  issueId: string;
  issueIdentifier: string | null;
  issueTitle: string | null;
}

export interface IssueDocumentReference extends IssueResourceReferenceBase {
  kind: "issue_document";
  documentKey: string;
  documentTitle: string | null;
  latestRevisionNumber: number | null;
}

export interface IssueWorkProductReference extends IssueResourceReferenceBase {
  kind: "work_product";
  workProductId: string;
  workProductTitle: string;
  workProductType: IssueWorkProductType | string;
  workProductStatus: string;
  reviewState: IssueWorkProductReviewState;
}

export type IssueResourceReference = IssueDocumentReference | IssueWorkProductReference;

export interface ExtractedIssueResourceLink {
  href: string;
  issuePathId: string | null;
  target:
    | {
      kind: "issue_document";
      documentKey: string;
    }
    | {
      kind: "work_product";
      workProductId: string;
    };
}

function decodePart(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeHrefPath(href: string) {
  const trimmed = href.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed, "https://paperclip.local");
    return {
      pathname: parsed.pathname,
      hash: parsed.hash,
    };
  } catch {
    return null;
  }
}

function parseIssuePathId(pathname: string) {
  const segments = pathname.split("/").filter(Boolean);
  const issueIndex = segments.findIndex((segment) => segment === "issues");
  if (issueIndex === -1 || issueIndex === segments.length - 1) return null;
  return decodePart(segments[issueIndex + 1] ?? "") || null;
}

function parseHashTarget(hash: string) {
  const normalized = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!normalized) return null;
  if (normalized.startsWith("document-")) {
    const documentKey = decodePart(normalized.slice("document-".length)).trim();
    return documentKey
      ? { kind: "issue_document" as const, documentKey }
      : null;
  }
  if (normalized.startsWith("work-product-")) {
    const workProductId = decodePart(normalized.slice("work-product-".length)).trim();
    return workProductId
      ? { kind: "work_product" as const, workProductId }
      : null;
  }
  return null;
}

const ISSUE_RESOURCE_LINK_RE = /(?:https?:\/\/[^\s<>()\]]+|\/[^\s<>()\]]+|#[A-Za-z0-9][^\s<>()\]]*)/g;

export function parseIssueResourceLink(
  href: string | null | undefined,
  options?: { fallbackIssuePathId?: string | null },
): ExtractedIssueResourceLink | null {
  if (!href) return null;
  const normalized = normalizeHrefPath(href);
  if (!normalized) return null;
  const target = parseHashTarget(normalized.hash);
  if (!target) return null;
  const issuePathId = parseIssuePathId(normalized.pathname) ?? options?.fallbackIssuePathId ?? null;
  if (!issuePathId) return null;
  return {
    href: href.trim(),
    issuePathId,
    target,
  };
}

export function extractIssueResourceLinks(
  text: string | null | undefined,
  options?: { fallbackIssuePathId?: string | null },
): ExtractedIssueResourceLink[] {
  if (!text) return [];
  const seen = new Set<string>();
  const matches = text.match(ISSUE_RESOURCE_LINK_RE) ?? [];
  const results: ExtractedIssueResourceLink[] = [];
  for (const token of matches) {
    const parsed = parseIssueResourceLink(token, options);
    if (!parsed) continue;
    const dedupeKey = `${parsed.issuePathId}:${parsed.target.kind}:${
      parsed.target.kind === "issue_document" ? parsed.target.documentKey : parsed.target.workProductId
    }:${parsed.href}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    results.push(parsed);
  }
  return results;
}
