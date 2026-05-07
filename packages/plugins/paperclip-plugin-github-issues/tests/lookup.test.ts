import { describe, it, expect, vi } from "vitest";
import { findIssueByOrigin } from "../src/lookup.js";

describe("findIssueByOrigin", () => {
  it("returns the issue id when found", async () => {
    const issuesApi = { list: vi.fn(async () => [{ id: "issue-paperclip-1" }]) };
    const result = await findIssueByOrigin(issuesApi as any, "company-1", "kind", "acme/foo#42");
    expect(result).toBe("issue-paperclip-1");
    expect(issuesApi.list).toHaveBeenCalledWith({
      companyId: "company-1",
      originKind: "kind",
      originId: "acme/foo#42",
      limit: 1,
    });
  });

  it("returns null when not found (empty array)", async () => {
    const issuesApi = { list: vi.fn(async () => []) };
    expect(await findIssueByOrigin(issuesApi as any, "company-1", "kind", "acme/foo#42")).toBeNull();
  });
});
