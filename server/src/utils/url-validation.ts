import { URL } from "node:url";
import dns from "node:dns/promises";
import net from "node:net";

const BLOCKED_IP_RANGES = [
  { prefix: "127.", label: "loopback" },
  { prefix: "10.", label: "private" },
  { prefix: "192.168.", label: "private" },
  { prefix: "169.254.", label: "link-local" },
  { prefix: "0.", label: "unspecified" },
];

function isBlockedIPv4(ip: string): boolean {
  if (BLOCKED_IP_RANGES.some((r) => ip.startsWith(r.prefix))) return true;
  // 172.16.0.0/12
  if (ip.startsWith("172.")) {
    const second = parseInt(ip.split(".")[1], 10);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

export function isBlockedIP(ip: string): boolean {
  if (net.isIPv4(ip)) return isBlockedIPv4(ip);
  if (net.isIPv6(ip)) {
    // Block loopback, link-local, unique local
    if (ip === "::1" || ip === "::") return true;
    const lower = ip.toLowerCase();
    if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
    // IPv4-mapped IPv6
    if (lower.startsWith("::ffff:")) {
      const v4 = lower.slice(7);
      if (net.isIPv4(v4)) return isBlockedIPv4(v4);
    }
  }
  return false;
}

export async function validateUrlNotInternal(url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `URL scheme "${parsed.protocol}" is not allowed. Only http and https are permitted.`,
    );
  }
  // Strip brackets from IPv6 addresses (URL.hostname includes them)
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  // Check if hostname is already an IP
  if (net.isIP(hostname)) {
    if (isBlockedIP(hostname)) {
      throw new Error(
        `Request to private/internal IP address ${hostname} is not allowed.`,
      );
    }
    return;
  }
  // Resolve DNS and check
  const addresses = await dns.resolve4(hostname).catch(() => [] as string[]);
  const addresses6 = await dns.resolve6(hostname).catch(() => [] as string[]);
  const all = [...addresses, ...addresses6];
  if (all.length === 0) {
    throw new Error(`Could not resolve hostname: ${hostname}`);
  }
  for (const addr of all) {
    if (isBlockedIP(addr)) {
      throw new Error(
        `Hostname ${hostname} resolves to private/internal IP ${addr}. Request blocked.`,
      );
    }
  }
}
