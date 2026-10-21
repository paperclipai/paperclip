import { describe, expect, it } from "vitest";
import {
  workspaceProviderOperationSchema,
  parseWorkspaceProviderResult,
  type PluginWorkspaceParams,
} from "../src/workspace-provider.js";
import { createWorkspaceProviderHarness } from "../src/testing.js";
import { pluginManifestV1Schema } from "@paperclipai/shared";
const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const params: PluginWorkspaceParams = {
  pluginId: id(1),
  companyId: id(2),
  projectId: id(3),
  executionWorkspaceId: id(4),
  operationId: "stable",
  generation: 0,
  deadline: "2099-01-01T00:00:00Z",
  runId: null,
  agentId: null,
  operation: {
    kind: "prepare",
    source: {
      id: id(5),
      revision: "source-v1",
      repoUrl: "https://github.com/example/repo.git",
      repoRef: null,
      defaultRef: "main",
    },
    mode: "isolated_workspace",
    strategy: "git_worktree",
    branchName: "task",
    baseRef: "main",
    existing: null,
  },
};
const result = {
  kind: "prepared" as const,
  binding: {
    pluginId: id(1),
    projectId: id(3),
    executionWorkspaceId: id(4),
    projectWorkspaceId: id(5),
    sourceRevision: "source-v1",
    workspaceRef: "opaque",
  },
  branchName: "task",
  baseSha: "a".repeat(40),
  created: true,
  branchCreatedByRuntime: true,
};
describe("workspace provider SDK", () => {
  it("prepares without a VM, lease, or host path", async () => {
    const harness = createWorkspaceProviderHarness(async (input) => {
      expect(input.agentId).toBeNull();
      expect(input).not.toHaveProperty("lease");
      expect(input.operation).not.toHaveProperty("localPath");
      return result;
    });
    expect(await harness.operation(params)).toEqual(result);
  });
  it("rejects unrelated operation results and changed source revisions", () => {
    expect(() =>
      parseWorkspaceProviderResult(params, { kind: "removed" }),
    ).toThrow();
    expect(() =>
      parseWorkspaceProviderResult(params, {
        ...result,
        binding: { ...result.binding, sourceRevision: "other" },
      }),
    ).toThrow();
    expect(() =>
      parseWorkspaceProviderResult(params, {
        ...result,
        binding: { ...result.binding, executionWorkspaceId: id(99) },
      }),
    ).toThrow();
    expect(() =>
      parseWorkspaceProviderResult(params, { ...result, branchName: "wrong" }),
    ).toThrow();
    expect(() =>
      workspaceProviderOperationSchema.parse({
        ...params.operation,
        shell: "arbitrary",
      }),
    ).toThrow();
  });
  it("requires project lifecycle and storage management as one contract", () => {
    const manifest = {
      id: "test.storage",
      apiVersion: 1,
      version: "1.0.0",
      displayName: "Storage",
      description: "Storage",
      author: "Test",
      categories: ["workspace"],
      entrypoints: { worker: "./worker.js" },
      workspaceProvider: {
        modes: ["isolated_workspace", "operator_branch"],
        strategies: ["git_worktree"],
      },
      capabilities: ["workspaces.manage", "events.subscribe"],
      resourceLifecycle: ["project"],
    };
    expect(pluginManifestV1Schema.safeParse(manifest).success).toBe(true);
    expect(
      pluginManifestV1Schema.safeParse({
        ...manifest,
        resourceLifecycle: ["agent"],
      }).success,
    ).toBe(false);
    expect(
      pluginManifestV1Schema.safeParse({
        ...manifest,
        capabilities: ["events.subscribe"],
      }).success,
    ).toBe(false);
  });
});
