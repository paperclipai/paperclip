import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectToolInputJsonSchema } from "@paperclipai/shared";
import { callProjectTool, projectToolDefinitions } from "../services/project-tools.js";

const input = {
  name: "list_projects", arguments: {}, apiUrl: "http://paperclip.test", token: "test-token",
  companyId: "company", issueId: "issue", agentId: "agent", conversation: false,
};

afterEach(() => vi.unstubAllGlobals());

describe("project discovery result bounds", () => {
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

describe("project tool definitions", () => {
  it("advertises the create_project input schema that the shared package converted", () => {
    const tool = projectToolDefinitions("standard", true).find(t => t.name === "create_project");
    expect(tool?.inputSchema).toEqual(createProjectToolInputJsonSchema());
    expect((tool?.inputSchema as { required?: string[] }).required).toContain("idempotencyKey");
  });
});

describe("project creation receipt recovery", () => {
  const create = { ...input, name: "create_project", arguments: { name: "Recovered project", idempotencyKey: "project" }, receiptOnly: true };

  it("asks the project owner for a saved result and accepts an absent receipt without parsing an empty response", async () => {
    const fetch = vi.fn(async (_url: string, _options: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    expect(await callProjectTool(create)).toBeUndefined();
    expect(fetch).toHaveBeenCalledWith("http://paperclip.test/api/companies/company/projects", expect.objectContaining({
      method: "POST", headers: expect.objectContaining({ "X-Paperclip-Receipt-Only": "true" }),
      body: expect.any(String),
    }));
    expect(JSON.parse(fetch.mock.calls[0]![1].body as string)).toMatchObject(create.arguments);
  });

  it("returns the saved project and preserves owner validation failures", async () => {
    const project = { id: "saved-project", name: create.arguments.name };
    const fetch = vi.fn().mockResolvedValueOnce(Response.json(project))
      .mockResolvedValueOnce(Response.json({ error: "Project idempotency key was used with different inputs" }, { status: 409 }));
    vi.stubGlobal("fetch", fetch);
    expect(await callProjectTool(create)).toEqual(project);
    await expect(callProjectTool(create)).rejects.toThrow(/different inputs/);
  });

  it("rejects receipt-only requests for other operations before fetching", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(callProjectTool({ ...input, receiptOnly: true })).rejects.toThrow(/receipt/i);
    expect(fetch).not.toHaveBeenCalled();
  });
});
