import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

/** Wire schema shared with clawd (byte-compatible; no cross-repo imports). */
export const STORAGE_TRANSACTION_LOCK_SCHEMA = "paperclip.storage-transaction-lock/v1";

/** Reserved artifact prefix under a locked source root. All enumerators must exclude it. */
export const STORAGE_TRANSACTION_RESERVED_PREFIX = ".paperclip-stx-";
export const STORAGE_TRANSACTION_LOCK_DIR_NAME = `${STORAGE_TRANSACTION_RESERVED_PREFIX}owner`;
export const STORAGE_TRANSACTION_RECOVERY_MUTEX_NAME = `${STORAGE_TRANSACTION_RESERVED_PREFIX}recovery`;
export const STORAGE_TRANSACTION_PARTICIPATION_NAME = `${STORAGE_TRANSACTION_RESERVED_PREFIX}marker`;
export const STORAGE_TRANSACTION_TMP_PREFIX = STORAGE_TRANSACTION_RESERVED_PREFIX;
export const STORAGE_TRANSACTION_QUARANTINE_PREFIX = `${STORAGE_TRANSACTION_RESERVED_PREFIX}quarantine.`;

const MAX_RECORD_BYTES = 64 * 1024;

export type StorageTransactionOperationKind =
  | "backup"
  | "backup-prune"
  | "raid-archive"
  | "storage-transaction-recovery"
  | "recovery";

export type StorageTransactionParticipationState = "active" | "ready";

export type StorageTransactionOwnerRecord = {
  schema: typeof STORAGE_TRANSACTION_LOCK_SCHEMA;
  token: string;
  machineId: string;
  bootId: string;
  pid: number;
  processStartId: string;
  operationKind: string;
  acquiredAt: string;
};

export type StorageTransactionParticipationRecord = {
  schema: typeof STORAGE_TRANSACTION_LOCK_SCHEMA;
  state: StorageTransactionParticipationState;
  token: string;
  updatedAt: string;
};

export type StorageTransactionLockHandle = {
  sourceRootRealPath: string;
  ownerPath: string;
  recoveryMutexPath: string;
  participationPath: string;
  token: string;
  owner: StorageTransactionOwnerRecord;
  recoveries?: Array<Record<string, unknown>>;
};

export type AcquireStorageTransactionLockOptions = {
  sourceRoot: string;
  operationKind: StorageTransactionOperationKind | string;
  allowDeadOwnerRecovery?: boolean;
  nowMs?: number;
};

export class StorageTransactionLockError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "StorageTransactionLockError";
    this.code = code;
    this.details = details;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === code);
}

function safeUnlink(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
}

function shellText(command: string, args: string[]): string | null {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 2_000,
    stdio: ["ignore", "pipe", "ignore"],
    env: process.env,
  });
  if (result.status !== 0) return null;
  const out = String(result.stdout ?? "").trim();
  return out.length > 0 ? out : null;
}

export function readLocalMachineId(): string | null {
  for (const candidate of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      const value = readFileSync(candidate, "utf8").trim();
      if (value) return value;
    } catch {
      // try next
    }
  }
  if (process.platform === "darwin") {
    const output = shellText("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
    const matched = output && output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
    if (matched) return matched[1]!;
  }
  return null;
}

export function readLocalBootId(): string | null {
  if (process.platform === "linux") {
    try {
      return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") return shellText("sysctl", ["-n", "kern.boottime"]);
  return null;
}

export function readProcessStartId(pid: number = process.pid): string | null {
  if (process.platform === "linux") {
    try {
      const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
      const closeParen = raw.lastIndexOf(")");
      if (closeParen < 0) return null;
      return raw.slice(closeParen + 2).trim().split(/\s+/)[19] || null;
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") return shellText("ps", ["-p", String(pid), "-o", "lstart="]);
  return null;
}

export function resolveStorageTransactionIdentity(): {
  machineId: string;
  bootId: string;
  pid: number;
  processStartId: string;
} {
  const machineId = readLocalMachineId();
  const bootId = readLocalBootId();
  const processStartId = readProcessStartId();
  if (!machineId || !bootId || !processStartId) {
    throw new StorageTransactionLockError(
      "unreadable",
      "Cannot establish stable machine, boot, and process-start identity",
    );
  }
  return { machineId, bootId, pid: process.pid, processStartId };
}

export function resolveSourceRootRealPath(
  sourceRoot: string,
  options: { createIfMissing?: boolean } = {},
): string {
  const createIfMissing = options.createIfMissing !== false;
  const resolved = resolve(sourceRoot);
  if (createIfMissing) mkdirSync(resolved, { recursive: true });
  try {
    return realpathSync(resolved);
  } catch (error) {
    if (!createIfMissing && isErrno(error, "ENOENT")) return resolved;
    throw error;
  }
}

function ownerPaths(sourceRootRealPath: string) {
  return {
    sourceRootRealPath,
    ownerPath: join(sourceRootRealPath, STORAGE_TRANSACTION_LOCK_DIR_NAME),
    recoveryMutexPath: join(sourceRootRealPath, STORAGE_TRANSACTION_RECOVERY_MUTEX_NAME),
    participationPath: join(sourceRootRealPath, STORAGE_TRANSACTION_PARTICIPATION_NAME),
  };
}

function readRegularFile(filePath: string): string | null {
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    if (isErrno(error, "EPERM") || isErrno(error, "EACCES")) {
      throw new StorageTransactionLockError("eperm", "Cannot inspect storage transaction artifact", { filePath });
    }
    throw new StorageTransactionLockError("unreadable", "Cannot inspect storage transaction artifact", { filePath });
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_RECORD_BYTES) {
    throw new StorageTransactionLockError(
      "malformed",
      "Storage transaction artifact is not a bounded regular file",
      { filePath },
    );
  }
  try {
    return readFileSync(filePath, "utf8");
  } catch (error) {
    if (isErrno(error, "EPERM") || isErrno(error, "EACCES")) {
      throw new StorageTransactionLockError("eperm", "Cannot read storage transaction artifact", { filePath });
    }
    throw new StorageTransactionLockError("unreadable", "Cannot read storage transaction artifact", { filePath });
  }
}

export function parseStorageTransactionOwnerRecord(
  value: unknown,
): StorageTransactionOwnerRecord | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const valid = v.schema === STORAGE_TRANSACTION_LOCK_SCHEMA
    && typeof v.machineId === "string" && v.machineId.length > 0
    && typeof v.bootId === "string" && v.bootId.length > 0
    && Number.isSafeInteger(v.pid) && (v.pid as number) > 0
    && typeof v.processStartId === "string" && v.processStartId.length > 0
    && typeof v.token === "string" && v.token.length > 0
    && typeof v.operationKind === "string" && v.operationKind.length > 0
    && typeof v.acquiredAt === "string" && Number.isFinite(Date.parse(v.acquiredAt));
  return valid ? (value as StorageTransactionOwnerRecord) : null;
}

export function parseStorageTransactionParticipationRecord(
  value: unknown,
): StorageTransactionParticipationRecord | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const valid = v.schema === STORAGE_TRANSACTION_LOCK_SCHEMA
    && (v.state === "active" || v.state === "ready")
    && typeof v.token === "string" && v.token.length > 0
    && typeof v.updatedAt === "string" && Number.isFinite(Date.parse(v.updatedAt));
  return valid ? (value as StorageTransactionParticipationRecord) : null;
}

function parseJson(raw: string, filePath: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new StorageTransactionLockError("malformed", "Storage transaction artifact is invalid JSON", { filePath });
  }
}

function readOwnerRecord(filePath: string): StorageTransactionOwnerRecord | null {
  const raw = readRegularFile(filePath);
  if (raw == null) return null;
  const parsed = parseStorageTransactionOwnerRecord(parseJson(raw, filePath));
  if (!parsed) {
    throw new StorageTransactionLockError("malformed", "Storage transaction owner record is malformed", { filePath });
  }
  return parsed;
}

function readParticipationRecord(filePath: string): StorageTransactionParticipationRecord | null {
  const raw = readRegularFile(filePath);
  if (raw == null) return null;
  const parsed = parseStorageTransactionParticipationRecord(parseJson(raw, filePath));
  if (!parsed) {
    throw new StorageTransactionLockError(
      "malformed",
      "Storage transaction participation marker is malformed",
      { filePath },
    );
  }
  return parsed;
}

export function checkStorageTransactionLiveness(
  record: StorageTransactionOwnerRecord,
  current: { machineId: string; bootId: string; pid: number; processStartId: string },
): "alive" | "dead" | "foreign_machine" | "eperm" | "unreadable" {
  if (record.machineId !== current.machineId) return "foreign_machine";
  if (record.bootId !== current.bootId) return "dead";
  if (record.pid === current.pid) {
    return record.processStartId === current.processStartId ? "alive" : "dead";
  }
  try {
    process.kill(record.pid, 0);
  } catch (error) {
    if (isErrno(error, "ESRCH")) return "dead";
    if (isErrno(error, "EPERM")) return "eperm";
    return "unreadable";
  }
  const observedStart = readProcessStartId(record.pid);
  if (!observedStart) return "unreadable";
  return observedStart === record.processStartId ? "alive" : "dead";
}

function classifyExisting(
  record: StorageTransactionOwnerRecord,
  identity: { machineId: string; bootId: string; pid: number; processStartId: string },
): "dead" {
  const status = checkStorageTransactionLiveness(record, identity);
  if (status === "dead") return "dead";
  if (status === "alive") {
    throw new StorageTransactionLockError("busy", "Storage transaction lock is held by a live process", {
      holderPid: record.pid,
    });
  }
  if (status === "foreign_machine") {
    throw new StorageTransactionLockError("foreign_owner", "Storage transaction lock belongs to another machine");
  }
  if (status === "eperm") {
    throw new StorageTransactionLockError("eperm", "Storage transaction owner liveness is permission-denied");
  }
  throw new StorageTransactionLockError("unreadable", "Storage transaction owner liveness is unknown");
}

function newRecord(
  identity: { machineId: string; bootId: string; pid: number; processStartId: string },
  token: string,
  operationKind: string,
  nowMs: number,
): StorageTransactionOwnerRecord {
  return {
    schema: STORAGE_TRANSACTION_LOCK_SCHEMA,
    ...identity,
    token,
    operationKind,
    acquiredAt: new Date(nowMs).toISOString(),
  };
}

function writeTempRecord(root: string, role: string, record: StorageTransactionOwnerRecord): string {
  const filePath = join(root, `${STORAGE_TRANSACTION_RESERVED_PREFIX}${role}.tmp.${record.token}.${randomUUID()}`);
  const fd = openSync(filePath, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(record)}\n`, undefined, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return filePath;
}

function publishHardLink(tempPath: string, canonicalPath: string): void {
  try {
    linkSync(tempPath, canonicalPath);
  } catch (error) {
    if (isErrno(error, "EEXIST")) throw error;
    if (["EXDEV", "EPERM", "ENOTSUP", "EOPNOTSUPP"].some((code) => isErrno(error, code))) {
      throw new StorageTransactionLockError(
        "unsupported_filesystem",
        "Filesystem cannot publish the storage transaction lock atomically",
      );
    }
    throw error;
  }
  const source = lstatSync(tempPath);
  const canonical = lstatSync(canonicalPath);
  if (!source.isFile() || !canonical.isFile() || source.dev !== canonical.dev || source.ino !== canonical.ino) {
    throw new StorageTransactionLockError("protocol_fault", "Published lock is not the expected hard-linked record");
  }
}

function retireRecord(
  filePath: string,
  root: string,
  role: string,
  expectedToken: string,
): string {
  const retired = join(root, `${STORAGE_TRANSACTION_RESERVED_PREFIX}${role}.${expectedToken}.${randomUUID()}`);
  try {
    renameSync(filePath, retired);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      throw new StorageTransactionLockError("busy", "Storage transaction ownership changed");
    }
    throw error;
  }
  const moved = readOwnerRecord(retired);
  if (!moved || moved.token !== expectedToken) {
    throw new StorageTransactionLockError(
      "protocol_fault",
      `Retired ${role} record token does not match the observed owner`,
    );
  }
  return retired;
}

function acquireRecoveryMutex(
  paths: ReturnType<typeof ownerPaths>,
  identity: { machineId: string; bootId: string; pid: number; processStartId: string },
  token: string,
  nowMs: number,
): { release: () => void } {
  const record = newRecord(identity, token, "storage-transaction-recovery", nowMs);
  const temp = writeTempRecord(paths.sourceRootRealPath, "recovery", record);
  try {
    try {
      publishHardLink(temp, paths.recoveryMutexPath);
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      const existing = readOwnerRecord(paths.recoveryMutexPath);
      if (!existing) throw new StorageTransactionLockError("recovery_conflict", "Storage transaction recovery ownership changed");
      classifyExisting(existing, identity);
      const reread = readOwnerRecord(paths.recoveryMutexPath);
      if (!reread) throw new StorageTransactionLockError("recovery_conflict", "Storage transaction recovery ownership changed");
      classifyExisting(reread, identity);
      const quarantined = retireRecord(paths.recoveryMutexPath, paths.sourceRootRealPath, "quarantine", reread.token);
      safeUnlink(quarantined);
      try {
        publishHardLink(temp, paths.recoveryMutexPath);
      } catch (publishError) {
        if (isErrno(publishError, "EEXIST")) {
          throw new StorageTransactionLockError("recovery_conflict", "Storage transaction recovery mutex is busy");
        }
        throw publishError;
      }
    }
  } finally {
    safeUnlink(temp);
  }
  return {
    release() {
      const existing = readOwnerRecord(paths.recoveryMutexPath);
      if (!existing || existing.token !== token) return;
      const retired = retireRecord(paths.recoveryMutexPath, paths.sourceRootRealPath, "release", token);
      safeUnlink(retired);
    },
  };
}

function writeParticipation(
  paths: ReturnType<typeof ownerPaths>,
  marker: StorageTransactionParticipationRecord,
): void {
  const temp = join(
    paths.sourceRootRealPath,
    `${STORAGE_TRANSACTION_RESERVED_PREFIX}marker.tmp.${marker.token}.${randomUUID()}`,
  );
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(marker)}\n`, undefined, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, paths.participationPath);
  } catch (error) {
    safeUnlink(temp);
    throw error;
  }
}

function markerFor(
  state: StorageTransactionParticipationState,
  token: string,
  nowMs: number,
): StorageTransactionParticipationRecord {
  return {
    schema: STORAGE_TRANSACTION_LOCK_SCHEMA,
    state,
    token,
    updatedAt: new Date(nowMs).toISOString(),
  };
}

export function isStorageTransactionReservedName(name: string): boolean {
  return typeof name === "string" && name.startsWith(STORAGE_TRANSACTION_RESERVED_PREFIX);
}

export function isStorageTransactionReservedPath(filePath: string, sourceRoot: string): boolean {
  const root = resolveSourceRootRealPath(sourceRoot, { createIfMissing: false });
  const resolved = resolve(filePath);
  const rel = resolved.startsWith(root + sep)
    ? resolved.slice(root.length + 1)
    : resolved === root
      ? ""
      : null;
  if (rel == null) return false;
  const top = rel.split(sep)[0] ?? "";
  return isStorageTransactionReservedName(top);
}

/**
 * Acquire the source-root storage transaction lock.
 * Publishes a fully populated owner record via same-directory hardlink and holds
 * it for the entire producer/archive transaction.
 */
export function acquireStorageTransactionLock(
  options: AcquireStorageTransactionLockOptions,
): StorageTransactionLockHandle {
  const sourceRootRealPath = resolveSourceRootRealPath(options.sourceRoot);
  const paths = ownerPaths(sourceRootRealPath);
  const identity = resolveStorageTransactionIdentity();
  const nowMs = options.nowMs ?? Date.now();
  const token = randomUUID();
  const owner = newRecord(identity, token, options.operationKind || "backup", nowMs);
  const recoveries: Array<Record<string, unknown>> = [];

  const publishOwner = (): StorageTransactionLockHandle => {
    const temp = writeTempRecord(sourceRootRealPath, "owner", owner);
    try {
      publishHardLink(temp, paths.ownerPath);
    } finally {
      safeUnlink(temp);
    }
    try {
      writeParticipation(paths, markerFor("active", token, nowMs));
    } catch (error) {
      const recovery = acquireRecoveryMutex(paths, identity, randomUUID(), Date.now());
      try {
        const current = readOwnerRecord(paths.ownerPath);
        if (current && current.token === token) {
          const retired = retireRecord(paths.ownerPath, sourceRootRealPath, "release", token);
          safeUnlink(retired);
        }
      } finally {
        recovery.release();
      }
      throw error;
    }
    return {
      sourceRootRealPath,
      ownerPath: paths.ownerPath,
      recoveryMutexPath: paths.recoveryMutexPath,
      participationPath: paths.participationPath,
      token,
      owner,
      recoveries,
    };
  };

  try {
    return publishOwner();
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw error;
  }

  const existing = readOwnerRecord(paths.ownerPath);
  if (!existing) {
    throw new StorageTransactionLockError("busy", "Storage transaction ownership changed; retry from fresh state");
  }
  classifyExisting(existing, identity);
  if (options.allowDeadOwnerRecovery === false) {
    throw new StorageTransactionLockError("busy", "Dead-owner recovery is disabled");
  }

  const recovery = acquireRecoveryMutex(paths, identity, token, nowMs);
  try {
    const reread = readOwnerRecord(paths.ownerPath);
    if (reread) {
      classifyExisting(reread, identity);
      const quarantined = retireRecord(paths.ownerPath, sourceRootRealPath, "quarantine", reread.token);
      recoveries.push({
        sourceRootRealPath,
        classification: "dead_local",
        quarantined: true,
        quarantinePath: quarantined,
        recoveredToken: reread.token,
      });
      safeUnlink(quarantined);
    }
    try {
      return publishOwner();
    } catch (error) {
      if (isErrno(error, "EEXIST")) {
        throw new StorageTransactionLockError("busy", "Storage transaction lock was acquired by another owner");
      }
      throw error;
    }
  } finally {
    recovery.release();
  }
}

export function assertStorageTransactionLockHeld(handle: StorageTransactionLockHandle): StorageTransactionOwnerRecord {
  const current = readOwnerRecord(handle.ownerPath);
  if (!current || current.token !== handle.token) {
    throw new StorageTransactionLockError(
      "token_mismatch",
      "Storage transaction ownership no longer matches this handle",
      { sourceRootRealPath: handle.sourceRootRealPath },
    );
  }
  if (current.pid !== process.pid || current.processStartId !== readProcessStartId()) {
    throw new StorageTransactionLockError(
      "not_holder",
      "Storage transaction owner identity no longer matches this process",
      { sourceRootRealPath: handle.sourceRootRealPath },
    );
  }
  return current;
}

export function markStorageTransactionParticipationReady(
  handle: StorageTransactionLockHandle,
  nowMs: number = Date.now(),
): void {
  assertStorageTransactionLockHeld(handle);
  writeParticipation(ownerPaths(handle.sourceRootRealPath), markerFor("ready", handle.token, nowMs));
}

/**
 * Token-safe release: removes only this holder's owner record and leaves a
 * ready participation marker for enrolled archive consumers.
 */
export function releaseStorageTransactionLock(
  handle: StorageTransactionLockHandle,
  options: { participationState?: StorageTransactionParticipationState } = {},
): void {
  const identity = resolveStorageTransactionIdentity();
  const paths = ownerPaths(handle.sourceRootRealPath);
  const recovery = acquireRecoveryMutex(paths, identity, randomUUID(), Date.now());
  try {
    const current = readOwnerRecord(paths.ownerPath);
    if (!current) return;
    if (current.token !== handle.token) {
      throw new StorageTransactionLockError(
        "token_mismatch",
        "Refusing to release a replacement storage transaction owner",
        { sourceRootRealPath: handle.sourceRootRealPath },
      );
    }
    if ((options.participationState || "ready") === "ready") {
      writeParticipation(paths, markerFor("ready", handle.token, Date.now()));
    }
    const retired = retireRecord(paths.ownerPath, paths.sourceRootRealPath, "release", handle.token);
    safeUnlink(retired);
  } finally {
    recovery.release();
  }
}

export function readStorageTransactionParticipation(
  sourceRoot: string,
  options: { createIfMissing?: boolean } = {},
): StorageTransactionParticipationRecord | null {
  const sourceRootRealPath = resolveSourceRootRealPath(sourceRoot, {
    createIfMissing: options.createIfMissing === true,
  });
  try {
    return readParticipationRecord(ownerPaths(sourceRootRealPath).participationPath);
  } catch {
    return null;
  }
}

export function classifyPaperclipParticipation(sourceRoot: string): {
  ok: boolean;
  reason: string | null;
  sourceRootRealPath: string;
  record?: StorageTransactionParticipationRecord | null;
  newestSourceMtimeMs?: number | null;
} {
  const sourceRootRealPath = resolveSourceRootRealPath(sourceRoot, { createIfMissing: false });
  let record: StorageTransactionParticipationRecord | null = null;
  try {
    record = readParticipationRecord(ownerPaths(sourceRootRealPath).participationPath);
  } catch {
    return { ok: false, reason: "participation_incompatible", sourceRootRealPath };
  }
  if (!record) return { ok: false, reason: "participation_missing", sourceRootRealPath };
  if (record.state === "active") {
    return { ok: false, reason: "participation_active", sourceRootRealPath, record };
  }
  return { ok: true, reason: null, sourceRootRealPath, record };
}
