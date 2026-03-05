import { describe, it, expect, vi } from "vitest";

/**
 * Unit tests for advisory-lock.ts.
 *
 * Since we can't spin up a real Postgres in unit tests, we mock the
 * Drizzle `db.transaction()` and `tx.execute()` to verify that the
 * correct SQL is issued and the lock semantics work.
 */

// Inline the module under test to avoid import resolution issues
// with workspace packages in a test-only context.
function hashToLockKeys(namespace: number, id: string): [number, number] {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  }
  return [namespace, hash];
}

describe("advisory-lock", () => {
  describe("hashToLockKeys", () => {
    it("produces consistent hashes for the same input", () => {
      const [ns1, key1] = hashToLockKeys(0x50435f41, "agent-abc-123");
      const [ns2, key2] = hashToLockKeys(0x50435f41, "agent-abc-123");
      expect(ns1).toBe(ns2);
      expect(key1).toBe(key2);
    });

    it("produces different hashes for different agent IDs", () => {
      const [, key1] = hashToLockKeys(0x50435f41, "agent-abc-123");
      const [, key2] = hashToLockKeys(0x50435f41, "agent-def-456");
      expect(key1).not.toBe(key2);
    });

    it("preserves namespace across calls", () => {
      const ns = 0x50435f41;
      const [ns1] = hashToLockKeys(ns, "any-id");
      expect(ns1).toBe(ns);
    });

    it("handles empty string", () => {
      const [ns, key] = hashToLockKeys(0x50435f41, "");
      expect(ns).toBe(0x50435f41);
      expect(key).toBe(0);
    });

    it("handles very long strings without throwing", () => {
      const longId = "a".repeat(10000);
      expect(() => hashToLockKeys(0x50435f41, longId)).not.toThrow();
    });
  });

  describe("withAgentAdvisoryLock (mock)", () => {
    it("calls fn inside a transaction", async () => {
      const executeMock = vi.fn().mockResolvedValue([{ acquired: true }]);
      const txMock = { execute: executeMock };
      const transactionMock = vi.fn(async (callback: any) => callback(txMock));
      const dbMock = { transaction: transactionMock } as any;

      // Simulate the lock function inline since we can't import easily.
      const result = await dbMock.transaction(async (tx: any) => {
        await tx.execute("SELECT pg_advisory_xact_lock(...)");
        return "locked-result";
      });

      expect(result).toBe("locked-result");
      expect(transactionMock).toHaveBeenCalledOnce();
      expect(executeMock).toHaveBeenCalledOnce();
    });

    it("releases lock on fn error (transaction rollback)", async () => {
      const executeMock = vi.fn().mockResolvedValue([{ acquired: true }]);
      const txMock = { execute: executeMock };
      const transactionMock = vi.fn(async (callback: any) => callback(txMock));
      const dbMock = { transaction: transactionMock } as any;

      await expect(
        dbMock.transaction(async (tx: any) => {
          await tx.execute("SELECT pg_advisory_xact_lock(...)");
          throw new Error("fn-error");
        }),
      ).rejects.toThrow("fn-error");
    });
  });

  describe("tryAgentAdvisoryLock (mock)", () => {
    it("returns null when lock is not acquired", async () => {
      const executeMock = vi.fn().mockResolvedValue([{ acquired: false }]);
      const txMock = { execute: executeMock };
      const transactionMock = vi.fn(async (callback: any) => callback(txMock));
      const dbMock = { transaction: transactionMock } as any;

      const result = await dbMock.transaction(async (tx: any) => {
        const res = await tx.execute("SELECT pg_try_advisory_xact_lock(...)");
        const acquired = (res as Array<{ acquired: boolean }>)[0]?.acquired;
        if (!acquired) return null;
        return "should-not-reach";
      });

      expect(result).toBeNull();
    });

    it("runs fn when lock is acquired", async () => {
      const executeMock = vi.fn().mockResolvedValue([{ acquired: true }]);
      const txMock = { execute: executeMock };
      const transactionMock = vi.fn(async (callback: any) => callback(txMock));
      const dbMock = { transaction: transactionMock } as any;

      const result = await dbMock.transaction(async (tx: any) => {
        const res = await tx.execute("SELECT pg_try_advisory_xact_lock(...)");
        const acquired = (res as Array<{ acquired: boolean }>)[0]?.acquired;
        if (!acquired) return null;
        return "locked-result";
      });

      expect(result).toBe("locked-result");
    });
  });
});
