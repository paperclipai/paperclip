/**
 * Phase 4A-1 (LET-310): sandbox network policy metadata.
 *
 * Phase 4A-1 does not bind a real Docker network. The policy below is
 * recorded as lease metadata so future Phase 4A-2/3 surfaces can preview
 * what would be enforced. Defaults match the LET-307 boundary model:
 * deny-by-default egress, loopback-only, no inbound binding.
 */

export const SANDBOX_NETWORK_MODES = ["none", "egress_allowlist", "host_loopback"] as const;
export type SandboxNetworkMode = (typeof SANDBOX_NETWORK_MODES)[number];

export interface SandboxNetworkPolicy {
  mode: SandboxNetworkMode;
  egressAllowlist: ReadonlyArray<string>;
  dnsAllowlist: ReadonlyArray<string>;
  allowLoopback: boolean;
  allowInboundPorts: ReadonlyArray<number>;
}

export const DEFAULT_SANDBOX_NETWORK_POLICY: SandboxNetworkPolicy = Object.freeze({
  mode: "none",
  egressAllowlist: Object.freeze([]) as ReadonlyArray<string>,
  dnsAllowlist: Object.freeze([]) as ReadonlyArray<string>,
  allowLoopback: true,
  allowInboundPorts: Object.freeze([]) as ReadonlyArray<number>,
});

export class InvalidSandboxNetworkPolicyError extends Error {
  readonly code = "INVALID_SANDBOX_NETWORK_POLICY";
  constructor(
    readonly field: string,
    readonly reason: string,
  ) {
    super(`Invalid sandbox network policy ${field}: ${reason}`);
  }
}

const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

function parseHosts(field: string, hosts: unknown): string[] {
  if (hosts === undefined) return [];
  if (!Array.isArray(hosts)) {
    throw new InvalidSandboxNetworkPolicyError(field, "must_be_array");
  }
  const out: string[] = [];
  for (const value of hosts) {
    if (typeof value !== "string" || value.length === 0 || value.length > 253) {
      throw new InvalidSandboxNetworkPolicyError(field, "invalid_host_string");
    }
    if (!HOST_PATTERN.test(value)) {
      throw new InvalidSandboxNetworkPolicyError(field, "host_pattern");
    }
    out.push(value);
  }
  return out;
}

function parsePorts(field: string, ports: unknown): number[] {
  if (ports === undefined) return [];
  if (!Array.isArray(ports)) {
    throw new InvalidSandboxNetworkPolicyError(field, "must_be_array");
  }
  const out: number[] = [];
  for (const value of ports) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65_535) {
      throw new InvalidSandboxNetworkPolicyError(field, "invalid_port");
    }
    out.push(value);
  }
  return out;
}

export function parseSandboxNetworkPolicy(input: unknown): SandboxNetworkPolicy {
  if (input === undefined || input === null) {
    return DEFAULT_SANDBOX_NETWORK_POLICY;
  }
  if (typeof input !== "object") {
    throw new InvalidSandboxNetworkPolicyError("policy", "must_be_object");
  }
  const policy = input as Record<string, unknown>;
  const mode = policy.mode ?? DEFAULT_SANDBOX_NETWORK_POLICY.mode;
  if (typeof mode !== "string" || !SANDBOX_NETWORK_MODES.includes(mode as SandboxNetworkMode)) {
    throw new InvalidSandboxNetworkPolicyError("mode", "unknown_mode");
  }
  const allowLoopback =
    policy.allowLoopback === undefined
      ? DEFAULT_SANDBOX_NETWORK_POLICY.allowLoopback
      : Boolean(policy.allowLoopback);
  return {
    mode: mode as SandboxNetworkMode,
    egressAllowlist: parseHosts("egressAllowlist", policy.egressAllowlist),
    dnsAllowlist: parseHosts("dnsAllowlist", policy.dnsAllowlist),
    allowLoopback,
    allowInboundPorts: parsePorts("allowInboundPorts", policy.allowInboundPorts),
  };
}

export function networkPolicyToMetadata(policy: SandboxNetworkPolicy): Record<string, unknown> {
  return {
    mode: policy.mode,
    egressAllowlist: [...policy.egressAllowlist],
    dnsAllowlist: [...policy.dnsAllowlist],
    allowLoopback: policy.allowLoopback,
    allowInboundPorts: [...policy.allowInboundPorts],
  };
}
