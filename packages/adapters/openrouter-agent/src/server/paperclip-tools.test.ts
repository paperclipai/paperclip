import { describe, expect, it, vi } from "vitest";
import { buildPaperclipTools } from "./paperclip-tools.js";
import { PaperclipApiError } from "./paperclip-api.js";
import type { ToolContext } from "./tools.js";
import type { PaperclipApi } from "./paperclip-api.js";

function mockApi(overrides: Partial<PaperclipApi> = {}): PaperclipApi {
  return {
    getIssue: vi.fn().mockResolvedValue({ id: "issue-1", title: "Test issue" }),
    updateIssue: vi.fn().mockResolvedValue({ id: "issue-1", status: "done" }),
    checkoutIssue: vi.fn().mockResolvedValue({ ok: true }),
    listCompanyIssues: vi.fn().mockResolvedValue([]),
    createIssue: vi.fn().mockResolvedValue({ id: "issue-new" }),
    listIssueComments: vi.fn().mockResolvedValue([]),
    addIssueComment: vi.fn().mockResolvedValue({ id: "comment-1" }),
    listCompanyAgents: vi.fn().mockResolvedValue([]),
    hireAgent: vi.fn().mockResolvedValue({ id: "agent-new" }),
    createApproval: vi.fn().mockResolvedValue({ id: "approval-1" }),
    ...overrides,
  } as unknown as PaperclipApi;
}

function buildCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: "/tmp",
    runCommandTimeoutSec: 30,
    agentId: "agent-1",
    companyId: "co-1",
    currentIssueId: "issue-1",
    autoApprove: false,
    ...overrides,
  };
}

describe("buildPaperclipTools", () => {
  it("returns empty array when ctx.paperclipApi is absent", () => {
    const tools = buildPaperclipTools(buildCtx());
    expect(tools).toHaveLength(0);
  });

  it("returns 9 tools when ctx.paperclipApi is present", () => {
    const tools = buildPaperclipTools(buildCtx({ paperclipApi: mockApi() }));
    expect(tools).toHaveLength(9);
    const names = tools.map((t) => t.name);
    expect(names).toContain("get_issue");
    expect(names).toContain("update_issue_status");
    expect(names).toContain("add_comment");
    expect(names).toContain("list_comments");
    expect(names).toContain("create_sub_issue");
    expect(names).toContain("list_issues");
    expect(names).toContain("list_agents");
    expect(names).toContain("hire_agent");
    expect(names).toContain("request_approval");
  });

  describe("get_issue", () => {
    it("calls getIssue with provided issue_id", async () => {
      const api = mockApi();
      const tools = buildPaperclipTools(buildCtx({ paperclipApi: api }));
      const tool = tools.find((t) => t.name === "get_issue")!;
      await tool.execute({ issue_id: "issue-99" }, buildCtx({ paperclipApi: api }));
      expect(api.getIssue).toHaveBeenCalledWith("issue-99");
    });

    it("defaults issue_id to ctx.currentIssueId when not provided", async () => {
      const api = mockApi();
      const ctx = buildCtx({ paperclipApi: api, currentIssueId: "issue-current" });
      const tools = buildPaperclipTools(ctx);
      const tool = tools.find((t) => t.name === "get_issue")!;
      await tool.execute({}, ctx);
      expect(api.getIssue).toHaveBeenCalledWith("issue-current");
    });
  });

  describe("add_comment", () => {
    it("calls addIssueComment with the correct body", async () => {
      const api = mockApi();
      const ctx = buildCtx({ paperclipApi: api, currentIssueId: "issue-2" });
      const tools = buildPaperclipTools(ctx);
      const tool = tools.find((t) => t.name === "add_comment")!;
      await tool.execute({ body: "great work" }, ctx);
      expect(api.addIssueComment).toHaveBeenCalledWith("issue-2", { body: "great work" });
    });
  });

  describe("create_sub_issue", () => {
    it("sources companyId from context, not args", async () => {
      const api = mockApi();
      const ctx = buildCtx({ paperclipApi: api, companyId: "co-ctx", currentIssueId: "parent-1" });
      const tools = buildPaperclipTools(ctx);
      const tool = tools.find((t) => t.name === "create_sub_issue")!;
      await tool.execute({ title: "Sub task" }, ctx);
      expect(api.createIssue).toHaveBeenCalledWith(
        "co-ctx",
        expect.objectContaining({ title: "Sub task", parentIssueId: "parent-1" }),
      );
    });
  });

  describe("hire_agent", () => {
    it("calls createApproval when autoApprove is false", async () => {
      const api = mockApi();
      const ctx = buildCtx({ paperclipApi: api, autoApprove: false });
      const tools = buildPaperclipTools(ctx);
      const tool = tools.find((t) => t.name === "hire_agent")!;
      await tool.execute({ name: "Coder", role: "developer", adapter_type: "openrouter_agent" }, ctx);
      expect(api.createApproval).toHaveBeenCalled();
      expect(api.hireAgent).not.toHaveBeenCalled();
    });

    it("calls hireAgent directly when autoApprove is true", async () => {
      const api = mockApi();
      const ctx = buildCtx({ paperclipApi: api, autoApprove: true });
      const tools = buildPaperclipTools(ctx);
      const tool = tools.find((t) => t.name === "hire_agent")!;
      await tool.execute({ name: "Coder", role: "developer", adapter_type: "openrouter_agent" }, ctx);
      expect(api.hireAgent).toHaveBeenCalled();
      expect(api.createApproval).not.toHaveBeenCalled();
    });
  });

  describe("API error handling", () => {
    it("returns isError JSON when PaperclipApiError is thrown", async () => {
      const api = mockApi({
        getIssue: vi.fn().mockRejectedValue(
          new PaperclipApiError(404, { message: "not found" }, "GET /api/issues/x"),
        ),
      });
      const ctx = buildCtx({ paperclipApi: api, currentIssueId: "x" });
      const tools = buildPaperclipTools(ctx);
      const tool = tools.find((t) => t.name === "get_issue")!;
      const result = await tool.execute({}, ctx) as Record<string, unknown>;
      expect(result.isError).toBe(true);
      expect(result.status).toBe(404);
      expect(result.message).toBeTruthy();
    });
  });
});
