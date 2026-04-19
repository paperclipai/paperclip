import { describe, expect, it, vi } from "vitest";
import { getDefaultCompanyGoal, goalService } from "../services/goals.js";

function createDbForDefaultGoal(results: Array<Array<Record<string, unknown>>>) {
  const pending = [...results];
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        orderBy: vi.fn(async () => pending.shift() ?? []),
      })),
    })),
  }));
  return { select };
}

describe("services/goals.ts", () => {
  it("prefers active company-level root goals when resolving default", async () => {
    const activeGoal = {
      id: "goal-active",
      companyId: "company-1",
      level: "company",
      status: "active",
      parentId: null,
    };
    const db = createDbForDefaultGoal([[activeGoal]]);
    await expect(getDefaultCompanyGoal(db as any, "company-1")).resolves.toEqual(activeGoal);
  });

  it("falls back to any root goal and then any company-level goal", async () => {
    const rootGoal = {
      id: "goal-root",
      companyId: "company-1",
      level: "company",
      status: "draft",
      parentId: null,
    };
    const db = createDbForDefaultGoal([[], [rootGoal]]);
    await expect(getDefaultCompanyGoal(db as any, "company-1")).resolves.toEqual(rootGoal);
  });

  it("creates goals with company scope and returns inserted row", async () => {
    const insertValues = vi.fn(() => ({
      returning: vi.fn(async () => [{ id: "goal-1", companyId: "company-1", title: "Improve quality" }]),
    }));
    const db = {
      insert: vi.fn(() => ({ values: insertValues })),
    };
    const service = goalService(db as any);

    const created = await service.create("company-1", { title: "Improve quality", level: "company" } as any);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: "company-1", title: "Improve quality" }),
    );
    expect(created).toMatchObject({ id: "goal-1", companyId: "company-1" });
  });

  it("returns null when update/delete target is missing", async () => {
    const returning = vi.fn(async () => []);
    const db = {
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn(() => ({ returning })) })),
      })),
      delete: vi.fn(() => ({
        where: vi.fn(() => ({ returning })),
      })),
    };
    const service = goalService(db as any);

    await expect(service.update("missing", { title: "x" })).resolves.toBeNull();
    await expect(service.remove("missing")).resolves.toBeNull();
  });
});

