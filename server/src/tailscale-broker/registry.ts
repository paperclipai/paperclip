/**
 * Root-owned ownership registry for broker leases.
 *
 * Requirement #1 (ownership via unguessable lease) and #3 (atomic registry) of
 * the threat-model verdict. A lease is the only proof of ownership required by
 * `remove`; it binds an exposure to the peer identity, runtime UUID, port,
 * target, a monotonically increasing generation, and the exact observed Serve
 * entry digest at creation time. Handles are never returned by `list`.
 *
 * Persistence uses temp-file + fsync + atomic rename + directory fsync so a crash
 * can never leave a torn registry. On load, a malformed registry fails closed.
 */

import { createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface LeaseRecord {
  handle: string;
  runtimeId: string;
  port: number;
  target: string;
  peerUid: number;
  peerGid: number;
  generation: number;
  /** Digest of the exact Serve web/tcp entry observed immediately after creation. */
  entryDigest: string;
  createdAt: number;
  /** Set when a cleanup could not be proven; the port is quarantined until reconciled. */
  quarantined?: boolean;
}

export interface RegistryFile {
  version: 1;
  generation: number;
  leases: LeaseRecord[];
}

const EMPTY: RegistryFile = { version: 1, generation: 0, leases: [] };

export function newHandle(): string {
  // 256 bits of entropy, url-safe. Unguessable per verdict #1.
  return randomBytes(32).toString("base64url");
}

export function entryDigest(port: number, target: string): string {
  return createHash("sha256").update(`${port}\0${target}`).digest("hex");
}

/** Load and strictly validate the registry file. Missing file → empty registry. */
export function loadRegistry(filePath: string): RegistryFile {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY, leases: [] };
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`registry is corrupt (parse error), refusing to continue: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || (parsed as RegistryFile).version !== 1 || !Array.isArray((parsed as RegistryFile).leases)) {
    throw new Error("registry has an unexpected shape, refusing to continue");
  }
  const file = parsed as RegistryFile;
  for (const lease of file.leases) {
    if (
      typeof lease.handle !== "string" ||
      typeof lease.runtimeId !== "string" ||
      !Number.isSafeInteger(lease.port) ||
      typeof lease.target !== "string" ||
      !Number.isSafeInteger(lease.peerUid) ||
      !Number.isSafeInteger(lease.peerGid) ||
      !Number.isSafeInteger(lease.generation) ||
      typeof lease.entryDigest !== "string"
    ) {
      throw new Error("registry contains a malformed lease, refusing to continue");
    }
  }
  return file;
}

/** Atomically persist the registry: temp + fsync + rename + dir fsync, mode 0600. */
export function persistRegistry(filePath: string, file: RegistryFile): void {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.registry.${process.pid}.${Date.now()}.tmp`);
  const data = JSON.stringify(file);
  writeFileSync(tmp, data, { mode: 0o600 });
  // fsync the temp file's contents before rename.
  const fd = openSync(tmp, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, filePath);
  // fsync the directory so the rename is durable.
  const dirFd = openSync(dir, "r");
  try {
    fsyncSync(dirFd);
  } catch {
    // Some filesystems reject directory fsync; the rename itself is atomic.
  } finally {
    closeSync(dirFd);
  }
}

/** In-memory view over a {@link RegistryFile} with lease bookkeeping. */
export class LeaseRegistry {
  private file: RegistryFile;

  constructor(file: RegistryFile) {
    this.file = { version: 1, generation: file.generation, leases: [...file.leases] };
  }

  snapshot(): RegistryFile {
    return { version: 1, generation: this.file.generation, leases: this.file.leases.map((l) => ({ ...l })) };
  }

  replace(file: RegistryFile): void {
    this.file = { version: 1, generation: file.generation, leases: file.leases.map((lease) => ({ ...lease })) };
  }

  nextGeneration(): number {
    this.file.generation += 1;
    return this.file.generation;
  }

  byHandle(handle: string): LeaseRecord | undefined {
    return this.file.leases.find((l) => l.handle === handle);
  }

  byPort(port: number): LeaseRecord | undefined {
    return this.file.leases.find((l) => l.port === port && !l.quarantined);
  }

  forPeer(peerUid: number): LeaseRecord[] {
    return this.file.leases.filter((l) => l.peerUid === peerUid);
  }

  add(lease: LeaseRecord): void {
    this.file.leases.push(lease);
  }

  removeByHandle(handle: string): boolean {
    const idx = this.file.leases.findIndex((l) => l.handle === handle);
    if (idx === -1) return false;
    this.file.leases.splice(idx, 1);
    return true;
  }

  markQuarantined(port: number): void {
    for (const lease of this.file.leases) {
      if (lease.port === port) lease.quarantined = true;
    }
  }

  all(): LeaseRecord[] {
    return this.file.leases.map((l) => ({ ...l }));
  }
}
