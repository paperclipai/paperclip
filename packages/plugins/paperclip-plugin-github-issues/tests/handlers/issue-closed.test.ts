import { describe, it, expect, vi } from "vitest";
import { handleIssueClosed } from "../../src/handlers/issue-closed.js";
import fixture from "../fixtures/issue-closed.json" with { type: "json" };

const config = {
  hmacSecret:"x", ceoAgentId:"agent-ceo", labelGate:"agent-eligible",
  repoToProject:{ "acme/sample-repo":"project-1" }, companyId:"company-1",
};

describe("handleIssueClosed", () => {
  it("marks Paperclip task done when found", async () => {
    const ctx = {
      issues: {
        list:   vi.fn(async () => [{ id: "issue-1" }]),
        update: vi.fn(async () => undefined),
      },
      config,
    };
    await handleIssueClosed(fixture as any, ctx as any, config);
    expect(ctx.issues.update).toHaveBeenCalledWith("issue-1", { status: "done" }, "company-1");
  });

  it("noops when not found", async () => {
    const ctx = { issues: { list: vi.fn(async () => []), update: vi.fn() }, config };
    await handleIssueClosed(fixture as any, ctx as any, config);
    expect(ctx.issues.update).not.toHaveBeenCalled();
  });
});
