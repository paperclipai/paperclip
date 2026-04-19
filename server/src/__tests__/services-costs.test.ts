import { describe, expect, it } from "vitest";
import { costService } from "../services/costs.js";

describe("services/costs.ts", () => {
  it("exposes cost service methods", () => {
    const service = costService({} as any);
    expect(service).toMatchObject({
      createEvent: expect.any(Function),
      summary: expect.any(Function),
      byAgent: expect.any(Function),
      byProvider: expect.any(Function),
      byProject: expect.any(Function),
      windowSpend: expect.any(Function),
    });
  });
});

