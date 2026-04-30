const PRIVATE_IP_RE =
  /^(127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|::1$|\[::1\]|fc[\da-f]{2}:|fd[\da-f]{2}:)/i;

// Hostnames that resolve to loopback or private addresses but are not IP literals
// (the WHATWG URL parser returns these as-is, so the IP regex above cannot catch them)
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "0.0.0.0",
  "metadata.google.internal",
]);

/** Returns true if a WHATWG-normalised hostname is an IPv4-mapped-IPv6 private address.
 *  The WHATWG URL spec serialises [::ffff:a.b.c.d] as [::ffff:xxyy:zzww], so we parse
 *  the two 16-bit hex groups back to dotted-decimal and run them through PRIVATE_IP_RE.
 */
function isIpv4MappedPrivate(hostname: string): boolean {
  const m = hostname.match(/^\[::ffff:([\da-f]+):([\da-f]+)\]$/i);
  if (!m) return false;
  const hi = parseInt(m[1], 16);
  const lo = parseInt(m[2], 16);
  const dotted = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  return PRIVATE_IP_RE.test(dotted);
}

/** Strips control/non-printable characters from a string so it is safe to embed in
 *  error messages or log output (prevents log-injection via null bytes, etc.).
 */
function sanitizeForError(s: string): string {
  return s.replace(/[^\x20-\x7e]/g, "?").slice(0, 200);
}

export function normalizeHostnameInput(raw: string): string {
  // Reject null bytes and URL-encoded null bytes (SSRF bypass via null-byte injection).
  // Do NOT echo raw here — it may contain null bytes that corrupt logs.
  if (raw.includes("\0") || raw.toLowerCase().includes("%00")) {
    throw new Error("Invalid hostname: contains null byte");
  }

  const input = raw.trim();
  if (!input) {
    throw new Error("Hostname is required");
  }

  let hostname: string;
  try {
    const url = input.includes("://") ? new URL(input) : new URL(`http://${input}`);
    hostname = url.hostname.trim().toLowerCase();
    if (!hostname) throw new Error("empty");
  } catch {
    throw new Error(`Invalid hostname: ${sanitizeForError(raw)}`);
  }

  // Reject non-ASCII characters (blocks unicode lookalike attacks)
  if (/[^\x00-\x7f]/.test(hostname)) {
    throw new Error(`Invalid hostname: ${sanitizeForError(raw)}`);
  }

  // Reject well-known private/loopback hostnames that are not IP literals
  // (e.g. "localhost", "0.0.0.0") — these pass PRIVATE_IP_RE because they are
  // returned verbatim by the WHATWG URL parser and do not look like IP addresses.
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error(`Invalid hostname: ${sanitizeForError(raw)}`);
  }

  // Reject private/loopback IP ranges (the WHATWG URL parser normalises decimal,
  // hex and octal IP notation to dotted-decimal, so this also covers those forms)
  if (PRIVATE_IP_RE.test(hostname)) {
    throw new Error(`Invalid hostname: ${sanitizeForError(raw)}`);
  }

  // Reject IPv4-mapped IPv6 addresses that resolve to private ranges
  // (e.g. [::ffff:127.0.0.1] → normalised to [::ffff:7f00:1] by the URL parser)
  if (isIpv4MappedPrivate(hostname)) {
    throw new Error(`Invalid hostname: ${sanitizeForError(raw)}`);
  }

  return hostname;
}

export function parseHostnameCsv(raw: string): string[] {
  if (!raw.trim()) return [];
  const unique = new Set<string>();
  for (const part of raw.split(",")) {
    const hostname = normalizeHostnameInput(part);
    unique.add(hostname);
  }
  return Array.from(unique);
}
