import { describe, it, expect, vi } from "vitest";
import { handleCommentCreated } from "../../src/handlers/comment-created.js";
import fixture from "../fixtures/issue-comment-created.json" with { type: "json" };

const config = {
  hmacSecret: "x", ceoAgentId: "agent-ceo", labelGate: "agent-eligible",
  repoToProject: { "acme/sample-repo": "project-1" }, companyId: "company-1",
};

function makeCtx(found: { id: string } | null = { id: "issue-1" }) {
  return {
    issues: {
      list:          vi.fn(async () => (found ? [found] : [])),
      createComment: vi.fn(async () => undefined),
      requestWakeup: vi.fn(async () => undefined),
    },
    config,
  };
}

describe("handleCommentCreated", () => {
  it("adds comment + wakes when issue exists", async () => {
    const ctx = makeCtx();
    await handleCommentCreated(fixture as any, ctx as any, config);
    expect(ctx.issues.createComment).toHaveBeenCalledOnce();
    expect(ctx.issues.createComment.mock.calls[0][1]).toContain("wake_payload");
    expect(ctx.issues.requestWakeup).toHaveBeenCalledOnce();
    expect(ctx.issues.requestWakeup.mock.calls[0][2].reason).toBe("github_comment_created");
  });

  it("noops when issue does not exist", async () => {
    const ctx = makeCtx(null);
    await handleCommentCreated(fixture as any, ctx as any, config);
    expect(ctx.issues.createComment).not.toHaveBeenCalled();
  });

  it("noops when repo unmapped", async () => {
    const ctx = makeCtx();
    const other = { ...(fixture as any), repository: { ...(fixture as any).repository, full_name: "acme/other" } };
    await handleCommentCreated(other, ctx as any, config);
    expect(ctx.issues.createComment).not.toHaveBeenCalled();
  });
});
