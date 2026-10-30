import { describe, expect, it } from "vitest";
import { searchRunnerApi } from "./runner-api-catalog.js";

describe("runner API skill reference enrichment", () => {
  it("tells agents that the issue count route requires the blocked attention filter", () => {
    const operationId = "GET /api/companies/{companyId}/issues/count";
    const match = searchRunnerApi({ query: "count issues", limit: 10 }).results
      .find((entry) => entry.operationId === operationId);
    expect(match?.skillReference?.description).toContain("`?attention=blocked` is required");
    expect(match?.skillReference?.description).toContain("rejects `?limit=` and `?offset=`");
    expect(match?.skillReference?.description).toContain("page through `GET /api/companies/:companyId/issues`");
  });
});
