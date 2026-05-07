import { describe, it, expect, vi } from "vitest";
import { handleIssueOpened } from "../../src/handlers/issue-opened.js";
import fixture from "../fixtures/issue-opened.json" with { type: "json" };

const config = {
  hmacSecret: "x",
  ceoAgentId: "agent-ceo",
  labelGate: "agent-eligible",
  repoToProject: { "acme/sample-repo": "project-1" },
  companyId: "company-1",
};

function makeCtx(found: { id: string } | null = null) {
  return {
    issues: {
      list:   vi.fn(async () => (found ? [found] : [])),
      create: vi.fn(async () => ({ id: "issue-new" })),
    },
    config,
  };
}

describe("handleIssueOpened", () => {
  it("creates a Paperclip issue when label present and repo mapped", async () => {
    const ctx = makeCtx(null);
    await handleIssueOpened(fixture as any, ctx as any, config);
    expect(ctx.issues.create).toHaveBeenCalledOnce();
    const args = ctx.issues.create.mock.calls[0][0];
    expect(args.companyId).toBe("company-1");
    expect(args.assigneeAgentId).toBe("agent-ceo");
    expect(args.originKind).toBe("plugin:paperclip-plugin-github-issues:issue");
    expect(args.originId).toMatch(/acme\/sample-repo#\d+/);
    expect(args.projectId).toBe("project-1");
  });

  it("noops when issue already exists by origin (idempotency layer 3)", async () => {
    const ctx = makeCtx({ id: "issue-existing" });
    await handleIssueOpened(fixture as any, ctx as any, config);
    expect(ctx.issues.create).not.toHaveBeenCalled();
  });

  it("noops when label not present", async () => {
    const ctx = makeCtx(null);
    const filtered = { ...(fixture as any), issue: { ...(fixture as any).issue, labels: [{ name: "bug" }] } };
    await handleIssueOpened(filtered, ctx as any, config);
    expect(ctx.issues.create).not.toHaveBeenCalled();
  });

  it("noops when repo not mapped", async () => {
    const ctx = makeCtx(null);
    const otherRepo = { ...(fixture as any), repository: { ...(fixture as any).repository, full_name: "acme/other" } };
    await handleIssueOpened(otherRepo, ctx as any, config);
    expect(ctx.issues.create).not.toHaveBeenCalled();
  });
});
