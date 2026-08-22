/**
 * /proc-based loopback listener ownership check (PAP-17050 verdict req #2).
 *
 * Immediately before a mutation the broker proves the target port has a
 * listener that is (a) loopback-only — not a wildcard/IPv6-wildcard/dual-stack
 * bind reachable off-loopback — and (b) owned by the expected managed-runtime
 * UID. A mere caller assertion or health response is insufficient.
 *
 * Pure parsing helpers are exported for tests; `createProcListenerVerifier`
 * wires them to the live /proc filesystem.
 */
import { readFileSync } from "node:fs";
import type { ListenerOwnership } from "./broker-core.js";

export interface ProcListenerRow {
  localAddressHex: string;
  localPortHex: string;
  state: string;
  uid: number;
  inode: string;
}

const TCP_STATE_LISTEN = "0A";

/** Parse one `/proc/net/tcp{,6}` table into structured listening rows. */
export function parseProcNetTable(content: string): ProcListenerRow[] {
  const rows: ProcListenerRow[] = [];
  const lines = content.split("\n").slice(1); // drop header
  for (const line of lines) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 10) continue;
    const [local, , stateHex] = [cols[1], cols[2], cols[3]];
    const uid = Number.parseInt(cols[7], 10);
    const inode = cols[9];
    const [addr, port] = local.split(":");
    rows.push({ localAddressHex: addr, localPortHex: port, state: stateHex, uid, inode });
  }
  return rows;
}

/** True when a hex IPv4 address is loopback (127.0.0.0/8). */
export function isLoopbackIpv4Hex(addrHex: string): boolean {
  // /proc stores little-endian; low byte is the last pair.
  if (addrHex.length !== 8) return false;
  const b0 = parseInt(addrHex.slice(6, 8), 16); // first octet
  return b0 === 127;
}

/**
 * `/proc/net/tcp6` rendering of ::1. Like the IPv4 table, the address is stored
 * as 32-bit words in host (little-endian) byte order, so the final word 0x00000001
 * is byte-swapped to "01000000" — NOT the big-endian "...0001". Matching the
 * wrong endianness would misclassify a real loopback listener.
 */
const LOOPBACK_IPV6_PROC_HEX = "00000000000000000000000001000000";

/** True when a hex IPv6 address is ::1 loopback (in /proc little-endian form). */
export function isLoopbackIpv6Hex(addrHex: string): boolean {
  return addrHex.toUpperCase() === LOOPBACK_IPV6_PROC_HEX;
}

/** True for wildcard binds (0.0.0.0 / ::) that are reachable off-loopback. */
export function isWildcardHex(addrHex: string): boolean {
  return /^0+$/.test(addrHex);
}

export interface ListenerFacts {
  present: boolean;
  loopbackOnly: boolean;
  uids: number[];
  /**
   * Socket inodes of the matching listening sockets, sorted. The inode names
   * *this* socket, not merely "something on this port", so comparing two
   * snapshots detects a listener that was closed and replaced by another
   * process between the two reads. UID equality cannot do that: a different
   * process under the same runtime UID satisfies `ownerUidMatches`.
   */
  inodes: string[];
}

/**
 * Reduce the two /proc tables to facts about listeners on `port`. A wildcard or
 * IPv6-wildcard bind anywhere on the port makes it NOT loopback-only.
 */
export function listenerFactsForPort(
  tcp: ProcListenerRow[],
  tcp6: ProcListenerRow[],
  port: number,
): ListenerFacts {
  const wantHex = port.toString(16).toUpperCase().padStart(4, "0");
  const uids: number[] = [];
  const inodes: string[] = [];
  let present = false;
  let loopbackOnly = true;
  for (const row of tcp) {
    if (row.localPortHex.toUpperCase() !== wantHex || row.state !== TCP_STATE_LISTEN) continue;
    present = true;
    uids.push(row.uid);
    inodes.push(row.inode);
    if (isWildcardHex(row.localAddressHex) || !isLoopbackIpv4Hex(row.localAddressHex)) {
      loopbackOnly = false;
    }
  }
  for (const row of tcp6) {
    if (row.localPortHex.toUpperCase() !== wantHex || row.state !== TCP_STATE_LISTEN) continue;
    present = true;
    uids.push(row.uid);
    inodes.push(row.inode);
    if (isWildcardHex(row.localAddressHex) || !isLoopbackIpv6Hex(row.localAddressHex)) {
      loopbackOnly = false;
    }
  }
  return { present, loopbackOnly, uids, inodes: [...inodes].sort() };
}

/**
 * Build a live verifier bound to the expected managed-runtime UID. Reads
 * /proc/net/tcp and tcp6 fresh on every call (immediately before mutation).
 */
export function createProcListenerVerifier(expectedUid: number) {
  return (port: number): ListenerOwnership => {
    let tcp: ProcListenerRow[] = [];
    let tcp6: ProcListenerRow[] = [];
    try {
      tcp = parseProcNetTable(readFileSync("/proc/net/tcp", "utf8"));
    } catch {
      /* leave empty -> present:false -> fail closed */
    }
    try {
      tcp6 = parseProcNetTable(readFileSync("/proc/net/tcp6", "utf8"));
    } catch {
      /* optional */
    }
    const facts = listenerFactsForPort(tcp, tcp6, port);
    return {
      present: facts.present,
      loopbackOnly: facts.loopbackOnly,
      ownerUidMatches: facts.present && facts.uids.every((uid) => uid === expectedUid),
      inodes: facts.inodes,
    };
  };
}
