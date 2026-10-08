import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  STORAGE_TRANSACTION_LOCK_DIR_NAME,
  STORAGE_TRANSACTION_LOCK_SCHEMA,
  STORAGE_TRANSACTION_PARTICIPATION_NAME,
  STORAGE_TRANSACTION_RESERVED_PREFIX,
  StorageTransactionLockError,
  acquireStorageTransactionLock,
  assertStorageTransactionLockHeld,
  isStorageTransactionReservedName,
  parseStorageTransactionOwnerRecord,
  readLocalBootId,
  readLocalMachineId,
  readProcessStartId,
  readStorageTransactionParticipation,
  releaseStorageTransactionLock,
  resolveSourceRootRealPath,
} from "./backup-transaction-lock.js";

const cleanupRoots: string[] = [];

afterEach(() => {
  while (cleanupRoots.length > 0) {
    fs.rmSync(cleanupRoots.pop()!, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupRoots.push(dir);
  return dir;
}

function writeOwner(root: string, overrides: Record<string, unknown> = {}) {
  const realRoot = resolveSourceRootRealPath(root);
  const ownerPath = path.join(realRoot, STORAGE_TRANSACTION_LOCK_DIR_NAME);
  const owner = {
    schema: STORAGE_TRANSACTION_LOCK_SCHEMA,
    token: "FAKESECRET_g1h2i3j4k5l6m7n8o9p0",
    machineId: readLocalMachineId(),
    bootId: readLocalBootId(),
    pid: 2_147_483_646,
    processStartId: "dead-process-start-id",
    operationKind: "backup",
    acquiredAt: new Date(Date.now() - 60_000).toISOString(),
    ...overrides,
  };
  fs.writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
  return owner;
}

describe("paperclip.storage-transaction-lock/v1", () => {
  it("acquires, holds, and token-safely releases a source-root lock", () => {
    const root = tempDir("paperclip-tx-lock-basic-");
    const handle = acquireStorageTransactionLock({
      sourceRoot: root,
      operationKind: "backup",
    });

    expect(handle.token.length).toBeGreaterThanOrEqual(16);
    expect(fs.existsSync(handle.ownerPath)).toBe(true);
    expect(path.basename(handle.ownerPath)).toBe(".paperclip-stx-owner");
    expect(path.basename(handle.participationPath)).toBe(".paperclip-stx-marker");
    assertStorageTransactionLockHeld(handle);

    const participation = readStorageTransactionParticipation(root);
    expect(participation?.state).toBe("active");
    expect(participation?.schema).toBe(STORAGE_TRANSACTION_LOCK_SCHEMA);

    releaseStorageTransactionLock(handle);
    expect(fs.existsSync(handle.ownerPath)).toBe(false);
    expect(readStorageTransactionParticipation(root)?.state).toBe("ready");
  });

  it("returns busy when a live local owner already holds the lock", () => {
    const root = tempDir("paperclip-tx-lock-busy-");
    const first = acquireStorageTransactionLock({
      sourceRoot: root,
      operationKind: "backup",
    });

    try {
      expect(() =>
        acquireStorageTransactionLock({
          sourceRoot: root,
          operationKind: "raid-archive",
        }),
      ).toThrow(StorageTransactionLockError);

      try {
        acquireStorageTransactionLock({
          sourceRoot: root,
          operationKind: "raid-archive",
        });
        expect.unreachable("second acquire should fail");
      } catch (error) {
        expect(error).toBeInstanceOf(StorageTransactionLockError);
        expect((error as StorageTransactionLockError).code).toBe("busy");
      }
    } finally {
      releaseStorageTransactionLock(first);
    }
  });

  it("emits a clawd-compatible owner and participation fixture shape", () => {
    const root = tempDir("paperclip-tx-lock-fixture-");
    const handle = acquireStorageTransactionLock({
      sourceRoot: root,
      operationKind: "backup",
    });
    const raw = JSON.parse(fs.readFileSync(handle.ownerPath, "utf8"));
    const parsed = parseStorageTransactionOwnerRecord(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.schema).toBe(STORAGE_TRANSACTION_LOCK_SCHEMA);
    expect(parsed!.token).toBe(handle.token);
    expect(Object.keys(parsed!).sort()).toEqual([
      "acquiredAt",
      "bootId",
      "machineId",
      "operationKind",
      "pid",
      "processStartId",
      "schema",
      "token",
    ]);
    expect(Object.keys(readStorageTransactionParticipation(root)!).sort()).toEqual([
      "schema",
      "state",
      "token",
      "updatedAt",
    ]);
    releaseStorageTransactionLock(handle);
  });

  it("recovers a confirmed dead local owner exactly once under the recovery mutex", () => {
    const root = tempDir("paperclip-tx-lock-dead-");
    writeOwner(root, {
      machineId: readLocalMachineId(),
      bootId: readLocalBootId(),
      pid: 2_147_483_646,
      processStartId: "dead-process-start-id",
    });

    const recovered = acquireStorageTransactionLock({
      sourceRoot: root,
      operationKind: "backup",
      allowDeadOwnerRecovery: true,
    });
    expect(recovered.token).not.toBe("deadtoken0123456789abcdef012345");
    expect(recovered.owner.bootId).toBe(readLocalBootId());
    expect(recovered.owner.processStartId).toBe(readProcessStartId());
    assertStorageTransactionLockHeld(recovered);
    releaseStorageTransactionLock(recovered);
  });

  it("refuses a foreign-machine owner without recovery", () => {
    const root = tempDir("paperclip-tx-lock-foreign-");
    writeOwner(root, { machineId: "foreign-machine-id-not-local" });
    try {
      acquireStorageTransactionLock({ sourceRoot: root, operationKind: "backup" });
      expect.unreachable("foreign owner should block");
    } catch (error) {
      expect(error).toBeInstanceOf(StorageTransactionLockError);
      expect((error as StorageTransactionLockError).code).toBe("foreign_owner");
    }
  });

  it("refuses to release when the caller token no longer matches", () => {
    const root = tempDir("paperclip-tx-lock-token-");
    const first = acquireStorageTransactionLock({
      sourceRoot: root,
      operationKind: "backup",
    });
    const secondRoot = tempDir("paperclip-tx-lock-token-2-");
    // Replace owner under recovery by releasing and reacquiring, then forge handle.
    const handle = acquireStorageTransactionLock({
      sourceRoot: secondRoot,
      operationKind: "backup",
    });
    const forged = {
      ...handle,
      token: "FAKESECRET_g2h3i4j5k6l7m8n9o0p1",
    };
    expect(() => releaseStorageTransactionLock(forged)).toThrow(StorageTransactionLockError);
    releaseStorageTransactionLock(handle);
    releaseStorageTransactionLock(first);
  });

  it("excludes reserved protocol artifact names", () => {
    expect(isStorageTransactionReservedName(STORAGE_TRANSACTION_LOCK_DIR_NAME)).toBe(true);
    expect(isStorageTransactionReservedName(STORAGE_TRANSACTION_PARTICIPATION_NAME)).toBe(true);
    expect(isStorageTransactionReservedName(`${STORAGE_TRANSACTION_RESERVED_PREFIX}owner.tmp.x`)).toBe(true);
    expect(isStorageTransactionReservedName("paperclip-20260911-120000.sql.gz")).toBe(false);
  });
});
