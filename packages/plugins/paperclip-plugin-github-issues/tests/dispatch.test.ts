import { describe, it, expect, vi } from "vitest";
import { dispatch } from "../src/dispatch.js";

function makeHandlers() {
  return {
    issueOpened: vi.fn(),
    issueEdited: vi.fn(),
    issueClosed: vi.fn(),
    commentCreated: vi.fn(),
    workflowRun: vi.fn(),
    prMerged: vi.fn(),
  };
}

describe("dispatch", () => {
  it("routes issues.opened", async () => {
    const h = makeHandlers();
    await dispatch("issues", { action: "opened", issue: {}, repository: {} } as any, {} as any, h);
    expect(h.issueOpened).toHaveBeenCalledOnce();
  });

  it("routes issues.edited", async () => {
    const h = makeHandlers();
    await dispatch("issues", { action: "edited", issue: {}, repository: {} } as any, {} as any, h);
    expect(h.issueEdited).toHaveBeenCalledOnce();
  });

  it("routes issues.closed", async () => {
    const h = makeHandlers();
    await dispatch("issues", { action: "closed", issue: {}, repository: {} } as any, {} as any, h);
    expect(h.issueClosed).toHaveBeenCalledOnce();
  });

  it("routes issue_comment.created", async () => {
    const h = makeHandlers();
    await dispatch("issue_comment", { action: "created", issue: {}, comment: {}, repository: {} } as any, {} as any, h);
    expect(h.commentCreated).toHaveBeenCalledOnce();
  });

  it("routes workflow_run.completed only on success", async () => {
    const h = makeHandlers();
    await dispatch("workflow_run", { action: "completed", workflow_run: { conclusion: "success" }, repository: {} } as any, {} as any, h);
    expect(h.workflowRun).toHaveBeenCalledOnce();
  });

  it("drops workflow_run.completed when conclusion!=success", async () => {
    const h = makeHandlers();
    await dispatch("workflow_run", { action: "completed", workflow_run: { conclusion: "failure" }, repository: {} } as any, {} as any, h);
    expect(h.workflowRun).not.toHaveBeenCalled();
  });

  it("routes pull_request.closed merged=true", async () => {
    const h = makeHandlers();
    await dispatch("pull_request", { action: "closed", pull_request: { merged: true }, repository: {} } as any, {} as any, h);
    expect(h.prMerged).toHaveBeenCalledOnce();
  });

  it("drops pull_request.closed merged=false", async () => {
    const h = makeHandlers();
    await dispatch("pull_request", { action: "closed", pull_request: { merged: false }, repository: {} } as any, {} as any, h);
    expect(h.prMerged).not.toHaveBeenCalled();
  });

  it("drops unknown actions silently", async () => {
    const h = makeHandlers();
    await dispatch("issues", { action: "labeled", issue: {}, repository: {} } as any, {} as any, h);
    expect(h.issueOpened).not.toHaveBeenCalled();
    expect(h.issueEdited).not.toHaveBeenCalled();
  });
});
