import { describe, it, expect, vi } from "vitest";
import { inspectPluginWorkspaceForFinalization } from "./native-plugin-workspace-finalization.js";
import { finalizePluginWorkspace } from "../plugin-workspaces.js";
vi.mock("../plugin-workspaces.js", () => ({ finalizePluginWorkspace: vi.fn() }));
const db = {} as Parameters<typeof inspectPluginWorkspaceForFinalization>[0];
const workspace = { id: "workspace", providerType: "plugin", strategyType: "git_worktree", branchName: "task" } as Parameters<typeof inspectPluginWorkspaceForFinalization>[2];
describe("provider run completion", () => {
  it("passes original run ownership and accepts retained unpublished work", async () => {
    vi.mocked(finalizePluginWorkspace).mockResolvedValue({kind:"finalized",headSha:"a".repeat(40),branchName:"task"});
    expect(await inspectPluginWorkspaceForFinalization(db,undefined,workspace,"agent","run"))
      .toMatchObject({providerType:"plugin",inspection:{kind:"finalized"}});
    expect(finalizePluginWorkspace).toHaveBeenLastCalledWith(db,undefined,workspace,{agentId:"agent",runId:"run"});
  });
  it("fails closed on changed branch and durability failure", async () => {
    vi.mocked(finalizePluginWorkspace).mockResolvedValue({kind:"finalized",headSha:"a".repeat(40),branchName:"wrong"});
    await expect(inspectPluginWorkspaceForFinalization(db,undefined,workspace,"agent","run")).rejects.toThrow("branch_mismatch");
    vi.mocked(finalizePluginWorkspace).mockRejectedValue(new Error("sync incomplete"));
    await expect(inspectPluginWorkspaceForFinalization(db,undefined,workspace,"agent","run")).rejects.toThrow("sync incomplete");
  });
});
