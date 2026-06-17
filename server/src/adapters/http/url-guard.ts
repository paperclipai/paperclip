import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Returns true if an IP literal falls in a private, loopback, link-local or
 * otherwise reserved range that should never be reachable from an outbound
 * adapter request. Mirrors the logic in services/plugin-host-services.ts.
 */
function isPrivateIP(ip: string): boolean {
  const lower = ip.toLowerCase();

  // Unwrap IPv4-mapped IPv6 addresses (::ffff:x.x.x.x) and re-check as IPv4.
  const v4MappedMatch = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4MappedMatch && v4MappedMatch[1]) return isPrivateIP(v4MappedMatch[1]);

  // IPv4 ranges
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("172.")) {
    const second = parseInt(ip.split(".")[1] ?? "", 10);
    if (second >= 16 && second <= 31) return true;
  }
  if (ip.startsWith("192.168.")) return true;
  if (ip.startsWith("127.")) return true; // loopback
  if (ip.startsWith("169.254.")) return true; // link-local (incl. cloud metadata)
  if (ip === "0.0.0.0") return true;

  // IPv6 ranges
  if (lower === "::1") return true; // loopback
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local
  if (lower.startsWith("fe80")) return true; // link-local
  if (lower === "::") return true;

  return false;
}

/**
 * SSRF guard for outbound HTTP adapter requests.
 *
 * Enforces an http/https protocol allowlist and rejects URLs that target — or
 * whose hostname resolves to — a private, loopback, link-local or reserved
 * address (e.g. 127.0.0.1, 169.254.169.254, 10.0.0.0/8). This stops a company
 * member from pointing an HTTP agent at internal services or the cloud
 * metadata endpoint.
 *
 * Residual risk: this validates DNS at check time; the eventual connection
 * re-resolves DNS, so a determined attacker controlling DNS could still mount
 * a rebinding attack. Callers should additionally disable redirect following.
 * Full pinning lives in services/plugin-host-services.ts.
 */
export async function assertPublicHttpUrl(urlString: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error(`Invalid URL: ${urlString}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Disallowed protocol "${parsed.protocol}" — only http: and https: are permitted`);
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets

  // Literal IP target in a private/reserved range — reject without DNS.
  if (isIP(hostname) !== 0 && isPrivateIP(hostname)) {
    throw new Error(`Refusing to connect to private/reserved address ${hostname}`);
  }

  let results: Array<{ address: string }>;
  try {
    results = await lookup(hostname, { all: true });
  } catch (err) {
    throw new Error(`DNS resolution failed for ${hostname}: ${(err as Error).message}`);
  }

  if (results.length === 0) {
    throw new Error(`DNS resolution returned no results for ${hostname}`);
  }

  // Reject if ANY resolved address is private/reserved. Stricter than the
  // plugin guard (which filters) because an outbound adapter has no legitimate
  // reason to reach an internal host, and this blocks multi-record rebinding.
  if (results.some((entry) => isPrivateIP(entry.address))) {
    throw new Error(`Refusing to connect: ${hostname} resolves to a private/reserved address`);
  }
}
