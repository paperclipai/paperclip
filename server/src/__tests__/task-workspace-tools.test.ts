import { afterEach, describe, expect, it, vi } from "vitest";
import { callTaskWorkspaceTool } from "../services/task-workspace-tools.js";

afterEach(() => vi.unstubAllGlobals());
const base = { apiUrl: "https://paperclip.example/api", token: "run-token", companyId: "company", issueId: "task" };
describe("task workspace semantic transport", () => {
  it("discovers task-selectable workspaces instead of legacy isolated reuse candidates", async () => {
    const fetcher = vi.fn(async () => Response.json([{ id: "shared", mode: "shared_workspace" }]));
    vi.stubGlobal("fetch", fetcher);
    await expect(callTaskWorkspaceTool({ ...base, name: "list_workspaces", arguments: {} })).resolves.toEqual([{ id: "shared", mode: "shared_workspace" }]);
    expect(fetcher.mock.calls[0]).toEqual(["https://paperclip.example/api/companies/company/execution-workspaces?summary=true&selectableForTask=true", expect.objectContaining({ method: "GET" })]);
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
    await callTaskWorkspaceTool({ ...base, name: "prepare_repository", arguments: args });
    expect(fetcher.mock.calls[0]).toEqual(["https://paperclip.example/api/issues/task/workspace/repositories", expect.objectContaining({ method: "POST", body: JSON.stringify(args) })]);
    await expect(callTaskWorkspaceTool({ ...base, name: "prepare_repository", arguments: { ...args, cwd: "/home" } })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
