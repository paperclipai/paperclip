import { afterEach, describe, expect, it, vi } from "vitest";
import { callProjectTool, projectToolDefinitions } from "../services/project-tools.js";
import { formatProjectToolResult } from "../routes/project-tools.js";

const input = {
  name: "list_projects", arguments: {}, apiUrl: "http://paperclip.test", token: "test-token",
  companyId: "company", issueId: "issue", agentId: "agent", conversation: false,
};

afterEach(() => vi.unstubAllGlobals());

describe("project discovery result bounds", () => {
  it("keeps list-valued task results valid for MCP clients", () => {
    const agents = [{ id: "engineering-lead" }];
    expect(formatProjectToolResult(agents)).toEqual({
      content: [{ type: "text", text: JSON.stringify(agents) }],
    });
    expect(formatProjectToolResult({ id: "issue" })).toEqual({
      content: [{ type: "text", text: JSON.stringify({ id: "issue" }) }],
      structuredContent: { id: "issue" },
    });
  });
  it("advertises the common issue tools on every standard run without exposing the generic API tool", () => {
    const names = projectToolDefinitions("standard", true).map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      "paperclipListAgents", "paperclipListIssues", "paperclipGetIssue", "paperclipListComments",
      "paperclipCreateIssue", "paperclipUpdateIssue", "paperclipAddComment",
      "paperclipDelegateChildIssue",
    ]));
    expect(names).not.toContain("paperclipApiRequest");
    expect(names).not.toContain("paperclipListSecrets");
    const askNames = projectToolDefinitions("ask", true).map((tool) => tool.name);
    expect(askNames).toContain("paperclipGetIssue");
    expect(askNames).not.toContain("paperclipUpdateIssue");
  });
  it("uses the authenticated run token and Paperclip API for cross-task reads and issue updates", async () => {
    const fetch = vi.fn(async (_url: URL | string, _options: RequestInit) => ({
      ok: true, text: async () => JSON.stringify({ id: "child", status: "blocked" }),
    }));
    vi.stubGlobal("fetch", fetch);
    const read = await callProjectTool({ ...input, name: "paperclipGetIssue", arguments: { issueId: "child" } });
    expect(read).toMatchObject({ id: "child" });
    expect(String(fetch.mock.calls[0]?.[0])).toBe("http://paperclip.test/api/issues/child");
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "GET", headers: expect.objectContaining({ Authorization: "Bearer test-token" }) });
    expect(fetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    await callProjectTool({ ...input, name: "paperclipUpdateIssue", arguments: { issueId: "child", status: "blocked" } });
    expect(String(fetch.mock.calls[1]?.[0])).toBe("http://paperclip.test/api/issues/child");
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: "PATCH", body: JSON.stringify({ status: "blocked" }) });
    const parentId = "00000000-0000-4000-8000-000000000001";
    const assigneeAgentId = "00000000-0000-4000-8000-000000000002";
    await callProjectTool({ ...input, name: "paperclipCreateIssue", arguments: {
      title: "Investigate the reported bug", parentId, assigneeAgentId,
    } });
    expect(String(fetch.mock.calls[2]?.[0])).toBe("http://paperclip.test/api/companies/company/issues");
    expect(fetch.mock.calls[2]?.[1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(fetch.mock.calls[2]?.[1]?.body))).toMatchObject({
      title: "Investigate the reported bug", parentId, assigneeAgentId,
    });
    await callProjectTool({ ...input, name: "paperclipDelegateChildIssue", arguments: {
      parentIssueId: parentId,
      title: "Investigate the reported bug",
      assigneeAgentId,
      idempotencyKey: "one-investigation",
    } });
    expect(String(fetch.mock.calls[3]?.[0])).toBe(`http://paperclip.test/api/issues/${parentId}/children`);
    expect(JSON.parse(String(fetch.mock.calls[3]?.[1]?.body))).toMatchObject({
      title: "Investigate the reported bug", assigneeAgentId,
      idempotencyKey: "one-investigation", delegateAndBlockParent: true,
    });
  });
  it("requests bounded summaries and normalizes continuation cursors", async () => {
    const page = { projects: [{ id: "abcdefab-0000-4000-8000-000000000001", name: "Project", status: "in_progress", description: "Summary", descriptionTruncated: true }], nextCursor: "abcdefab-0000-4000-8000-000000000001" };
    const fetch = vi.fn(async (_url: string, _options: RequestInit) => ({ ok: true, json: async () => page }));
    vi.stubGlobal("fetch", fetch);
    expect(await callProjectTool(input)).toEqual(page);
    expect(fetch.mock.calls[0]?.[0]).toBe("http://paperclip.test/api/companies/company/projects?view=summary&limit=50");
    await callProjectTool({ ...input, arguments: { limit: 3, cursor: page.nextCursor.toUpperCase() } });
    expect(fetch.mock.calls[1]?.[0]).toBe(`http://paperclip.test/api/companies/company/projects?view=summary&limit=3&cursor=${page.nextCursor}`);
    expect(projectToolDefinitions("standard").find(t => t.name === "list_projects")?.inputSchema)
      .toMatchObject({ properties: { cursor: expect.any(Object), limit: expect.any(Object) } });
  });

  it.each([{ limit: 0 }, { limit: 51 }, { cursor: "invalid" }])("rejects invalid paging arguments %j before fetching", async (arguments_) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(callProjectTool({ ...input, arguments: arguments_ })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
