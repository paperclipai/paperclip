import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectWorkspacePackageState,
  workspacePackageStateCheck,
} from "../checks/workspace-package-state-check.js";

const cleanupDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

function writePackageJson(root: string, dependencies: Record<string, string> = {}) {
  fs.writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "paperclip", private: true, packageManager: "pnpm@9.15.4", dependencies }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
}

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("workspace package state diagnostics", () => {
  it("reports an escaped pnpm virtual store with the non-interactive repair command", () => {
    const root = makeTempDir("paperclip-package-state-");
    writePackageJson(root);
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.writeFileSync(
      path.join(root, "node_modules", ".modules.yaml"),
      `virtualStoreDir: ${path.join(root, "..", "other-worktree", "node_modules", ".pnpm")}\n`,
    );

    expect(workspacePackageStateCheck(root)).toEqual(expect.objectContaining({
      status: "fail",
      message: expect.stringContaining("virtualStoreDir resolves outside the workspace"),
      repairHint: expect.stringContaining("NODE_ENV=development pnpm install --prefer-offline --config.confirmModulesPurge=false"),
    }));
  });

  it("reports dangling direct dependency symlinks", () => {
    const root = makeTempDir("paperclip-package-state-");
    writePackageJson(root, { "broken-package": "1.0.0" });
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.symlinkSync(path.join(root, "missing-store-entry"), path.join(root, "node_modules", "broken-package"));

    expect(inspectWorkspacePackageState(root)).toEqual([
      expect.objectContaining({ kind: "dangling_dependency_link" }),
    ]);
  });

  it("allows a contained virtual store and resolvable dependency link", () => {
    const root = makeTempDir("paperclip-package-state-");
    writePackageJson(root, { "healthy-package": "1.0.0" });
    const target = path.join(root, "node_modules", ".pnpm", "healthy-package");
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules", ".modules.yaml"), "virtualStoreDir: .pnpm\n");
    fs.symlinkSync(target, path.join(root, "node_modules", "healthy-package"), "dir");

    expect(workspacePackageStateCheck(root).status).toBe("pass");
  });
});
