import { describe, expect, it, vi } from "vitest";
import { issueService } from "../services/issues.ts";

type Row = Record<string, unknown>;

function createSelectSequenceDb(results: unknown[]) {
  const pending = [...results];
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    then: vi.fn((resolve: (rows: Row[]) => unknown) => Promise.resolve(resolve((pending.shift() as Row[]) ?? []))),
  };

  return {
    db: {
      select: vi.fn(() => chain),
    },
  };
}

describe("issueService.checkout run FK stub", () => {
  it("upserts a heartbeat run stub before writing checkoutRunId", async () => {
    const dbStub = createSelectSequenceDb([
      [{ companyId: "company-1" }],
      [{ id: "agent-1", companyId: "company-1", status: "idle" }],
    ]);

    const insertValues = vi.fn();
    const db = {
      ...dbStub.db,
      insert: vi.fn(() => ({
        values: vi.fn((values: unknown) => {
          insertValues(values);
          return {
            onConflictDoNothing: vi.fn(async () => undefined),
          };
        }),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => {
          throw new Error("stop-after-fk-stub");
        }),
      })),
    };

    const svc = issueService(db as any);

    await expect(
      svc.checkout("issue-1", "agent-1", ["todo", "backlog", "blocked"], "run-123"),
    ).rejects.toThrow("stop-after-fk-stub");

    expect(insertValues).toHaveBeenCalledWith({
      id: "run-123",
      companyId: "company-1",
      agentId: "agent-1",
      invocationSource: "on_demand",
      status: "running",
    });
  });
});
