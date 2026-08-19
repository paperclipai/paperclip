/**
 * Loopback + owner verification of the backend listener before exposure.
 *
 * Requirement #2 (SSRF-equivalent publication of unrelated localhost services)
 * of the threat-model verdict. Before creating any HTTPS mapping the broker
 * confirms, against live kernel state, that the target port is bound *only* to
 * loopback and is owned by the expected runtime identity (a dedicated runtime
 * UID). A caller assertion or a successful health probe is explicitly not enough.
 */

import { readFile } from "node:fs/promises";

export interface ListenerBinding {
  host: string;
  port: number;
  /** Owning process UID, if resolvable. */
  uid: number | null;
  inode: string;
}

export interface ListenerInspector {
  /** Return every LISTEN binding on the given port (v4 + v6). Empty if none. */
  listBindingsForPort(port: number): Promise<ListenerBinding[]>;
}

export class ListenerOwnershipError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ListenerOwnershipError";
    this.code = code;
  }
}

const LOOPBACK_V4 = "127.0.0.1";
const LOOPBACK_V6 = "::1";

/**
 * Assert the port is bound, every binding is loopback-only, and (when a runtime
 * UID is configured) every binding is owned by it. Rejects wildcard (`0.0.0.0` /
 * `::`) and any off-loopback / dual-stack routable binding (verdict #2).
 */
export function assertLoopbackOwned(
  bindings: ListenerBinding[],
  expectedUid: number | null,
): void {
  if (bindings.length === 0) {
    throw new ListenerOwnershipError("no_listener", "no listener is bound to the requested port");
  }
  for (const b of bindings) {
    if (b.host === "0.0.0.0" || b.host === "::" || b.host === "*") {
      throw new ListenerOwnershipError("wildcard_listener", `port ${b.port} is bound to wildcard ${b.host}`);
    }
    if (b.host !== LOOPBACK_V4 && b.host !== LOOPBACK_V6) {
      throw new ListenerOwnershipError("non_loopback_listener", `port ${b.port} is bound to non-loopback ${b.host}`);
    }
    if (expectedUid !== null && b.uid !== null && b.uid !== expectedUid) {
      throw new ListenerOwnershipError(
        "owner_mismatch",
        `port ${b.port} listener owned by uid ${b.uid}, expected ${expectedUid}`,
      );
    }
  }
}

/** Parse a single /proc/net/tcp{,6} address field ("0100007F:1F91") → host/port. */
export function parseProcAddress(hexAddr: string): { host: string; port: number } {
  const [addrHex, portHex] = hexAddr.split(":");
  const port = parseInt(portHex, 16);
  if (addrHex.length === 8) {
    // IPv4, little-endian bytes.
    const bytes = [
      parseInt(addrHex.slice(6, 8), 16),
      parseInt(addrHex.slice(4, 6), 16),
      parseInt(addrHex.slice(2, 4), 16),
      parseInt(addrHex.slice(0, 2), 16),
    ];
    return { host: bytes.join("."), port };
  }
  // IPv6: 32 hex chars, little-endian per 32-bit word. Only loopback/wildcard
  // matter for our checks, so normalize those two and otherwise return the raw hex.
  if (/^0{31}1$/i.test(addrHex.split("").reverse().join(""))) {
    // best-effort; real detection handled by the two canonical constants below.
  }
  const lower = addrHex.toLowerCase();
  if (lower === "00000000000000000000000001000000") return { host: "::1", port };
  if (lower === "00000000000000000000000000000000") return { host: "::", port };
  return { host: `ipv6:${lower}`, port };
}

const LISTEN_STATE = "0A"; // TCP_LISTEN in /proc/net/tcp

async function readProcNetTcp(file: string, port: number, out: ListenerBinding[]): Promise<void> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return;
  }
  const lines = text.split("\n").slice(1);
  for (const line of lines) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 10) continue;
    if (cols[3] !== LISTEN_STATE) continue;
    const { host, port: p } = parseProcAddress(cols[1]);
    if (p !== port) continue;
    const uidNum = Number(cols[7]);
    out.push({ host, port: p, uid: Number.isFinite(uidNum) ? uidNum : null, inode: cols[9] ?? "" });
  }
}

/** Real /proc-backed inspector for Linux hosts. */
export function createProcListenerInspector(): ListenerInspector {
  return {
    async listBindingsForPort(port: number): Promise<ListenerBinding[]> {
      const out: ListenerBinding[] = [];
      await readProcNetTcp("/proc/net/tcp", port, out);
      await readProcNetTcp("/proc/net/tcp6", port, out);
      return out;
    },
  };
}
