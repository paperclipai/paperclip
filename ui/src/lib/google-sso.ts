/**
 * Validate a `return_to` / `successRedirectUrl` value before it is passed to
 * an OAuth flow. Only a single leading-slash relative path is accepted.
 *
 * Rejects:
 * - protocol-relative URLs (`//evil.com`)
 * - backslash-leading or backslash-containing paths (`\evil.com`, `/a\b`)
 * - protocol-relative-with-colon (`:evil.com`, `:/x`)
 * - `javascript:` and `data:` URI schemes
 * - any absolute URL (http://, https://, or any other scheme)
 * - empty strings and whitespace-only values
 *
 * Returns the cleaned path when valid, or `null` when rejected.
 */
export function isSafeReturnTo(value: string | null | undefined): string | null {
  if (value == null || value.trim().length === 0) return null;

  const trimmed = value.trim();

  // Reject protocol-relative (//) and any value starting with a colon
  // (which would be a scheme-less URL like ://evil.com or ://...)
  if (trimmed.startsWith("//") || trimmed.startsWith(":")) return null;

  // Reject backslash-leading or containing a backslash (Windows path / obfuscation)
  if (trimmed.startsWith("\\") || trimmed.includes("\\")) return null;

  // Reject known dangerous schemes
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("javascript:") || lower.startsWith("data:")) return null;

  // Reject absolute URLs (any scheme, e.g. https://, http://, etc.)
  // A relative path starting with "/" and NOT "//" is already validated above.
  // If it doesn't start with "/", it's not a valid return path.
  if (!trimmed.startsWith("/")) return null;

  // Single leading "/" already confirmed; "//" already rejected above.
  return trimmed;
}
