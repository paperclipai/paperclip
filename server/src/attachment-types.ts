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
export const DEFAULT_ALLOWED_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
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
  // Provider APIs commonly return a complete Content-Type header value (for
  // example Discord uses `text/plain; charset=utf-8`) while Paperclip's
  // allowlist and persisted asset metadata operate on the MIME essence. MIME
  // parameters do not change the media type, so normalize them away before
  // enforcing the allowlist. Invalid/empty essences still fail closed to the
  // generic binary type.
  const normalized = (contentType ?? "").split(";", 1)[0]!.trim().toLowerCase();
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
 * Structural well-formedness alone isn't proof: every byte sequence a
 * single-byte legacy encoding (Windows-1252, Latin-1) can produce in the
 * 0x80-0xFF range can *also* form a structurally valid multi-byte UTF-8
 * sequence, and that holds for any sequence length - not just the 2-byte
 * Latin-1 Supplement case (`C2 A9` is valid UTF-8 for "©" and valid
 * Windows-1252 for "Â©"), but 3-byte sequences too (`E2 82 AC`, the UTF-8
 * encoding of "€", is also valid Windows-1252 for "â‚¬" - three unrelated
 * legacy characters). A single non-ASCII code point, however many bytes it
 * spans, is therefore never reliable evidence on its own. What makes a
 * coincidence implausible is *repetition* of *distinct* code points: each
 * additional, independent non-ASCII code point multiplies the odds against
 * chance alignment, so we require at least two distinct ones (real UTF-8
 * text using accents, CJK, emoji, etc. naturally has many; a legacy-encoded
 * document coincidentally producing two or more distinct well-formed
 * multi-byte sequences is negligible). Counting repeats of the *same* code
 * point is not enough evidence: a legacy document with the same digraph
 * repeated (e.g. Windows-1252 "Â©Â©", two repeats of the same two-byte
 * collision) would otherwise pass. Buffers with fewer than two distinct
 * non-ASCII code points are treated as unverified and left unlabeled,
 * matching this module's documented fallback of letting the browser sniff
 * the encoding itself.
 */
export function isValidUtf8Buffer(buffer: Buffer): boolean {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return false;
  }
  // Scan code points directly (rather than `text.match(/.../gu)`) so we can
  // stop as soon as two distinct non-ASCII code points are found, instead of
  // materializing every match into an array up front - important for large
  // (up to MAX_ATTACHMENT_BYTES) buffers of non-ASCII text.
  const distinctNonAscii = new Set<string>();
  for (const char of text) {
    if (char.codePointAt(0)! > 0x7f) {
      distinctNonAscii.add(char);
      if (distinctNonAscii.size >= 2) return true;
    }
  }
  return distinctNonAscii.size === 0;
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

/**
 * The one attachment size ceiling for this deployment. Every upload path —
 * assets, task attachments, cases, and company import — bounds itself by this
 * value, so an operator raises or lowers the limit in exactly one place.
 */
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

const ATTACHMENT_SIZE_UNITS: readonly string[] = ["KB", "MB", "GB"];

/**
 * Render a byte count the way a person reading an error message expects it:
 * 1024-based steps under the conventional consumer labels, at most one decimal
 * place, and no trailing ".0". The default cap renders as "10 MB" rather than
 * "10485760 bytes". Sub-kilobyte values stay in bytes so a tiny configured cap
 * does not collapse to "0 KB".
 */
export function formatAttachmentSize(bytes: number): string {
  // Defensive: the cap itself can never be negative or NaN (`Number(env) || default`
  // falls back on both), but never render "NaN bytes" at a user.
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 bytes";
  if (bytes < 1024) return bytes === 1 ? "1 byte" : `${bytes} bytes`;

  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < ATTACHMENT_SIZE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  // toFixed(1) then strip a trailing ".0": 10.5 -> "10.5", 10.0 -> "10".
  const rounded = value.toFixed(1).replace(/\.0$/, "");
  return `${rounded} ${ATTACHMENT_SIZE_UNITS[unitIndex]}`;
}
