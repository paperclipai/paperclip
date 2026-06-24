import { resolve4, reverse } from "node:dns/promises";
import type { MailReverseDnsStatus } from "@paperclipai/shared";

const CACHE_TTL_MS = 60_000;

// Reverse DNS is instance-level (one sending IP for the whole deployment), so the
// result is the same for every company; a single in-process cache is enough.
let cache: { status: MailReverseDnsStatus; at: number } | null = null;

function env(name: string): string {
  return process.env[name]?.trim() || "";
}

/** The IP the mail engine sends from: explicit override, else the HELO host's A record. */
async function resolveSendingIp(hostname: string): Promise<string | null> {
  const override = env("MAIL_PUBLIC_IP");
  if (override) return override;
  const ips = await resolve4(hostname).catch(() => [] as string[]);
  return ips[0] ?? null;
}

async function compute(): Promise<MailReverseDnsStatus> {
  const checkedAt = new Date().toISOString();
  const hostname = env("MAIL_HOSTNAME") || null;
  const base = { hostname, ip: null, ptr: null, fcrdns: false, matchesHostname: false, checkedAt };

  if (!hostname) {
    return {
      ...base,
      status: "unconfigured",
      message:
        "Set MAIL_HOSTNAME on the server and attach a domain so the mail engine can announce itself.",
    };
  }

  const ip = await resolveSendingIp(hostname);
  if (!ip) {
    return {
      ...base,
      status: "error",
      message: `Could not resolve a sending IP for ${hostname}. Check its A record, or set MAIL_PUBLIC_IP.`,
    };
  }

  const ptrs = await reverse(ip).catch(() => [] as string[]);
  if (ptrs.length === 0) {
    return {
      ...base,
      ip,
      status: "missing",
      message: `${ip} has no reverse DNS. Set its PTR to ${hostname} in your host's manager (on OVH: VPS, then IP, then Reverse DNS).`,
    };
  }

  const want = hostname.replace(/\.$/, "").toLowerCase();
  const normalized = ptrs.map((p) => p.replace(/\.$/, "").toLowerCase());
  const matchesHostname = normalized.includes(want);
  const ptr = matchesHostname ? want : normalized[0];

  // FCrDNS: the PTR name must forward-resolve back to the same IP.
  const forward = await resolve4(ptr).catch(() => [] as string[]);
  const fcrdns = forward.includes(ip);

  if (matchesHostname && fcrdns) {
    return {
      ...base,
      ip,
      ptr,
      fcrdns: true,
      matchesHostname: true,
      status: "ok",
      message: `Reverse DNS is correct: ${ip} points to ${hostname} and forward-confirms.`,
    };
  }

  const reason = !matchesHostname
    ? `the PTR is ${ptr}, not ${hostname}`
    : `${hostname} does not resolve back to ${ip}`;
  return {
    ...base,
    ip,
    ptr,
    fcrdns,
    matchesHostname,
    status: "mismatch",
    message: `Reverse DNS does not match: ${reason}. Set the PTR of ${ip} to ${hostname} in your host's manager.`,
  };
}

/**
 * Reverse-DNS (PTR) health for the mail engine's sending IP. The PTR is owned by
 * the host provider (its `in-addr.arpa` zone), not Cloudflare, so it cannot be
 * published from Atelier; this only inspects and reports its state. Cached for a
 * minute to avoid hammering the resolver from the dashboard.
 */
export function mailDiagnosticsService() {
  return {
    getReverseDnsStatus: async (force = false): Promise<MailReverseDnsStatus> => {
      const now = Date.now();
      if (!force && cache && now - cache.at < CACHE_TTL_MS) return cache.status;
      const status = await compute();
      cache = { status, at: now };
      return status;
    },
  };
}
