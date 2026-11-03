import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decidePluginWorkspaceHostExecution, pluginWorkspaceHostRef } from "./plugin-host-local-execution.js";
import type { WorkspaceProviderBinding } from "@paperclipai/shared";

const tempRoots: string[] = [];

afterAll(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function hostTree(): Promise<string> {
  const root = path.join(await mkdtemp(path.join(os.tmpdir(), "plugin-host-exec-")), "wt-tree"); tempRoots.push(root);
  await mkdir(root, { recursive: true });
  return path.resolve(root);
}

function bindingWith(workspaceRef: string): WorkspaceProviderBinding {
  return {
    pluginId: randomUUID(),
    projectId: randomUUID(),
    executionWorkspaceId: randomUUID(),
    projectWorkspaceId: randomUUID(),
    sourceRevision: "rev-1",
    workspaceRef,
  };
}

describe("pluginWorkspaceHostRef", () => {
  it("resolves an existing directory path", async () => {
    const tree = await hostTree();
    expect(pluginWorkspaceHostRef(tree)).toBe(tree);
  });

  it("rejects a missing path", () => {
    expect(pluginWorkspaceHostRef("/nonexistent/host/tree/plugin-host-local-execution")).toBeNull();
  });

  it("rejects a file path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "plugin-host-exec-")); tempRoots.push(root);
    const file = path.join(root, "file.txt");
    await writeFile(file, "data");
    expect(pluginWorkspaceHostRef(file)).toBeNull();
  });

  it("rejects an opaque provider ref", () => {
    expect(pluginWorkspaceHostRef("provider:heartbeat-workspace")).toBeNull();
  });

  it("rejects a relative path", () => {
    expect(pluginWorkspaceHostRef("relative/tree")).toBeNull();
  });
});

describe("decidePluginWorkspaceHostExecution", () => {
  it("executes in place on the local driver when the tree exists", async () => {
    const tree = await hostTree();
    expect(decidePluginWorkspaceHostExecution(bindingWith(tree), "local")).toEqual({
      kind: "host", workspaceRef: tree,
    });
  });

  it("keeps the plugin bridge for non-local drivers even with an existing tree", async () => {
    const tree = await hostTree();
    expect(decidePluginWorkspaceHostExecution(bindingWith(tree), "plugin")).toEqual({ kind: "plugin" });
    expect(decidePluginWorkspaceHostExecution(bindingWith(tree), "ssh")).toEqual({ kind: "plugin" });
    expect(decidePluginWorkspaceHostExecution(bindingWith(tree), "sandbox")).toEqual({ kind: "plugin" });
    expect(decidePluginWorkspaceHostExecution(bindingWith(tree), null)).toEqual({ kind: "plugin" });
  });

  it("blocks the local driver when the tree is missing", () => {
    expect(decidePluginWorkspaceHostExecution(
      bindingWith("/nonexistent/host/tree/plugin-host-local-execution"), "local",
    )).toEqual({ kind: "blocked", reason: "workspace_ref_missing" });
  });

  it("blocks the local driver for an opaque provider ref", () => {
    expect(decidePluginWorkspaceHostExecution(
      bindingWith("provider:heartbeat-workspace"), "local",
    )).toEqual({ kind: "blocked", reason: "workspace_ref_not_host_path" });
  });
});
