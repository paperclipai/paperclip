import { lookup } from "node:dns/promises";
import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import { asString, asNumber, parseObject } from "../utils.js";

const BLOCKED_HOSTS = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "metadata.azure.internal",
]);

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d+$/.test(p))) return false;
  const [a, b] = [parseInt(parts[0], 10), parseInt(parts[1], 10)];
  if (a === 0 || a === 127) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "::1") return true;
  // fe80::/10 link-local
  if (normalized.startsWith("fe80:") || normalized.startsWith("fe80")) return true;
  // fc00::/7 unique-local (fc and fd prefixes)
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  // IPv4-mapped IPv6 (::ffff:x.x.x.x)
  const v4mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4mapped && isPrivateIPv4(v4mapped[1])) return true;
  // IPv4-mapped IPv6 hex form (::ffff:AABB:CCDD)
  const v4hex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (v4hex) {
    const hi = parseInt(v4hex[1], 16);
    const lo = parseInt(v4hex[2], 16);
    const mapped = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    if (isPrivateIPv4(mapped)) return true;
  }
  return false;
}

function isBlockedUrl(urlStr: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return true;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return true;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(hostname)) return true;
  if (hostname === "localhost") return true;
  if (isPrivateIPv4(hostname)) return true;
  if (isPrivateIPv6(hostname)) return true;

  return false;
}

async function isBlockedByDns(hostname: string): Promise<boolean> {
  try {
    const results = await lookup(hostname, { all: true });
    return results.some((r) =>
      r.family === 4 ? isPrivateIPv4(r.address) : isPrivateIPv6(r.address),
    );
  } catch {
    return false;
  }
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { config, runId, agent, context } = ctx;
  const url = asString(config.url, "");
  if (!url) throw new Error("HTTP adapter missing url");
  if (isBlockedUrl(url)) throw new Error(`HTTP adapter blocked request to ${url}: private or reserved address`);

  const parsedUrl = new URL(url);
  if (await isBlockedByDns(parsedUrl.hostname)) {
    throw new Error(`HTTP adapter blocked request to ${url}: hostname resolves to private address`);
  }

  const method = asString(config.method, "POST");
  const timeoutMs = asNumber(config.timeoutMs, 0);
  const headers = parseObject(config.headers) as Record<string, string>;
  const payloadTemplate = parseObject(config.payloadTemplate);
  const body = { ...payloadTemplate, agentId: agent.id, runId, context };

  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const res = await fetch(url, {
      method,
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
      redirect: "manual",
      ...(timer ? { signal: controller.signal } : {}),
    });

    if (!res.ok) {
      throw new Error(`HTTP invoke failed with status ${res.status}`);
    }

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: `HTTP ${method} ${url}`,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
