import { describe, expect, it } from "vitest";
import { goalService } from "../services/goals.js";

describe("services/goals.ts", () => {
  it("exposes goal service methods", () => {
    const service = goalService({} as any);
    expect(service).toMatchObject({
      list: expect.any(Function),
      getById: expect.any(Function),
      getDefaultCompanyGoal: expect.any(Function),
      create: expect.any(Function),
      update: expect.any(Function),
      remove: expect.any(Function),
    });
  });
});

