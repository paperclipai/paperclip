import { afterEach, describe, expect, it, vi } from "vitest";
import { callProjectTool, projectToolDefinitions } from "../services/project-tools.js";

const input = {
  name: "list_projects", arguments: {}, apiUrl: "http://paperclip.test", token: "test-token",
  companyId: "company", issueId: "issue", agentId: "agent", conversation: false,
};

afterEach(() => vi.unstubAllGlobals());

describe("project discovery result bounds", () => {
  it("requests bounded summaries and forwards continuation cursors", async () => {
    const page = { projects: [{ id: "abcdefab-0000-4000-8000-000000000001", name: "Project", status: "in_progress", description: "Summary", descriptionTruncated: true }], nextCursor: "50" };
    const fetch = vi.fn(async (_url: string, _options: RequestInit) => ({ ok: true, json: async () => page }));
    vi.stubGlobal("fetch", fetch);
    expect(await callProjectTool(input)).toEqual(page);
    expect(fetch.mock.calls[0]?.[0]).toBe("http://paperclip.test/api/companies/company/projects?view=summary&limit=50");
    await callProjectTool({ ...input, arguments: { limit: 3, cursor: page.nextCursor } });
    expect(fetch.mock.calls[1]?.[0]).toBe(`http://paperclip.test/api/companies/company/projects?view=summary&limit=3&cursor=${page.nextCursor}`);
    expect(projectToolDefinitions("standard").find(t => t.name === "list_projects")?.inputSchema)
      .toMatchObject({ properties: { cursor: expect.any(Object), limit: expect.any(Object) } });
  });

  it.each([{ limit: 0 }, { limit: 51 }, { cursor: "invalid" }, { cursor: "-1" }, { cursor: "1.5" }, { cursor: "99999999999999999999999" }])("rejects invalid paging arguments %j before fetching", async (arguments_) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(callProjectTool({ ...input, arguments: arguments_ })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
