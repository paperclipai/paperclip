import { describe, it, expect, vi } from "vitest";
import { handleWorkflowRun } from "../../src/handlers/workflow-run.js";
import fixture from "../fixtures/workflow-run-success.json" with { type: "json" };

const config = {
  hmacSecret:"x", ceoAgentId:"agent-ceo", labelGate:"agent-eligible",
  repoToProject:{ "acme/sample-repo":"project-1" }, companyId:"company-1",
};

describe("handleWorkflowRun", () => {
  it("wakes assignee with ci_green when PR linked task exists", async () => {
    const ctx = {
      issues: {
        list:          vi.fn(async () => [{ id: "issue-1" }]),
        createComment: vi.fn(async () => undefined),
        requestWakeup: vi.fn(async () => undefined),
      },
      config,
    };
    await handleWorkflowRun(fixture as any, ctx as any, config);
    expect(ctx.issues.requestWakeup).toHaveBeenCalledOnce();
    const args = (ctx.issues.requestWakeup.mock as any).lastCall;
    expect(args[0]).toBe("issue-1");
    expect(args[1]).toBe("company-1");
    expect(args[2].reason).toBe("ci_green");
    expect(ctx.issues.createComment).toHaveBeenCalledOnce();
    expect((ctx.issues.createComment.mock as any).lastCall[1]).toContain("wake_payload");
  });

  it("noops when no linked PR in payload", async () => {
    const ctx = { issues: { list: vi.fn(), createComment: vi.fn(), requestWakeup: vi.fn() }, config };
    const noPr = { ...(fixture as any), workflow_run: { ...(fixture as any).workflow_run, pull_requests: [] } };
    await handleWorkflowRun(noPr, ctx as any, config);
    expect(ctx.issues.requestWakeup).not.toHaveBeenCalled();
  });

  it("noops when PR-linked task not found", async () => {
    const ctx = { issues: { list: vi.fn(async () => []), createComment: vi.fn(), requestWakeup: vi.fn() }, config };
    await handleWorkflowRun(fixture as any, ctx as any, config);
    expect(ctx.issues.requestWakeup).not.toHaveBeenCalled();
  });
});
