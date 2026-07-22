import { describe, expect, it } from "vitest";
import { listAllCompanyIssues } from "./issue-pagination.js";

describe("listAllCompanyIssues", () => {
  it("continues beyond the first host page", async () => {
    const corpus = Array.from({ length: 423 }, (_, id) => ({ id }));
    const calls: number[] = [];
    const client = {
      async list({ limit = 200, offset = 0 }: { limit?: number; offset?: number }) {
        calls.push(offset);
        return corpus.slice(offset, offset + limit);
      },
    };

    const rows = await listAllCompanyIssues(client, "company", { pageSize: 200 });

    expect(rows).toHaveLength(423);
    expect(calls).toEqual([0, 200, 400]);
  });
});
