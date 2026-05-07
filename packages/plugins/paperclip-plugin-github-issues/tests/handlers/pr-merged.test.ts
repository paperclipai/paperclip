import { describe, it, expect, vi } from "vitest";
import { handlePrMerged } from "../../src/handlers/pr-merged.js";
import fixture from "../fixtures/pull-request-merged.json" with { type: "json" };

const config = {
  hmacSecret:"x", ceoAgentId:"agent-ceo", labelGate:"agent-eligible",
  repoToProject:{ "acme/sample-repo":"project-1" }, companyId:"company-1",
};

describe("handlePrMerged", () => {
  it("marks linked task done", async () => {
    const ctx = {
      issues: {
        list:   vi.fn(async () => [{ id: "issue-1" }]),
        update: vi.fn(async () => undefined),
      },
      config,
    };
    await handlePrMerged(fixture as any, ctx as any, config);
    expect(ctx.issues.update).toHaveBeenCalledWith("issue-1", { status: "done" }, "company-1");
  });

  it("noops when no linked task", async () => {
    const ctx = { issues: { list: vi.fn(async () => []), update: vi.fn() }, config };
    await handlePrMerged(fixture as any, ctx as any, config);
    expect(ctx.issues.update).not.toHaveBeenCalled();
  });
});
