/**
 * Helpers for building RFC 6266 / RFC 5987 compliant `Content-Disposition`
 * response headers.
 *
 * Node's `res.setHeader` rejects header values containing bytes outside the
 * Latin-1 range and throws `TypeError [ERR_INVALID_CHAR]`. Inlining a raw
 * UTF-8 filename such as `사업자등록증.xlsx` therefore turns attachment
 * downloads into HTTP 500s.
 *
 * RFC 6266 solves this by emitting an ASCII-only `filename="..."` fallback for
 * legacy clients plus a percent-encoded `filename*=UTF-8''...` parameter
 * (RFC 5987 ext-value) that modern clients prefer. Every byte of the resulting
 * header is then Latin-1 safe while non-ASCII names are preserved end to end.
 */

/**
 * Percent-encode a string as an RFC 5987 `ext-value` (the portion after
 * `UTF-8''`). `encodeURIComponent` leaves a handful of characters unescaped
 * that are not valid `attr-char`s (`'`, `(`, `)`, `*`), so those are encoded
 * explicitly. The `|`, `^` and `` ` `` characters are valid `attr-char`s and
 * are decoded back to keep the value compact and readable.
 */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value)
    .replace(
      /['()*]/g,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
    )
    .replace(/%(7C|60|5E)/gi, (_match, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
}

/**
 * Build the ASCII-only fallback used in the quoted `filename="..."` parameter.
 * Any non-printable or non-ASCII code point is replaced with `_`, and
 * characters that would break the quoted-string (`"` and `\`) are removed.
 * Falls back to `download` when nothing printable remains.
 */
function asciiFallbackFilename(filename: string): string {
  const fallback = filename
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "");
  return fallback.length > 0 ? fallback : "download";
}

/**
 * Build a safe `Content-Disposition` header value.
 *
 * @param disposition `"attachment"` or `"inline"`.
 * @param filename The original (possibly non-ASCII) filename.
 * @returns A header value whose every byte is Latin-1 safe. When `filename`
 *   contains characters the ASCII fallback could not represent verbatim, an
 *   RFC 5987 `filename*=UTF-8''...` parameter is appended.
 */
export function buildContentDisposition(
  disposition: "attachment" | "inline",
  filename: string | null | undefined,
): string {
  const name = filename && filename.length > 0 ? filename : "download";
  const fallback = asciiFallbackFilename(name);
  let value = `${disposition}; filename="${fallback}"`;
  if (fallback !== name) {
    value += `; filename*=UTF-8''${encodeRfc5987(name)}`;
  }
  return value;
}
