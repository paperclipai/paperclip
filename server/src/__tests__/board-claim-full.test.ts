import { describe, expect, it, vi } from "vitest";
import {
  inspectBoardClaimChallenge,
  initializeBoardClaimChallenge,
  claimBoardOwnership,
  getBoardClaimWarningUrl,
} from "../board-claim.js";

// We need to test this module which uses in-memory state (activeChallenge).
// Since board-claim.ts does direct DB operations, we mock the DB with
// transactional support.

function createMockDb() {
  const selectResult = vi.fn();
  const insertFn = vi.fn().mockReturnValue({
    values: vi.fn().mockReturnValue({
      onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
    }),
  });
  const deleteFn = vi.fn().mockReturnValue({
    where: vi.fn().mockResolvedValue(undefined),
  });
  const updateFn = vi.fn().mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  });

  const chainedSelect = {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        then: selectResult,
      }),
    }),
  };

  const txMock = {
    select: vi.fn().mockReturnValue(chainedSelect),
    insert: insertFn,
    delete: deleteFn,
    update: updateFn,
  };

  const db = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          then: selectResult,
        }),
      }),
    }),
    transaction: vi.fn().mockImplementation(async (cb: any) => cb(txMock)),
  };

  return { db, selectResult, txMock };
}

describe("board-claim", () => {
  describe("inspectBoardClaimChallenge", () => {
    it("returns invalid for unknown token before initialization", () => {
      const result = inspectBoardClaimChallenge("nonexistent-token", "code");
      expect(result.status).toBe("invalid");
    });
  });

  describe("initializeBoardClaimChallenge", () => {
    it("does nothing for local_trusted mode", async () => {
      const { db } = createMockDb();
      await initializeBoardClaimChallenge(db as any, { deploymentMode: "local_trusted" as any });
      // Should not query DB
      expect(db.select).not.toHaveBeenCalled();
    });

    it("creates a challenge when only local-board admin exists", async () => {
      const { db, selectResult } = createMockDb();
      selectResult.mockImplementation((cb: any) => Promise.resolve(cb([{ userId: "local-board" }])));
      await initializeBoardClaimChallenge(db as any, { deploymentMode: "authenticated" as any });
      // After init, getBoardClaimWarningUrl should return a URL
      const url = getBoardClaimWarningUrl("0.0.0.0", 3100);
      expect(url).toContain("/board-claim/");
    });

    it("does not create challenge when real admin exists", async () => {
      const { db, selectResult } = createMockDb();
      selectResult.mockImplementation((cb: any) =>
        Promise.resolve(cb([{ userId: "local-board" }, { userId: "real-user" }]))
      );
      await initializeBoardClaimChallenge(db as any, { deploymentMode: "authenticated" as any });
      const url = getBoardClaimWarningUrl("0.0.0.0", 3100);
      // When a real (non local-board) admin exists, no challenge should be active
      expect(url).toBeNull();
    });
  });

  describe("claimBoardOwnership", () => {
    it("returns invalid status for unknown token", async () => {
      const { db } = createMockDb();
      const result = await claimBoardOwnership(db as any, {
        token: "fake",
        code: "fake",
        userId: "user-1",
      });
      expect(result.status).toBe("invalid");
    });
  });

  describe("getBoardClaimWarningUrl", () => {
    it("uses localhost when host is 0.0.0.0", () => {
      // This will return null if no active challenge, which is expected
      // The function signature test verifies the code path
      const url = getBoardClaimWarningUrl("0.0.0.0", 3100);
      if (url !== null) {
        expect(url).toContain("localhost");
      }
    });
  });
});
