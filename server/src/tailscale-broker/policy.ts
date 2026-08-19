/**
 * Deny-by-default policy for the Tailscale HTTPS broker.
 *
 * Encodes the invariants required by the threat-model verdict (PAP-17050):
 *   - `:443 -> 127.0.0.1:3100` is a protected, never-touched mapping.
 *   - Funnel, certificates, Services, reset/set-config, path handlers, arbitrary
 *     targets, privileged/reserved ports, non-loopback / wildcard / dual-stack
 *     backends, mismatched public/target ports, and unknown fields are all
 *     rejected before any CLI command is constructed.
 *   - Only same-number HTTPS-to-loopback mappings on a dedicated, allow-listed
 *     port range may be created or removed.
 *
 * Everything here is pure and side-effect free so it can be exhaustively tested
 * without root or a live Tailscale daemon.
 */

import { parsePort } from "./integers.js";

/** The primary Paperclip app route that must never be modified. */
export const PROTECTED_PRIMARY_PORT = 443;
export const PROTECTED_PRIMARY_TARGET = "http://127.0.0.1:3100";

/** Loopback hosts the broker will proxy to. Nothing else is permitted. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * Ports that are never eligible for exposure regardless of the configured range.
 * `:443` is the protected primary; the rest are common sensitive local services
 * that must not be republished to the tailnet even if a caller asks (SSRF, verdict #2).
 */
export const ALWAYS_DENIED_PORTS = new Set<number>([
  PROTECTED_PRIMARY_PORT,
  22, // ssh
  3100, // primary paperclip backend (already served on :443)
  5432, // postgres
  6379, // redis
]);

export interface BrokerPortPolicy {
  /** Inclusive lower bound of the dedicated Paperclip runtime exposure range. */
  minPort: number;
  /** Inclusive upper bound of the dedicated Paperclip runtime exposure range. */
  maxPort: number;
}

export const DEFAULT_PORT_POLICY: BrokerPortPolicy = {
  // Dedicated band for managed branch-runtime HTTPS listeners. Chosen to sit
  // above privileged/reserved ports and to comfortably contain both an app port
  // and its `+HMR_PORT_OFFSET` companion.
  minPort: 39_000,
  maxPort: 49_999,
};

export class PolicyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PolicyError";
    this.code = code;
  }
}

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

/**
 * Validate a requested public/target port for a same-number loopback exposure.
 * Returns the canonical port number or throws a {@link PolicyError}.
 */
export function assertExposablePort(
  rawPublicPort: unknown,
  rawTargetPort: unknown,
  policy: BrokerPortPolicy = DEFAULT_PORT_POLICY,
): number {
  const publicPort = parsePort(rawPublicPort);
  const targetPort = parsePort(rawTargetPort);
  if (publicPort !== targetPort) {
    throw new PolicyError(
      "port_mismatch",
      `public port ${publicPort} must equal target port ${targetPort} (same-number mappings only)`,
    );
  }
  if (publicPort < 1_024) {
    throw new PolicyError("privileged_port", `port ${publicPort} is privileged (<1024) and cannot be exposed`);
  }
  if (ALWAYS_DENIED_PORTS.has(publicPort)) {
    throw new PolicyError("reserved_port", `port ${publicPort} is reserved and cannot be exposed`);
  }
  if (publicPort < policy.minPort || publicPort > policy.maxPort) {
    throw new PolicyError(
      "port_out_of_range",
      `port ${publicPort} is outside the dedicated Paperclip range ${policy.minPort}-${policy.maxPort}`,
    );
  }
  return publicPort;
}

/**
 * Validate that a requested proxy target is a bare loopback origin whose port
 * matches the public port. Arbitrary targets, paths, query strings, non-http
 * schemes, hostnames, and non-loopback hosts are all rejected (SSRF, verdict #2).
 */
export function assertLoopbackTarget(target: string, expectedPort: number): void {
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    throw new PolicyError("bad_target", `target ${JSON.stringify(target)} is not a valid URL`);
  }
  if (parsed.protocol !== "http:") {
    throw new PolicyError("bad_target_scheme", `target scheme must be http:, got ${parsed.protocol}`);
  }
  if (!isLoopbackHost(parsed.hostname)) {
    throw new PolicyError("non_loopback_target", `target host ${parsed.hostname} is not loopback`);
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new PolicyError("path_handler_denied", `target must not include a path handler (${parsed.pathname})`);
  }
  if (parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new PolicyError("bad_target", "target must not include query, fragment, or credentials");
  }
  const port = Number(parsed.port);
  if (port !== expectedPort) {
    throw new PolicyError("target_port_mismatch", `target port ${parsed.port} must equal public port ${expectedPort}`);
  }
}

/**
 * Reject a listener address that is not strictly loopback-only. A backend bound
 * to a wildcard (`0.0.0.0` / `::`) or a routable address is reachable off
 * loopback and must never be exposed (verdict #2).
 */
export function assertLoopbackBindAddress(address: string): void {
  if (address === "0.0.0.0" || address === "::" || address === "*" || address === "0000:0000:0000:0000:0000:0000:0000:0000") {
    throw new PolicyError("wildcard_bind", `backend bind address ${address} is a wildcard and is not loopback-only`);
  }
  if (!isLoopbackHost(address)) {
    throw new PolicyError("non_loopback_bind", `backend bind address ${address} is not loopback`);
  }
}
