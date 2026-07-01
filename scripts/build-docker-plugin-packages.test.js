import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { findPluginPackageRoots } from "./build-docker-plugin-packages.mjs";

test("findPluginPackageRoots discovers production plugins and excludes examples", () => {
  const root = mkdtempSync(join(tmpdir(), "paperclip-plugins-"));

  try {
    writePackage(root, "plugin-workspace-diff");
    writePackage(root, "examples/plugin-hello-world-example");
    writePackage(root, "sandbox-providers/daytona");

    const roots = findPluginPackageRoots(root).map((path) => path.slice(root.length + 1));

    assert.deepEqual(roots.sort(), [
      "plugin-workspace-diff",
      "sandbox-providers/daytona",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function writePackage(root, relativePath) {
  const packageRoot = join(root, relativePath);
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), "{}\n");
}
