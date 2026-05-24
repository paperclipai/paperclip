import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Db } from "@paperclipai/db";
import { crewRatingFlagsService } from "../services/crew-rating-flags.js";

function createMockDb(): Db {
  return {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
  } as unknown as Db;
}

describe("crew rating flags service", () => {
  let mockDb: Db;
  let svc: ReturnType<typeof crewRatingFlagsService>;

  beforeEach(() => {
    mockDb = createMockDb();
    svc = crewRatingFlagsService(mockDb);
  });

  describe("incrementFlag", () => {
    it("creates a new flag with count 1 when none exists", async () => {
      const insertValues = vi.fn().mockResolvedValue(undefined);
      (mockDb.insert as ReturnType<typeof vi.fn>).mockReturnValue({ values: insertValues });

      const result = await svc.incrementFlag("user-1", "somewhat");

      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "user-1", ratingType: "somewhat", count: 1 }),
      );
      expect(result.count).toBe(1);
      expect(result.thresholdMet).toBe(false);
    });

    it("increments count for existing flag within 7-day window", async () => {
      const now = new Date();
      (mockDb.select as ReturnType<typeof vi.fn>).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              { id: "flag-1", userId: "user-1", ratingType: "somewhat", count: 1, windowStart: now, lastTriggeredAt: null, createdAt: now },
            ]),
          }),
        }),
      });
      const setFn = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      });
      (mockDb.update as ReturnType<typeof vi.fn>).mockReturnValue({ set: setFn });

      const result = await svc.incrementFlag("user-1", "somewhat");

      expect(result.count).toBe(2);
      expect(result.thresholdMet).toBe(false);
    });

    it("returns thresholdMet=true when 'somewhat' count reaches 3 within window", async () => {
      const now = new Date();
      (mockDb.select as ReturnType<typeof vi.fn>).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              { id: "flag-1", userId: "user-1", ratingType: "somewhat", count: 2, windowStart: now, lastTriggeredAt: null, createdAt: now },
            ]),
          }),
        }),
      });
      const setFn = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      });
      (mockDb.update as ReturnType<typeof vi.fn>).mockReturnValue({ set: setFn });

      const result = await svc.incrementFlag("user-1", "somewhat");

      expect(result.count).toBe(3);
      expect(result.thresholdMet).toBe(true);
    });

    it("returns thresholdMet=true when 'no' count reaches 3 within window", async () => {
      const now = new Date();
      (mockDb.select as ReturnType<typeof vi.fn>).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              { id: "flag-2", userId: "user-1", ratingType: "no", count: 2, windowStart: now, lastTriggeredAt: null, createdAt: now },
            ]),
          }),
        }),
      });
      const setFn = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      });
      (mockDb.update as ReturnType<typeof vi.fn>).mockReturnValue({ set: setFn });

      const result = await svc.incrementFlag("user-1", "no");

      expect(result.count).toBe(3);
      expect(result.thresholdMet).toBe(true);
    });

    it("resets count to 1 when window has elapsed (past 7 days)", async () => {
      const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      (mockDb.select as ReturnType<typeof vi.fn>).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              { id: "flag-3", userId: "user-1", ratingType: "somewhat", count: 5, windowStart: oldDate, lastTriggeredAt: null, createdAt: oldDate },
            ]),
          }),
        }),
      });
      const setFn = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      });
      (mockDb.update as ReturnType<typeof vi.fn>).mockReturnValue({ set: setFn });

      const result = await svc.incrementFlag("user-1", "somewhat");

      expect(result.count).toBe(1);
      expect(result.thresholdMet).toBe(false);
      const setArg = setFn.mock.calls[0][0];
      expect(setArg.count).toBe(1);
    });
  });
});
