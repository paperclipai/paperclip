import { afterEach, describe, expect, it, vi } from "vitest";
import { apiResultMayHaveWorkspace, callTaskWorkspaceTool, withWorkspacePageHref } from "../services/task-workspace-tools.js";

afterEach(() => vi.unstubAllGlobals());
const base = { apiUrl: "https://paperclip.example/api", token: "run-token", companyId: "company", issueId: "task" };
describe("task workspace semantic transport", () => {
  it("requests a bounded workspace page instead of returning the entire inventory", async () => {
    const inventory = Array.from({ length: 8_000 }, (_, i) => ({ id: `workspace-${i}`, name: `Workspace ${i}`, cwd: `/tmp/${"repository/".repeat(20)}${i}` }));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const requestedLimit = new URL(url).searchParams.get("limit");
      return Response.json(requestedLimit ? inventory.slice(0, Number(requestedLimit)) : inventory);
    }));
    const page = await callTaskWorkspaceTool({ ...base, name: "list_workspaces", arguments: {} });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(128 * 1024);
    expect(page).toMatchObject({ workspaces: inventory.slice(0, 50), returnedCount: 50, limit: 50,
      hasMore: true, nextCursor: "workspace-49" });
  });
  it("discovers task-selectable workspaces instead of legacy isolated reuse candidates", async () => {
    const fetcher = vi.fn(async () => Response.json([{ id: "shared", mode: "shared_workspace" }]));
    vi.stubGlobal("fetch", fetcher);
    await expect(callTaskWorkspaceTool({ ...base, name: "list_workspaces", arguments: {} })).resolves.toEqual({
      workspaces: [{ id: "shared", mode: "shared_workspace" }], limit: 50, returnedCount: 1, hasMore: false, nextCursor: null,
    });
    expect(fetcher.mock.calls[0]).toEqual(["https://paperclip.example/api/companies/company/execution-workspaces?summary=true&selectableForTask=true&limit=51", expect.objectContaining({ method: "GET" })]);
  });
  it("fits large summary fields in a byte-bounded page with a usable cursor", async () => {
    const rows = Array.from({ length: 51 }, (_, i) => ({ id: `workspace-${i}`, name: "🦀\\\"".repeat(4_000) }));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(rows)));
    const page = await callTaskWorkspaceTool({ ...base, name: "list_workspaces", arguments: {} });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(128 * 1024);
    expect(page.workspaces.length).toBeGreaterThan(0);
    expect(page.workspaces.length).toBeLessThan(50);
    expect(page.nextCursor).toBe(page.workspaces.at(-1).id);
    expect(page.hasMore).toBe(true);
    expect(page.workspaces.every((row: unknown, i: number) => JSON.stringify(row) === JSON.stringify(rows[i]))).toBe(true);
  });
  it("returns an explicit preview and advances past an individually oversized summary", async () => {
    const row = { id: "workspace-one", name: "🦀\\\"".repeat(100_000), cwd: "/tmp/source" };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([row, { id: "workspace-two", name: "Next" }])));
    const page = await callTaskWorkspaceTool({ ...base, name: "list_workspaces", arguments: {} });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(128 * 1024);
    expect(page).toMatchObject({ returnedCount: 1, hasMore: true, nextCursor: row.id,
      workspaces: [{ id: row.id, cwd: row.cwd, truncatedFields: ["name"] }] });
  });
  it("uses the normal bound task routes without passing caller identities or interrupt requests", async () => {
    const fetcher = vi.fn(async () => Response.json({ kind: "scheduled", applies: "next_normal_admission" }));
    vi.stubGlobal("fetch", fetcher);
    await expect(callTaskWorkspaceTool({ ...base, name: "select_workspace", arguments: { selection: { kind: "task_directory" }, expectedBindingRevision: 3, requestKey: "move-1" } })).resolves.toMatchObject({ applies: "next_normal_admission" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]).toEqual(["https://paperclip.example/api/issues/task/workspace", expect.objectContaining({ method: "PUT", body: JSON.stringify({ selection: { kind: "task_directory" }, expectedBindingRevision: 3, requestKey: "move-1" }) })]);
  });
  it("prepares a repository without creating a project or choosing a host path", async () => {
    const fetcher = vi.fn(async () => Response.json({ kind: "requires_next_admission" }));
    vi.stubGlobal("fetch", fetcher);
    const args = { repository: { kind: "catalog", id: "repo" }, requestKey: "acquire-1" };
    const result = await callTaskWorkspaceTool({ ...base, name: "prepare_repository", arguments: args });
    expect(result.instruction).toContain('paperclip_finish with reportedWorkDisposition="yielded"');
    expect(result.instruction).toContain("do not call paperclip_block");
    expect(fetcher.mock.calls[0]).toEqual(["https://paperclip.example/api/issues/task/workspace/repositories", expect.objectContaining({ method: "POST", body: JSON.stringify(args) })]);
    await expect(callTaskWorkspaceTool({ ...base, name: "prepare_repository", arguments: { ...args, cwd: "/home" } })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("workspace page hrefs on agent API reads", () => {
  // The chat agent read another task with get_task (GET /api/issues/{id}); its
  // currentExecutionWorkspace had no href, so the agent told the person the
  // workspace had no page even though the page was enabled.
  const workspace = { id: "ws-1", companyId: "company", name: "COM-1", mode: "shared_workspace", cwd: "/srv/ws" };
  const taskRead = { operationId: "GET /api/issues/{id}", ok: true, status: 200,
    data: { id: "task-1", identifier: "COM-1", companyId: "company", currentExecutionWorkspace: workspace } };
  it("links the task's bound workspace page when workspace pages are on", () => {
    expect(apiResultMayHaveWorkspace(taskRead)).toBe(true);
    expect(withWorkspacePageHref(taskRead, "COM", "company")).toEqual({ ...taskRead,
      data: { ...taskRead.data, currentExecutionWorkspace: { ...workspace, href: "/COM/execution-workspaces/ws-1" } } });
  });
  it("links the workspace from the task workspace and workspace detail reads", () => {
    expect(withWorkspacePageHref({ operationId: "GET /api/issues/{id}/workspace", ok: true, data: { issueId: "task-1", workspace } }, "COM", "company"))
      .toMatchObject({ data: { workspace: { id: "ws-1", href: "/COM/execution-workspaces/ws-1" } } });
    expect(withWorkspacePageHref({ operationId: "GET /api/execution-workspaces/{id}", ok: true, data: workspace }, "COM", "company"))
      .toMatchObject({ data: { id: "ws-1", href: "/COM/execution-workspaces/ws-1" } });
  });
  it("adds no href when the page is off, the read failed, or the workspace is not this company's", () => {
    expect(withWorkspacePageHref(taskRead, null, "company")).toBe(taskRead);
    expect(withWorkspacePageHref({ ...taskRead, ok: false }, "COM", "company")).toEqual({ ...taskRead, ok: false });
    expect(withWorkspacePageHref(taskRead, "COM", "other-company")).toBe(taskRead);
    const unbound = { ...taskRead, data: { ...taskRead.data, currentExecutionWorkspace: null } };
    expect(withWorkspacePageHref(unbound, "COM", "company")).toBe(unbound);
  });
  it("leaves unrelated reads untouched and skips the page setting for them", () => {
    const other = { operationId: "GET /api/issues/{id}/runs", ok: true, data: [{ id: "ws-1", companyId: "company" }] };
    expect(apiResultMayHaveWorkspace(other)).toBe(false);
    expect(withWorkspacePageHref(other, "COM", "company")).toBe(other);
  });
});
