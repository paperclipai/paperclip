import { afterEach, describe, expect, it, vi } from "vitest";
import { callProjectTool, projectToolDefinitions } from "../services/project-tools.js";

const input = {
  name: "list_projects", arguments: {}, apiUrl: "http://paperclip.test", token: "test-token",
  companyId: "company", issueId: "issue", agentId: "agent", conversation: false,
};

afterEach(() => vi.unstubAllGlobals());

describe("project discovery result bounds", () => {
  it("pages large project records without losing discovery IDs or sending workspace configuration", async () => {
    const projects = Array.from({ length: 53 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      name: `Project ${i}`, status: "in_progress", description: "日本語🦀".repeat(100_000),
      workspaces: [{ executionConfig: { content: "x".repeat(600_000) } }],
    }));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => [...projects].reverse() })));
    const first = await callProjectTool(input);
    expect(first.projects).toHaveLength(50);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(256 * 1024);
    expect(first.projects[0]).toMatchObject({ id: projects[0].id, name: "Project 0", descriptionTruncated: true });
    expect(first.projects[0]).not.toHaveProperty("workspaces");
    expect(first.nextCursor).toBe(projects[49].id);
    const last = await callProjectTool({ ...input, arguments: { cursor: first.nextCursor } });
    expect([...first.projects, ...last.projects].map(p => p.id)).toEqual(projects.map(p => p.id));
    expect(last.nextCursor).toBeNull();
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
