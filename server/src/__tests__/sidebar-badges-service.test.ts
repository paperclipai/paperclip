import { describe, expect, it, vi } from "vitest";
import type { BoardBrief } from "@paperclipai/shared";
import { sidebarBadgeService } from "../services/sidebar-badges.js";

function makeQueryChain<T>(rows: T[]) {
  const promise = Promise.resolve(rows);
  return Object.assign(promise, {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  });
}

describe("sidebarBadgeService", () => {
  it("counts only the latest failed run per agent instead of every failed action item", async () => {
    const db = {
      select: vi.fn()
        .mockReturnValueOnce(makeQueryChain([{ count: 1 }]))
        .mockReturnValueOnce(makeQueryChain([{ count: 0 }])),
      selectDistinctOn: vi.fn().mockReturnValue(
        makeQueryChain([
          { agentId: "agent-1", status: "succeeded" },
          { agentId: "agent-2", status: "failed" },
          { agentId: "agent-3", status: "timed_out" },
        ]),
      ),
    };

    const brief = {
      actionQueue: Array.from({ length: 12 }, (_value, index) => ({
        key: `run:${index}`,
        kind: "run",
        entityId: `run-${index}`,
      })),
      incidents: [
        { severity: "critical" },
        { severity: "medium" },
      ],
    } as unknown as BoardBrief;

    const result = await sidebarBadgeService(db as never).get("company-1", brief, {
      canApproveJoins: true,
      unreadTouchedIssues: 6,
    });

    expect(result).toEqual({
      inbox: 10,
      approvals: 1,
      failedRuns: 2,
      joinRequests: 0,
    });
  });
});
