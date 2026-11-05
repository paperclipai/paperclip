/**
 * Root-owned ownership registry persisted atomically (PAP-17050 verdict #3).
 *
 * Writes go through temp-file + fsync + rename + directory fsync so a crash
 * never leaves a torn registry. The file must be mode 0600 in a root-owned,
 * non-writable parent directory; unsafe permissions make the broker refuse to
 * start (checked by the caller via `assertSafeRegistryPath`).
 */
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { BrokerRegistry, LeaseRecord } from "./types.js";

export function emptyRegistry(nodeIdentity: string): BrokerRegistry {
  return {
    version: 1,
    nodeIdentity,
    generationCounter: 0,
    leases: [],
    quarantinedPorts: [],
  };
}

export function loadRegistry(path: string, nodeIdentity: string): BrokerRegistry {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyRegistry(nodeIdentity);
    }
    throw error;
  }
  const parsed = JSON.parse(raw) as BrokerRegistry;
  if (parsed.version !== 1 || !Array.isArray(parsed.leases)) {
    throw new Error("registry is corrupt or of an unsupported version");
  }
  // Compatibility with the pre-reservation development build: an existing
  // lease necessarily represented an exposed mapping.
  parsed.leases = parsed.leases.map((lease) => ({
    ...lease,
    state: lease.state === "reserved" ? "reserved" : "exposed",
    expiresAtIso: typeof lease.expiresAtIso === "string" ? lease.expiresAtIso : null,
  }));
  parsed.quarantinedPorts = Array.isArray(parsed.quarantinedPorts) ? parsed.quarantinedPorts : [];
  return parsed;
}

/**
 * Persist the registry atomically. Temp file in the same directory (same fs),
 * fsync data, rename over the target, then fsync the directory so the rename is
 * durable.
 */
export function saveRegistry(path: string, registry: BrokerRegistry): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
  const fd = openSync(tmp, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  const dirFd = openSync(dir, "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

/**
 * Refuse to operate on a registry whose parent directory is group/world
 * writable or whose file (when present) is group/world accessible. Returns the
 * reason string when unsafe, or null when safe.
 */
export function registryPathUnsafeReason(path: string): string | null {
  const dir = dirname(path);
  let dirStat;
  try {
    dirStat = statSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if ((dirStat.mode & 0o022) !== 0) {
    return "registry parent directory is group/world writable";
  }
  try {
    const fileStat = statSync(path);
    if ((fileStat.mode & 0o077) !== 0) {
      return "registry file is group/world accessible";
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return null;
}

export function nextGeneration(registry: BrokerRegistry): number {
  registry.generationCounter += 1;
  return registry.generationCounter;
}

export function addLease(registry: BrokerRegistry, lease: LeaseRecord): void {
  registry.leases.push(lease);
}

export function removeLeaseByHandle(registry: BrokerRegistry, handle: string): LeaseRecord | null {
  const index = registry.leases.findIndex((lease) => lease.handle === handle);
  if (index < 0) return null;
  const [removed] = registry.leases.splice(index, 1);
  return removed;
}

/** Remove expired, never-exposed reservations and return their released ports. */
export function pruneExpiredReservations(registry: BrokerRegistry, nowIso: string): number[] {
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) return [];
  const released: number[] = [];
  registry.leases = registry.leases.filter((lease) => {
    if (lease.state !== "reserved" || !lease.expiresAtIso) return true;
    const expiresMs = Date.parse(lease.expiresAtIso);
    if (!Number.isFinite(expiresMs) || expiresMs > nowMs) return true;
    released.push(...lease.ports);
    return false;
  });
  return released;
}

export function isPortQuarantined(registry: BrokerRegistry, port: number): boolean {
  return registry.quarantinedPorts.includes(port);
}

export function quarantinePort(registry: BrokerRegistry, port: number): void {
  if (!registry.quarantinedPorts.includes(port)) {
    registry.quarantinedPorts.push(port);
  }
}

/** Ports the registry believes are actively owned by a live lease. */
export function ownedPorts(registry: BrokerRegistry): Set<number> {
  const ports = new Set<number>();
  for (const lease of registry.leases) {
    for (const port of lease.ports) ports.add(port);
  }
  return ports;
}
