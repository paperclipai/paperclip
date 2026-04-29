/**
 * Shared attachment content-type configuration.
 *
 * By default a curated set of image/document/text types are allowed. Set the
 * `PAPERCLIP_ALLOWED_ATTACHMENT_TYPES` environment variable to a
 * comma-separated list of MIME types or wildcard patterns to expand the
 * allowed set for routes that use this allowlist.
 *
 * Examples:
 *   PAPERCLIP_ALLOWED_ATTACHMENT_TYPES=image/*,application/pdf
 *   PAPERCLIP_ALLOWED_ATTACHMENT_TYPES=image/*,application/pdf,text/*
 *
 * Supported pattern syntax:
 *   - Exact types:   "application/pdf"
 *   - Wildcards:     "image/*"  or  "application/vnd.openxmlformats-officedocument.*"
 */
import { MAX_COMPANY_ATTACHMENT_MAX_BYTES } from "@paperclipai/shared";

export const DEFAULT_ALLOWED_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/markdown",
  "text/plain",
  "application/json",
  "text/csv",
  "text/html",
];

export const DEFAULT_ATTACHMENT_CONTENT_TYPE = "application/octet-stream";
export const SVG_CONTENT_TYPE = "image/svg+xml";
export const INLINE_ATTACHMENT_TYPES: readonly string[] = [
  "image/*",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "application/json",
  "text/csv",
];

/**
 * Parse a comma-separated list of MIME type patterns into a normalised array.
 * Returns the default image-only list when the input is empty or undefined.
 */
export function parseAllowedTypes(raw: string | undefined): string[] {
  if (!raw) return [...DEFAULT_ALLOWED_TYPES];
  const parsed = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  return parsed.length > 0 ? parsed : [...DEFAULT_ALLOWED_TYPES];
}

/**
 * Check whether `contentType` matches any entry in `allowedPatterns`.
 *
 * Supports exact matches ("application/pdf") and wildcard / prefix
 * patterns ("image/*", "application/vnd.openxmlformats-officedocument.*").
 */
export function matchesContentType(contentType: string, allowedPatterns: string[]): boolean {
  const ct = contentType.toLowerCase();
  return allowedPatterns.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern.endsWith("/*") || pattern.endsWith(".*")) {
      return ct.startsWith(pattern.slice(0, -1));
    }
    return ct === pattern;
  });
}

export function normalizeContentType(contentType: string | null | undefined): string {
  const normalized = (contentType ?? "").trim().toLowerCase();
  return normalized || DEFAULT_ATTACHMENT_CONTENT_TYPE;
}

export function isInlineAttachmentContentType(contentType: string): boolean {
  return matchesContentType(contentType, [...INLINE_ATTACHMENT_TYPES]);
}

// ---------- Module-level singletons read once at startup ----------

const allowedPatterns: string[] = parseAllowedTypes(
  process.env.PAPERCLIP_ALLOWED_ATTACHMENT_TYPES,
);

/** Convenience wrapper using the process-level allowed list. */
export function isAllowedContentType(contentType: string): boolean {
  return matchesContentType(contentType, allowedPatterns);
}

export const MAX_ATTACHMENT_BYTES =
  Number(process.env.PAPERCLIP_ATTACHMENT_MAX_BYTES) || 10 * 1024 * 1024;

export function normalizeIssueAttachmentMaxBytes(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return MAX_ATTACHMENT_BYTES;
  }
  return Math.min(Math.floor(value), MAX_COMPANY_ATTACHMENT_MAX_BYTES, MAX_ATTACHMENT_BYTES);
}
