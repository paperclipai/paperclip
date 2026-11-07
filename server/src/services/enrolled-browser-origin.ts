/**
 * Loopback spellings are interchangeable for reaching the same local server,
 * but a managed broker only accepts the exact origin this instance enrolled.
 * When a caller advertises a different loopback alias on the same scheme and
 * port, return the enrolled spelling so broker redirects stay on an approved
 * origin.
 *
 * Non-loopback origins, other ports, and origins that are not already enrolled
 * are returned unchanged.
 */
export function enrolledBrowserOrigin(
  value: string | null,
  enrolledOrigins: string[],
): string | null {
  if (!value) return value;
  const loopback = (url: URL) =>
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const exactOrigin = (url: URL) =>
    !url.username && !url.password && !url.search && !url.hash && url.pathname === "/";
  const current = new URL(value);
  if (!exactOrigin(current)) return value;
  if (!loopback(current) || enrolledOrigins.includes(current.origin)) return value;
  for (const candidate of enrolledOrigins) {
    const approved = new URL(candidate);
    if (loopback(approved) && approved.port === current.port && exactOrigin(approved))
      return approved.origin;
  }
  return value;
}
