/**
 * Helpers for building a safe `Content-Disposition` header value.
 *
 * HTTP header field values are Latin-1 (RFC 7230 §3.2.4), so a raw UTF-8 filename
 * dropped into the ASCII `filename="..."` parameter is corrupted by browsers — Korean,
 * Japanese, Chinese, Arabic, emoji, etc. all mojibake. RFC 6266 / RFC 5987 require
 * non-ASCII names to travel in `filename*=UTF-8''<percent-encoded>` instead.
 *
 * A pure-ASCII name is already representable in the canonical `filename="..."` quoted-string
 * that every client understands, so we emit `filename*` ONLY when the name actually carries
 * non-ASCII octets (the case Latin-1 header encoding would corrupt). When it does, we emit
 * BOTH parameters:
 *   - `filename="<ascii-fallback>"` — for legacy clients that ignore `filename*`.
 *   - `filename*=UTF-8''<encoded>`  — preferred by conforming browsers (RFC 6266 §4.3).
 */

/**
 * Percent-encode a string for an RFC 5987 `ext-value` (the part after `UTF-8''`).
 *
 * `encodeURIComponent` already produces UTF-8 percent-encoding, but it leaves a few
 * characters unescaped (`! ' ( ) *`) that are NOT in RFC 5987's `attr-char` set, so we
 * encode those too. The result contains only `attr-char` and `pct-encoded` octets.
 */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*!]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/**
 * Build the `filename`/`filename*` parameter portion of a `Content-Disposition` header
 * for a possibly non-ASCII filename. Callers prepend the disposition type, e.g.
 * `inline; ${contentDispositionFilename(name)}`.
 *
 * @example
 *   contentDispositionFilename("한글.pdf")
 *   // => `filename="__.pdf"; filename*=UTF-8''%ED%95%9C%EA%B8%80.pdf`
 */
export function contentDispositionFilename(name: string): string {
  // ASCII fallback: collapse anything outside printable ASCII to `_`, then drop the two
  // characters that would break the quoted-string (`"` and `\`).
  const asciiFallback = name.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "");
  // Pure-ASCII names need only the canonical `filename="..."`; a redundant `filename*` would
  // diverge from the long-standing header contract callers assert against.
  if (!/[^\x20-\x7E]/.test(name)) {
    return `filename="${asciiFallback}"`;
  }
  return `filename="${asciiFallback}"; filename*=UTF-8''${encodeRfc5987(name)}`;
}
