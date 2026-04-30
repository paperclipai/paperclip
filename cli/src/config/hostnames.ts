const PRIVATE_IP_RE =
  /^(127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|::1$|fc[\da-f]{2}:|fd[\da-f]{2}:)/i;

export function normalizeHostnameInput(raw: string): string {
  // Reject null bytes and URL-encoded null bytes (SSRF bypass via null-byte injection)
  if (raw.includes("\0") || raw.toLowerCase().includes("%00")) {
    throw new Error(`Invalid hostname: ${raw}`);
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
    throw new Error(`Invalid hostname: ${raw}`);
  }

  // Reject non-ASCII characters (blocks unicode lookalike attacks)
  if (/[^\x00-\x7f]/.test(hostname)) {
    throw new Error(`Invalid hostname: ${raw}`);
  }

  // Reject private/loopback IP ranges (the WHATWG URL parser normalises decimal,
  // hex and octal IP notation to dotted-decimal, so this also covers those forms)
  if (PRIVATE_IP_RE.test(hostname)) {
    throw new Error(`Invalid hostname: ${raw}`);
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

