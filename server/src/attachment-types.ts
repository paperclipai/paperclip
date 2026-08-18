/**
 * Shared attachment content-type configuration.
 *
 * By default a curated set of image/document/text/media types are allowed. Set the
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
import {
  DEFAULT_COMPANY_ATTACHMENT_MAX_BYTES,
  MAX_COMPANY_ATTACHMENT_MAX_BYTES,
} from "@paperclipai/shared";

export const DEFAULT_ALLOWED_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "application/zip",
  "text/markdown",
  "text/plain",
  "application/json",
  "text/csv",
  "text/html",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-m4v",
];

export const DEFAULT_ATTACHMENT_CONTENT_TYPE = "application/octet-stream";
export const SVG_CONTENT_TYPE = "image/svg+xml";
export const GENERIC_ATTACHMENT_CONTENT_TYPES: readonly string[] = [
  "application/octet-stream",
  "binary/octet-stream",
  "application/x-binary",
];
export const INLINE_ATTACHMENT_TYPES: readonly string[] = [
  "image/*",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "application/json",
  "text/csv",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-m4v",
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

export function inferOfficeAttachmentContentTypeFromFilename(
  filename: string | null | undefined,
): string | null {
  const lower = (filename ?? "").trim().toLowerCase();
  if (lower.endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (lower.endsWith(".xlsx")) {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  if (lower.endsWith(".pptx")) {
    return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  }
  if (lower.endsWith(".doc")) return "application/msword";
  if (lower.endsWith(".xls")) return "application/vnd.ms-excel";
  if (lower.endsWith(".ppt")) return "application/vnd.ms-powerpoint";
  return null;
}

export function normalizeUploadAttachmentContentType(input: {
  contentType: string | null | undefined;
  originalFilename?: string | null;
  isAllowedContentType?: (contentType: string) => boolean;
}): string {
  const normalized = normalizeContentType(input.contentType);
  if (!GENERIC_ATTACHMENT_CONTENT_TYPES.includes(normalized)) return normalized;
  const inferred = inferOfficeAttachmentContentTypeFromFilename(input.originalFilename);
  if (!inferred) return normalized;
  if (input.isAllowedContentType && !input.isAllowedContentType(inferred)) return normalized;
  return inferred;
}

export function isInlineAttachmentContentType(contentType: string): boolean {
  return matchesContentType(contentType, [...INLINE_ATTACHMENT_TYPES]);
}

/**
 * Whether `contentType` is one of the textual MIME families (`text/*`,
 * `application/json`, `*+json`) that `withUtf8CharsetIfTextual` may label as
 * UTF-8.
 */
export function isTextualAttachmentContentType(contentType: string | null | undefined): boolean {
  const baseType = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  return baseType.startsWith("text/") || baseType === "application/json" || baseType.endsWith("+json");
}

/**
 * Whether `buffer` can be confidently identified as UTF-8. Upload/storage
 * paths accept arbitrary bytes for textual MIME types (no encoding is
 * enforced at write time), so callers must confirm the actual bytes are
 * UTF-8 before asserting `charset=utf-8` on a response - otherwise a
 * legacy-encoded upload (e.g. Latin-1, Shift-JIS) would be mislabeled and
 * mis-rendered by browsers.
 *
 * Structural well-formedness alone isn't proof: every byte pair a
 * single-byte legacy encoding (Windows-1252, Latin-1) can produce in the
 * 0x80-0xFF range is *also* a structurally valid 2-byte UTF-8 sequence
 * decoding to a Latin-1 Supplement code point (U+0080-U+00FF). For example
 * the bytes `C2 A9` are simultaneously well-formed UTF-8 for "©" (c)
 * and well-formed Windows-1252 for "Â©" (Ac) - `TextDecoder`
 * can't tell those apart. A 3-byte or 4-byte UTF-8 sequence can't arise by
 * chance from single-byte legacy text, so we only trust the decode once it
 * contains a code point outside that ambiguous collision range; buffers
 * whose only non-ASCII evidence sits in the Latin-1 Supplement range are
 * treated as unverified and left unlabeled, matching this module's
 * documented fallback of letting the browser sniff the encoding itself.
 */
export function isValidUtf8Buffer(buffer: Buffer): boolean {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return false;
  }
  const hasAmbiguousCodePoint = /[\u0080-\u00ff]/.test(text);
  if (!hasAmbiguousCodePoint) return true;
  // Some code point sits in the ambiguous Latin-1 Supplement range - only
  // trust the decode if the text also contains a code point beyond that
  // range, which can't be produced by chance from single-byte legacy text.
  return /[\u0100-\uffff]/.test(text) || /[\u{10000}-\u{10ffff}]/u.test(text);
}

/**
 * Append `; charset=utf-8` to textual content types (`text/*`, `application/json`,
 * `*+json`) that don't already declare a charset. Binary/media content types and
 * content types with an existing charset parameter are returned unchanged.
 *
 * Pass `validatedUtf8: false` when the underlying bytes have not been (or
 * cannot be) confirmed as valid UTF-8 - e.g. a partial range read, or a
 * buffer that failed `isValidUtf8Buffer` - to keep the content type unlabeled
 * so browsers fall back to their own encoding guess, same as before this
 * charset behavior existed.
 */
export function withUtf8CharsetIfTextual(
  contentType: string | null | undefined,
  options?: { validatedUtf8?: boolean },
): string {
  const trimmed = (contentType ?? "").trim();
  if (!trimmed) return trimmed;
  const [base, ...params] = trimmed.split(";");
  const baseType = base.trim().toLowerCase();
  const hasCharset = params.some((param) => param.trim().toLowerCase().startsWith("charset="));
  if (hasCharset) return trimmed;
  const isTextual = baseType.startsWith("text/") || baseType === "application/json" || baseType.endsWith("+json");
  if (!isTextual) return trimmed;
  if (options?.validatedUtf8 === false) return trimmed;
  return `${trimmed}; charset=utf-8`;
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

/**
 * Full-body UTF-8 validation requires buffering the whole object into memory
 * (see `isValidUtf8Buffer`). Reuse the upload-time size cap as the buffering
 * cap too, so a textual attachment can never force more than `MAX_ATTACHMENT_BYTES`
 * into memory on read - anything larger (or of unknown size) is served unlabeled
 * instead of buffered, matching the pre-existing streaming behavior for binary content.
 */
export function canBufferForUtf8Validation(knownSizeBytes: number | null | undefined): boolean {
  return (
    typeof knownSizeBytes === "number" &&
    Number.isFinite(knownSizeBytes) &&
    knownSizeBytes >= 0 &&
    knownSizeBytes <= MAX_ATTACHMENT_BYTES
  );
}

export function normalizeIssueAttachmentMaxBytes(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return Math.min(DEFAULT_COMPANY_ATTACHMENT_MAX_BYTES, MAX_ATTACHMENT_BYTES);
  }
  return Math.min(Math.floor(value), MAX_COMPANY_ATTACHMENT_MAX_BYTES, MAX_ATTACHMENT_BYTES);
}
