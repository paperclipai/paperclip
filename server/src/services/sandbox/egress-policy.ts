/**
 * Phase 4A-3 (LET-323): sandbox egress proxy policy + decision evaluator.
 *
 * This module models the *intent* a future sandbox egress proxy would
 * receive (method, URL, host, protocol, headers) and produces a pure
 * `allow`/`deny` decision against a `SandboxNetworkPolicy`. It is
 * intentionally preview-only:
 *
 *   - The evaluator NEVER opens a socket, performs DNS, spawns a process,
 *     or otherwise reaches the network.
 *   - Every decision carries `previewOnly: true` so downstream consumers
 *     cannot mistake the result for traffic that has actually been routed.
 *   - The default policy is deny-by-default (mode `none`), matching the
 *     LET-307 boundary model. Allow paths require an explicit allowlist
 *     entry or loopback opt-in.
 *
 * Hosts that fall into the cloud-instance metadata range
 * (169.254.169.254 IMDSv1, 169.254.170.2 ECS task metadata, fd00:ec2::254)
 * are always denied regardless of the allowlist — these endpoints can leak
 * credentials and are a known sandbox-escape vector.
 */

import {
  DEFAULT_SANDBOX_NETWORK_POLICY,
  parseSandboxNetworkPolicy,
  type SandboxNetworkPolicy,
} from "./network-policy.js";

export const EGRESS_REASON_CODES = [
  "ALLOW_LOOPBACK",
  "ALLOW_HOST_ALLOWLISTED",
  "ALLOW_DNS_ALLOWLISTED",
  "DENY_NETWORK_MODE_NONE",
  "DENY_HOST_NOT_ALLOWLISTED",
  "DENY_LOOPBACK_DISABLED",
  "DENY_METADATA_SERVICE",
  "DENY_INVALID_TARGET",
  "DENY_PROTOCOL_UNSUPPORTED",
  "DENY_INBOUND_NOT_ALLOWED",
] as const;
export type EgressReasonCode = (typeof EGRESS_REASON_CODES)[number];

export const EGRESS_TARGET_CLASSIFICATIONS = [
  "loopback",
  "private_network",
  "public_internet",
  "metadata_service",
  "dns",
  "invalid",
] as const;
export type EgressTargetClassification = (typeof EGRESS_TARGET_CLASSIFICATIONS)[number];

export const EGRESS_PROTOCOLS = ["http", "https", "dns", "tcp", "other"] as const;
export type EgressProtocol = (typeof EGRESS_PROTOCOLS)[number];

export interface EgressIntent {
  /** HTTP method or transport-specific verb. Free-form; never trusted as code. */
  method: string;
  /** Full requested URL. Validated for shape, never fetched. */
  url: string;
  /** Optional header map. Values are scrubbed via the redaction pipeline. */
  headers?: Record<string, string>;
  /** Hint about the transport kind. Falls back to protocol classification. */
  targetKind?: "http" | "dns" | "tcp";
}

export interface EgressDecision {
  readonly previewOnly: true;
  readonly decision: "allow" | "deny";
  readonly reasonCode: EgressReasonCode;
  readonly classification: EgressTargetClassification;
  readonly protocol: EgressProtocol;
  readonly policyMode: SandboxNetworkPolicy["mode"];
  /** Allowlist entry that matched, if any. */
  readonly matchedAllowlistEntry: string | null;
  /** Decision is derived from policy alone — label kept consistent with LET-314 truth model. */
  readonly truth: "preview";
}

export class InvalidEgressIntentError extends Error {
  readonly code = "INVALID_EGRESS_INTENT";
  constructor(
    readonly field: string,
    readonly reason: string,
  ) {
    super(`Invalid egress intent ${field}: ${reason}`);
  }
}

const HTTP_METHOD_PATTERN = /^[A-Za-z]{1,16}$/;
const HOST_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * Cloud instance metadata endpoints. Always denied — even from an
 * allowlist — because these endpoints can leak credentials and are a
 * known sandbox-escape vector.
 */
const METADATA_HOSTS: ReadonlySet<string> = new Set([
  "169.254.169.254",
  "169.254.170.2",
  "fd00:ec2::254",
  "metadata.google.internal",
  "metadata",
]);

interface ParsedTarget {
  host: string;
  port: number | null;
  protocol: EgressProtocol;
}

function parseProtocol(rawProtocol: string): EgressProtocol {
  switch (rawProtocol.toLowerCase().replace(/:$/, "")) {
    case "http":
      return "http";
    case "https":
      return "https";
    case "dns":
      return "dns";
    case "tcp":
      return "tcp";
    default:
      return "other";
  }
}

function parseIntentTarget(intent: EgressIntent): ParsedTarget {
  if (typeof intent.url !== "string" || intent.url.length === 0) {
    throw new InvalidEgressIntentError("url", "missing");
  }
  if (intent.url.length > 2048) {
    throw new InvalidEgressIntentError("url", "too_long");
  }
  let parsed: URL;
  try {
    parsed = new URL(intent.url);
  } catch {
    throw new InvalidEgressIntentError("url", "unparseable");
  }
  // Node's URL parser preserves brackets around IPv6 literals
  // (e.g. "[fd00:ec2::254]"). Strip them here so downstream classification
  // (notably METADATA_HOSTS) sees a canonical, unwrapped host string.
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host.length === 0) {
    throw new InvalidEgressIntentError("url", "missing_host");
  }
  const portStr = parsed.port;
  let port: number | null = null;
  if (portStr) {
    const parsedPort = Number.parseInt(portStr, 10);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535) {
      throw new InvalidEgressIntentError("url", "invalid_port");
    }
    port = parsedPort;
  }
  return { host, port, protocol: parseProtocol(parsed.protocol) };
}

function isLoopbackHost(host: string): boolean {
  if (host === "localhost" || host === "ip6-localhost" || host === "ip6-loopback") return true;
  if (host === "::1" || host === "[::1]") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
}

function isPrivateIpv4(host: string): boolean {
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const octets = match.slice(1, 5).map((value) => Number.parseInt(value, 10));
  if (octets.some((value) => value < 0 || value > 255)) return false;
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 169 && b === 254) return true; // link-local (other than metadata)
  return false;
}

function isHostnameShape(host: string): boolean {
  // Strip surrounding [..] for IPv6 literals
  const cleaned = host.replace(/^\[|\]$/g, "");
  if (cleaned.length === 0 || cleaned.length > 253) return false;
  if (cleaned.includes(":")) {
    // Treat as IPv6 literal — accept if every group is hex digits
    const segments = cleaned.split(":");
    return segments.every((segment) => segment === "" || /^[0-9a-f]{1,4}$/i.test(segment));
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(cleaned)) {
    // IPv4
    return cleaned.split(".").every((part) => {
      const value = Number.parseInt(part, 10);
      return Number.isInteger(value) && value >= 0 && value <= 255;
    });
  }
  return cleaned
    .split(".")
    .every((label) => label.length > 0 && label.length <= 63 && HOST_LABEL_PATTERN.test(label));
}

function classifyHost(host: string): EgressTargetClassification {
  if (METADATA_HOSTS.has(host)) return "metadata_service";
  if (isLoopbackHost(host)) return "loopback";
  if (!isHostnameShape(host)) return "invalid";
  if (isPrivateIpv4(host)) return "private_network";
  // IPv6 ULA fc00::/7
  if (host.startsWith("fc") || host.startsWith("fd")) return "private_network";
  return "public_internet";
}

function suffixMatch(host: string, entry: string): boolean {
  const lowerHost = host.toLowerCase();
  const lowerEntry = entry.toLowerCase();
  if (lowerHost === lowerEntry) return true;
  return lowerHost.endsWith(`.${lowerEntry}`);
}

function findAllowlistEntry(host: string, allowlist: ReadonlyArray<string>): string | null {
  for (const entry of allowlist) {
    if (suffixMatch(host, entry)) return entry;
  }
  return null;
}

function validateMethod(method: unknown): string {
  if (typeof method !== "string" || method.length === 0) {
    throw new InvalidEgressIntentError("method", "missing");
  }
  if (!HTTP_METHOD_PATTERN.test(method)) {
    throw new InvalidEgressIntentError("method", "shape");
  }
  return method.toUpperCase();
}

/**
 * Pure egress decision evaluator. Does not perform any network or
 * filesystem activity. Always returns `previewOnly: true`.
 */
export function evaluateEgressIntent(
  rawIntent: EgressIntent,
  rawPolicy: SandboxNetworkPolicy | undefined = DEFAULT_SANDBOX_NETWORK_POLICY,
): EgressDecision {
  validateMethod(rawIntent.method);
  const policy = rawPolicy ?? DEFAULT_SANDBOX_NETWORK_POLICY;
  let target: ParsedTarget;
  try {
    target = parseIntentTarget(rawIntent);
  } catch (err) {
    if (err instanceof InvalidEgressIntentError) {
      return {
        previewOnly: true,
        decision: "deny",
        reasonCode: "DENY_INVALID_TARGET",
        classification: "invalid",
        protocol: "other",
        policyMode: policy.mode,
        matchedAllowlistEntry: null,
        truth: "preview",
      };
    }
    throw err;
  }
  const classification = classifyHost(target.host);

  // Metadata-service block trumps everything — even an allowlist.
  if (classification === "metadata_service") {
    return {
      previewOnly: true,
      decision: "deny",
      reasonCode: "DENY_METADATA_SERVICE",
      classification,
      protocol: target.protocol,
      policyMode: policy.mode,
      matchedAllowlistEntry: null,
      truth: "preview",
    };
  }

  if (classification === "invalid") {
    return {
      previewOnly: true,
      decision: "deny",
      reasonCode: "DENY_INVALID_TARGET",
      classification,
      protocol: target.protocol,
      policyMode: policy.mode,
      matchedAllowlistEntry: null,
      truth: "preview",
    };
  }

  if (
    target.protocol !== "http" &&
    target.protocol !== "https" &&
    target.protocol !== "dns" &&
    target.protocol !== "tcp"
  ) {
    return {
      previewOnly: true,
      decision: "deny",
      reasonCode: "DENY_PROTOCOL_UNSUPPORTED",
      classification,
      protocol: target.protocol,
      policyMode: policy.mode,
      matchedAllowlistEntry: null,
      truth: "preview",
    };
  }

  // DNS classification path: only allow under egress_allowlist mode, and
  // only if dnsAllowlist matches. mode=none and mode=host_loopback must
  // never allow a DNS lookup regardless of the dnsAllowlist contents —
  // the network-mode gate is the primary deny-by-default invariant.
  if (target.protocol === "dns" || rawIntent.targetKind === "dns") {
    if (policy.mode === "none") {
      return {
        previewOnly: true,
        decision: "deny",
        reasonCode: "DENY_NETWORK_MODE_NONE",
        classification: "dns",
        protocol: target.protocol,
        policyMode: policy.mode,
        matchedAllowlistEntry: null,
        truth: "preview",
      };
    }
    if (policy.mode === "host_loopback") {
      return {
        previewOnly: true,
        decision: "deny",
        reasonCode: "DENY_HOST_NOT_ALLOWLISTED",
        classification: "dns",
        protocol: target.protocol,
        policyMode: policy.mode,
        matchedAllowlistEntry: null,
        truth: "preview",
      };
    }
    const matched = findAllowlistEntry(target.host, policy.dnsAllowlist);
    if (matched) {
      return {
        previewOnly: true,
        decision: "allow",
        reasonCode: "ALLOW_DNS_ALLOWLISTED",
        classification: "dns",
        protocol: target.protocol,
        policyMode: policy.mode,
        matchedAllowlistEntry: matched,
        truth: "preview",
      };
    }
    return {
      previewOnly: true,
      decision: "deny",
      reasonCode: "DENY_HOST_NOT_ALLOWLISTED",
      classification: "dns",
      protocol: target.protocol,
      policyMode: policy.mode,
      matchedAllowlistEntry: null,
      truth: "preview",
    };
  }

  if (classification === "loopback") {
    if (policy.allowLoopback && (policy.mode === "host_loopback" || policy.mode === "egress_allowlist")) {
      return {
        previewOnly: true,
        decision: "allow",
        reasonCode: "ALLOW_LOOPBACK",
        classification,
        protocol: target.protocol,
        policyMode: policy.mode,
        matchedAllowlistEntry: null,
        truth: "preview",
      };
    }
    return {
      previewOnly: true,
      decision: "deny",
      reasonCode: policy.allowLoopback ? "DENY_NETWORK_MODE_NONE" : "DENY_LOOPBACK_DISABLED",
      classification,
      protocol: target.protocol,
      policyMode: policy.mode,
      matchedAllowlistEntry: null,
      truth: "preview",
    };
  }

  if (policy.mode === "none") {
    return {
      previewOnly: true,
      decision: "deny",
      reasonCode: "DENY_NETWORK_MODE_NONE",
      classification,
      protocol: target.protocol,
      policyMode: policy.mode,
      matchedAllowlistEntry: null,
      truth: "preview",
    };
  }

  if (policy.mode === "host_loopback") {
    // host_loopback only ever allows loopback targets.
    return {
      previewOnly: true,
      decision: "deny",
      reasonCode: "DENY_HOST_NOT_ALLOWLISTED",
      classification,
      protocol: target.protocol,
      policyMode: policy.mode,
      matchedAllowlistEntry: null,
      truth: "preview",
    };
  }

  // mode === "egress_allowlist"
  const matched = findAllowlistEntry(target.host, policy.egressAllowlist);
  if (matched) {
    return {
      previewOnly: true,
      decision: "allow",
      reasonCode: "ALLOW_HOST_ALLOWLISTED",
      classification,
      protocol: target.protocol,
      policyMode: policy.mode,
      matchedAllowlistEntry: matched,
      truth: "preview",
    };
  }
  return {
    previewOnly: true,
    decision: "deny",
    reasonCode: "DENY_HOST_NOT_ALLOWLISTED",
    classification,
    protocol: target.protocol,
    policyMode: policy.mode,
    matchedAllowlistEntry: null,
    truth: "preview",
  };
}

export const __testing = {
  classifyHost,
  parseIntentTarget,
  isLoopbackHost,
  isPrivateIpv4,
  parseSandboxNetworkPolicy,
};
