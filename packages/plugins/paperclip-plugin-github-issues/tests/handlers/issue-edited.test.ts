import { describe, it, expect, vi } from "vitest";
import { handleIssueEdited } from "../../src/handlers/issue-edited.js";
import fixture from "../fixtures/issue-edited.json" with { type: "json" };

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

describe("handleIssueEdited", () => {
  it("adds comment with wake_payload + wakes when issue exists", async () => {
    const ctx = makeCtx();
    await handleIssueEdited(fixture as any, ctx as any, config);
    expect(ctx.issues.createComment).toHaveBeenCalledOnce();
    expect((ctx.issues.createComment.mock as any).lastCall[1]).toContain("wake_payload");
    expect(ctx.issues.requestWakeup).toHaveBeenCalledOnce();
    const wakeArgs = (ctx.issues.requestWakeup.mock as any).lastCall;
    expect(wakeArgs[0]).toBe("issue-1");
    expect(wakeArgs[1]).toBe("company-1");
    expect(wakeArgs[2].reason).toBe("github_issue_updated");
    expect(wakeArgs[2].idempotencyKey).toBeTruthy();
  });

  it("noops when issue does not exist (race: edit before opened)", async () => {
    const ctx = makeCtx(null);
    await handleIssueEdited(fixture as any, ctx as any, config);
    expect(ctx.issues.createComment).not.toHaveBeenCalled();
    expect(ctx.issues.requestWakeup).not.toHaveBeenCalled();
  });

  it("noops when repo unmapped", async () => {
    const ctx = makeCtx();
    const other = { ...(fixture as any), repository: { ...(fixture as any).repository, full_name: "acme/other" } };
    await handleIssueEdited(other, ctx as any, config);
    expect(ctx.issues.createComment).not.toHaveBeenCalled();
  });
});
