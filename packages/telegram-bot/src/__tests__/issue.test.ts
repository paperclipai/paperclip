import { describe, it, expect } from "vitest";
import { issueCommand } from "../commands/issue.js";
import { mockFetch, makeDeps, makeCtx } from "./helpers.js";

describe("/issue", () => {
  it("renders identifier, status, assignee and last comment", async () => {
    const fetchImpl = mockFetch((req) => {
      if (req.url.includes("/api/companies/co/issues") && req.method === "GET") {
        return {
          status: 200,
          body: [
            {
              id: "issue-1",
              identifier: "THE-100",
              title: "Test issue",
              status: "in_review",
              assigneeAgentId: "agent-1",
            },
          ],
        };
      }
      if (req.url.includes("/api/issues/issue-1/comments") && req.method === "GET") {
        return {
          status: 200,
          body: [{ id: "c-1", body: "looks good" }],
        };
      }
      return { status: 404, body: {} };
    });
    const deps = makeDeps({ fetchImpl, companyId: "co" });
    const { ctx, replies } = makeCtx("/issue THE-100");

    await issueCommand(ctx, deps);

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("THE-100");
    expect(replies[0]).toContain("in_review");
    expect(replies[0]).toContain("agent-1");
    expect(replies[0]).toContain("looks good");
  });

  it("reports not-found gracefully", async () => {
    const fetchImpl = mockFetch(() => ({ status: 200, body: [] }));
    const deps = makeDeps({ fetchImpl });
    const { ctx, replies } = makeCtx("/issue THE-404");

    await issueCommand(ctx, deps);

    expect(replies[0]).toMatch(/не найден/);
  });

  it("rejects empty arg", async () => {
    const fetchImpl = mockFetch(() => ({ status: 200, body: [] }));
    const deps = makeDeps({ fetchImpl });
    const { ctx, replies } = makeCtx("/issue");

    await issueCommand(ctx, deps);

    expect(fetchImpl.calls).toHaveLength(0);
    expect(replies[0]).toMatch(/Использование/);
  });
});
