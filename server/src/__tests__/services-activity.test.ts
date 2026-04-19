import { describe, expect, it, vi } from "vitest";
import { activityService } from "../services/activity.js";

describe("services/activity.ts", () => {
  it("maps list rows back to activity records", async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          leftJoin: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn().mockResolvedValue([
                { activityLog: { id: "act-1", action: "issue.created" } },
              ]),
            })),
          })),
        })),
      })),
    };
    const service = activityService(db as any);

    const rows = await service.list({ companyId: "company-1" });
    expect(rows).toEqual([{ id: "act-1", action: "issue.created" }]);
  });

  it("returns empty issue links when run is missing", async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([]),
        })),
      })),
    };
    const service = activityService(db as any);

    await expect(service.issuesForRun("missing-run")).resolves.toEqual([]);
  });

  it("includes contextSnapshot issue when activity log has no issue rows", async () => {
    const selectResults = [
      [
        {
          companyId: "company-1",
          contextSnapshot: { issueId: "issue-1" },
        },
      ],
      [
        {
          issueId: "issue-1",
          identifier: "PAP-1",
          title: "Top issue",
          status: "todo",
          priority: "medium",
        },
      ],
    ];
    const select = vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue(selectResults.shift() ?? []),
      })),
    }));
    const selectDistinctOn = vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn().mockResolvedValue([]),
          })),
        })),
      })),
    }));
    const db = { select, selectDistinctOn };
    const service = activityService(db as any);

    const rows = await service.issuesForRun("run-1");
    expect(rows).toEqual([
      {
        issueId: "issue-1",
        identifier: "PAP-1",
        title: "Top issue",
        status: "todo",
        priority: "medium",
      },
    ]);
  });

  it("exposes expected service methods", () => {
    const service = activityService({} as any);
    expect(service).toMatchObject({
      list: expect.any(Function),
      forIssue: expect.any(Function),
      runsForIssue: expect.any(Function),
      issuesForRun: expect.any(Function),
      create: expect.any(Function),
    });
  });
});

