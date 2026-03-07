/**
 * IP Whitelist Manager
 *
 * Manages the set of IPs / CIDR blocks that are permitted to reach the
 * trading VPS.  Provides:
 *   - Validation of individual addresses and CIDR blocks.
 *   - Membership testing (does this source IP pass the whitelist?).
 *   - Firewall rule generation for iptables and ufw so the VPS can be
 *     bootstrapped from the same config that the application uses.
 *
 * Threat model: only traffic originating from known, controlled IPs should
 * reach the Binance proxy endpoint.  This module makes that policy explicit
 * and machine-verifiable.
 */

import * as net from 'node:net';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WhitelistEntry {
  /** Human-readable label (e.g. "office-nat", "vps-egress"). */
  label: string;
  /** IPv4 / IPv6 address or CIDR block, e.g. "203.0.113.5" or "10.0.0.0/8". */
  cidr: string;
  /** Optional note about why this entry exists. */
  note?: string;
}

export interface WhitelistValidationResult {
  valid: boolean;
  errors: string[];
}

export interface FirewallRules {
  /** Raw iptables commands (IPv4). */
  iptables: string[];
  /** ufw allow commands. */
  ufw: string[];
  /** ip6tables commands (IPv6). */
  ip6tables: string[];
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** Return true if `s` is a plain IPv4 or IPv6 address (no prefix length). */
function isPlainIp(s: string): boolean {
  return net.isIP(s) !== 0;
}

/**
 * Return true if `s` is a valid CIDR block.
 * Accepts both IPv4 (e.g. "192.168.1.0/24") and IPv6 (e.g. "2001:db8::/32").
 */
function isCidr(s: string): boolean {
  const slashIdx = s.lastIndexOf('/');
  if (slashIdx === -1) return false;

  const ip = s.slice(0, slashIdx);
  const prefixStr = s.slice(slashIdx + 1);
  const prefix = parseInt(prefixStr, 10);

  if (isNaN(prefix) || prefixStr.trim() === '') return false;

  const ipVersion = net.isIP(ip);
  if (ipVersion === 4 && prefix >= 0 && prefix <= 32) return true;
  if (ipVersion === 6 && prefix >= 0 && prefix <= 128) return true;
  return false;
}

/** Validate a single CIDR / address string. */
export function validateCidr(value: string): WhitelistValidationResult {
  const errors: string[] = [];
  const trimmed = value.trim();

  if (!trimmed) {
    errors.push('Entry is empty');
    return { valid: false, errors };
  }

  if (!isPlainIp(trimmed) && !isCidr(trimmed)) {
    errors.push(`"${trimmed}" is not a valid IPv4/IPv6 address or CIDR block`);
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Membership testing
// ---------------------------------------------------------------------------

/**
 * Convert an IPv4 address string to a 32-bit unsigned integer.
 */
function ipv4ToInt(ip: string): number {
  return ip
    .split('.')
    .reduce((acc, octet) => (acc << 8) | parseInt(octet, 10), 0) >>> 0;
}

/**
 * Return true if `ip` falls within the given IPv4 CIDR block.
 */
function ipv4InCidr(ip: string, cidr: string): boolean {
  const parts = cidr.split('/');
  if (parts.length !== 2) return false;
  const [network, prefixStr] = parts as [string, string];
  const prefix = parseInt(prefixStr, 10);
  if (isNaN(prefix) || prefix < 0 || prefix > 32) return false;
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(network) & mask);
}

/**
 * Normalise an IPv6 address to its fully-expanded form using the Node.js
 * URL API (cheapest reliable approach without external deps).
 */
function normaliseIpv6(ip: string): string {
  try {
    // Wrapping in brackets lets URL parse it as a host.
    const url = new URL(`http://[${ip}]`);
    // url.hostname strips brackets.
    return url.hostname.slice(1, -1);
  } catch {
    return ip;
  }
}

/**
 * Return true if `ip` falls within the given IPv6 CIDR block.
 * Uses BigInt for correct 128-bit arithmetic.
 */
function ipv6InCidr(ip: string, cidr: string): boolean {
  const parts = cidr.split('/');
  if (parts.length !== 2) return false;
  const [network, prefixStr] = parts as [string, string];
  const prefixNum = parseInt(prefixStr, 10);
  if (isNaN(prefixNum) || prefixNum < 0 || prefixNum > 128) return false;
  const prefix = BigInt(prefixNum);

  const expand = (addr: string): bigint => {
    const norm = normaliseIpv6(addr).replace(/:/g, '');
    return BigInt('0x' + norm.padStart(32, '0'));
  };

  const mask = prefix === 0n ? 0n : (~0n << (128n - prefix)) & ((1n << 128n) - 1n);
  return (expand(ip) & mask) === (expand(network) & mask);
}

/**
 * Test whether `sourceIp` is permitted by the given whitelist entries.
 */
export function isIpAllowed(sourceIp: string, entries: WhitelistEntry[]): boolean {
  const ipVersion = net.isIP(sourceIp.trim());
  if (ipVersion === 0) return false; // Not a valid IP at all.

  for (const entry of entries) {
    const cidr = entry.cidr.trim();

    // Plain IP — exact match.
    if (isPlainIp(cidr)) {
      if (cidr === sourceIp.trim()) return true;
      continue;
    }

    // CIDR block.
    if (isCidr(cidr)) {
      const networkIp = cidr.split('/')[0];
      if (!networkIp) continue;
      const networkVersion = net.isIP(networkIp);
      if (networkVersion !== ipVersion) continue; // IPv4 vs IPv6 mismatch.

      if (ipVersion === 4 && ipv4InCidr(sourceIp.trim(), cidr)) return true;
      if (ipVersion === 6 && ipv6InCidr(sourceIp.trim(), cidr)) return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Firewall rule generation
// ---------------------------------------------------------------------------

/**
 * Generate iptables / ufw / ip6tables rules that allow only whitelisted IPs
 * to reach `port` (TCP) and drop everything else.
 *
 * The generated commands are idempotent-safe: they use INSERT (iptables) and
 * `ufw allow from ... to any port ...` forms that are safe to run repeatedly.
 */
export function generateFirewallRules(
  entries: WhitelistEntry[],
  port: number,
  chain = 'INPUT',
): FirewallRules {
  const iptables: string[] = [];
  const ip6tables: string[] = [];
  const ufw: string[] = [];

  for (const entry of entries) {
    const cidr = entry.cidr.trim();
    const comment = entry.label.replace(/[^a-zA-Z0-9_-]/g, '-');

    if (isPlainIp(cidr) || isCidr(cidr)) {
      const networkIp = isPlainIp(cidr) ? cidr : cidr.split('/')[0];
      if (!networkIp) continue;
      const version = net.isIP(networkIp);

      if (version === 4) {
        iptables.push(
          `iptables -I ${chain} -p tcp --dport ${port} -s ${cidr} -j ACCEPT -m comment --comment "av-whitelist-${comment}"`,
        );
        ufw.push(`ufw allow from ${cidr} to any port ${port} proto tcp comment "av-whitelist-${comment}"`);
      } else if (version === 6) {
        ip6tables.push(
          `ip6tables -I ${chain} -p tcp --dport ${port} -s ${cidr} -j ACCEPT -m comment --comment "av-whitelist-${comment}"`,
        );
        ufw.push(`ufw allow from ${cidr} to any port ${port} proto tcp comment "av-whitelist-${comment}"`);
      }
    }
  }

  // Default-deny rules go last (lowest priority in iptables INSERT order).
  iptables.push(
    `iptables -A ${chain} -p tcp --dport ${port} -j DROP -m comment --comment "av-whitelist-default-deny"`,
  );
  ip6tables.push(
    `ip6tables -A ${chain} -p tcp --dport ${port} -j DROP -m comment --comment "av-whitelist-default-deny"`,
  );
  ufw.push(`ufw deny ${port}/tcp comment "av-whitelist-default-deny"`);

  return { iptables, ufw, ip6tables };
}

// ---------------------------------------------------------------------------
// IpWhitelistManager
// ---------------------------------------------------------------------------

export class IpWhitelistManager {
  private entries: WhitelistEntry[];

  constructor(entries: WhitelistEntry[] = []) {
    this.entries = entries;
  }

  /** Add a new entry, validating first. Throws on invalid input. */
  add(entry: WhitelistEntry): void {
    const result = validateCidr(entry.cidr);
    if (!result.valid) {
      throw new Error(`Invalid whitelist entry "${entry.cidr}": ${result.errors.join('; ')}`);
    }
    this.entries.push(entry);
  }

  /** Remove all entries matching `label`. */
  remove(label: string): void {
    this.entries = this.entries.filter(e => e.label !== label);
  }

  /** Return all entries. */
  getEntries(): Readonly<WhitelistEntry[]> {
    return this.entries;
  }

  /** Test whether `sourceIp` is allowed by the current whitelist. */
  isAllowed(sourceIp: string): boolean {
    return isIpAllowed(sourceIp, this.entries);
  }

  /**
   * Assert that `sourceIp` is whitelisted. Throws if it is not.
   * Use this as a guard at trade-execution entry points.
   */
  assertAllowed(sourceIp: string): void {
    if (!this.isAllowed(sourceIp)) {
      throw new Error(
        `Blocked: source IP ${sourceIp} is not in the trading whitelist. ` +
        'Update the whitelist configuration and restart the service.',
      );
    }
  }

  /** Validate every entry and return aggregated errors. */
  validate(): WhitelistValidationResult {
    const errors: string[] = [];
    for (const entry of this.entries) {
      const r = validateCidr(entry.cidr);
      if (!r.valid) {
        errors.push(`[${entry.label}] ${r.errors.join('; ')}`);
      }
    }
    return { valid: errors.length === 0, errors };
  }

  /** Generate firewall rules for a given port. */
  generateRules(port: number, chain?: string): FirewallRules {
    return generateFirewallRules(this.entries, port, chain);
  }
}
