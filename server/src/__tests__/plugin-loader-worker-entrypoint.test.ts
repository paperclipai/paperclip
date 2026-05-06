// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveWorkerEntrypoint,
  resolveWorkerProcessExecArgv,
} from "../services/plugin-loader.js";

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-plugin-loader-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveWorkerEntrypoint", () => {
  it("falls back to src/worker.ts for repo-local plugin installs when dist worker is missing", () => {
    const packageRoot = makeTempDir();
    fs.mkdirSync(path.join(packageRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "src", "worker.ts"), "export const worker = true;\n");

    const entrypoint = resolveWorkerEntrypoint(
      {
        id: "plugin-1",
        pluginKey: "paperclip-file-browser-example",
        packageName: "@paperclipai/plugin-file-browser-example",
        packagePath: packageRoot,
        manifestJson: {
          entrypoints: { worker: "./dist/worker.js" },
        },
      } as never,
      path.join(packageRoot, ".paperclip", "plugins"),
    );

    expect(entrypoint).toBe(path.join(packageRoot, "src", "worker.ts"));
  });

  it("falls back to src/worker.ts for installed packages when dist worker is missing", () => {
    const pluginRoot = makeTempDir();
    const localPluginDir = path.join(pluginRoot, ".paperclip", "plugins");
    const packageDir = path.join(localPluginDir, "node_modules", "@paperclipai", "plugin-orchestration-smoke-example");
    fs.mkdirSync(path.join(packageDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(packageDir, "src", "worker.ts"), "export const worker = true;\n");

    const entrypoint = resolveWorkerEntrypoint(
      {
        id: "plugin-2",
        pluginKey: "paperclipai.plugin-orchestration-smoke-example",
        packageName: "@paperclipai/plugin-orchestration-smoke-example",
        packagePath: null,
        manifestJson: {
          entrypoints: { worker: "./dist/worker.js" },
        },
      } as never,
      localPluginDir,
    );

    expect(entrypoint).toBe(path.join(packageDir, "src", "worker.ts"));
  });
});

describe("resolveWorkerProcessExecArgv", () => {
  it("uses the tsx loader for TypeScript worker entrypoints", () => {
    const execArgv = resolveWorkerProcessExecArgv("/tmp/plugin/src/worker.ts");

    expect(execArgv?.[0]).toBe("--import");
    expect(execArgv?.[1]).toMatch(/loader\.mjs$/);
  });

  it("does not inject the tsx loader for plain JavaScript workers", () => {
    expect(resolveWorkerProcessExecArgv("/tmp/plugin/dist/worker.js")).toBeUndefined();
  });
});
