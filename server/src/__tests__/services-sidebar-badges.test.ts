import { describe, expect, it, vi } from "vitest";
import { sidebarBadgeService } from "../services/sidebar-badges.js";

function createDbForBadges() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([{ id: "a-1", updatedAt: new Date("2026-01-01T00:00:00Z") }]),
      })),
    })),
    selectDistinctOn: vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn().mockResolvedValue([
              { id: "run-1", runStatus: "failed", createdAt: new Date("2026-01-01T00:00:00Z") },
            ]),
          })),
        })),
      })),
    })),
  };
}

describe("services/sidebar-badges.ts", () => {
  it("computes inbox badge counts with approvals/failed-runs/join/unread", async () => {
    const service = sidebarBadgeService(createDbForBadges() as any);
    const badges = await service.get("cmp-1", {
      joinRequests: [{ id: "join-1", createdAt: new Date("2026-01-01T00:00:00Z"), updatedAt: null }],
      unreadTouchedIssues: 2,
    });
    expect(badges.approvals).toBe(1);
    expect(badges.failedRuns).toBe(1);
    expect(badges.joinRequests).toBe(1);
    expect(badges.inbox).toBe(5);
  });

  it("honors dismissal timestamps for approvals, runs, and join requests", async () => {
    const service = sidebarBadgeService(createDbForBadges() as any);
    const dismissals = new Map<string, number>([
      ["approval:a-1", new Date("2026-01-02T00:00:00.000Z").getTime()],
      ["run:run-1", new Date("2026-01-02T00:00:00.000Z").getTime()],
      ["join:join-1", new Date("2026-01-02T00:00:00.000Z").getTime()],
    ]);

    const badges = await service.get("cmp-1", {
      dismissals,
      joinRequests: [{ id: "join-1", createdAt: new Date("2026-01-01T00:00:00Z"), updatedAt: null }],
      unreadTouchedIssues: 0,
    });
    expect(badges).toEqual({
      approvals: 0,
      failedRuns: 0,
      joinRequests: 0,
      inbox: 0,
    });
  });

  it("returns zeroed badges when there are no actionable rows", async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([]),
        })),
      })),
      selectDistinctOn: vi.fn(() => ({
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn().mockResolvedValue([]),
            })),
          })),
        })),
      })),
    };
    const service = sidebarBadgeService(db as any);
    const badges = await service.get("cmp-1");
    expect(badges).toEqual({
      approvals: 0,
      failedRuns: 0,
      joinRequests: 0,
      inbox: 0,
    });
  });
});
